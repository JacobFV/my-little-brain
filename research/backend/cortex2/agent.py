"""The AI quantum engineer (design loop) and the long-running research operator.

Design iteration (one Revision):
    inspect state → build/compile circuits with tools (structured QAOA spec or the model's own
    OpenQASM) → run on a simulator/sampler → look at the rendered comparison (vision) →
    record observation, diagnosis, change, rationale. The verdict is computed here from the
    measured metrics of the jobs it ran; the model cannot mark its own work as an improvement.

Operator: keeps a rolling memory across ticks, sees every job of the user, and can dispatch,
cancel, retry or poll work and start design iterations within the session's budgets.
Physical QPU submissions by the agent require the user to enable `allow_autonomous_qpu`.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np

from . import inverse as inv, llm, neural as nm, quantum as qm, runner
from .store import artifacts, now, store

log = logging.getLogger("cortex2.agent")

REASONING = os.environ.get("AGENT_REASONING_EFFORT", "")
MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "18"))
# Blind by default: the agent searches with the information a real experimenter would have.
ORACLE = os.environ.get("AGENT_ORACLE") == "1"
from . import backends  # noqa: E402
# classical_exact simulates all 256 hypotheses: it is the evaluator's reference, not a search move.
SYNC_PROVIDERS = set(backends.ids(mode="sync")) - {"classical_exact"}
DEFAULT_SESSION = {"autopilot": False, "max_autonomous_jobs": 12, "autonomous_jobs_total": 0,
                   "allow_autonomous_qpu": False, "qpu_jobs_budget": 2, "qpu_jobs_total": 0,
                   "operator_memory": "", "last_tick": None}


def agent_configured() -> bool:
    return bool(llm.router().configured())


def model_name() -> str | None:
    return llm.router().primary()


def session(uid: str) -> dict:
    s = store().get("sessions", uid)
    if s is None:
        s = {**DEFAULT_SESSION, "owner": uid, "created_at": now()}
        store().set("sessions", uid, s)
    return {**DEFAULT_SESSION, **s}


def update_session(uid: str, patch: dict) -> dict:
    allowed = {"autopilot": bool, "max_autonomous_jobs": int, "allow_autonomous_qpu": bool, "qpu_jobs_budget": int}
    clean = {k: allowed[k](v) for k, v in patch.items() if k in allowed}
    if "max_autonomous_jobs" in clean:
        clean["max_autonomous_jobs"] = max(0, min(clean["max_autonomous_jobs"], 200))
    if "qpu_jobs_budget" in clean:
        clean["qpu_jobs_budget"] = max(0, min(clean["qpu_jobs_budget"], 20))
    session(uid)
    store().update("sessions", uid, {**clean, "updated_at": now()})
    if clean.get("autopilot"):
        schedule_operator(uid, "autopilot enabled: review the research state and plan next steps")
    return session(uid)


def reserve_budget(uid: str, qpu: bool = False) -> bool:
    """Transactionally consume one autonomous job (and QPU job) from the session budget."""
    def fn(cur):
        s = {**DEFAULT_SESSION, **(cur or {})}
        if s["autonomous_jobs_total"] >= s["max_autonomous_jobs"]:
            return None
        patch = {"autonomous_jobs_total": s["autonomous_jobs_total"] + 1}
        if qpu:
            if not s["allow_autonomous_qpu"] or s["qpu_jobs_total"] >= s["qpu_jobs_budget"]:
                return None
            patch["qpu_jobs_total"] = s["qpu_jobs_total"] + 1
        return patch
    return store().transact("sessions", uid, fn) is not None


# ---------------------------------------------------------------- shared compact views

def compact_job(j: dict, oracle: bool | None = None) -> dict:
    """Job summary for the model. Blind by default: only search-side information (states that were actually
    forward-simulated and their losses). Evaluator metrics computed from all 256 hypotheses — global minimum,
    approximation ratio, P(consistent), hidden-truth recovery, oracle QUBO fidelity — are shown only with
    AGENT_ORACLE=1 (they stay in the stored records and drive the computed verdicts)."""
    oracle = ORACLE if oracle is None else oracle
    ev = j.get("evaluation") or {}
    tr = j.get("transpiled") or {}
    out = {"id": j["id"], "experiment_id": j.get("experiment_id"), "kind": j.get("kind"), "provider": j.get("provider"),
           "status": j.get("status"), "created_by": j.get("created_by"), "created_at": j.get("created_at"),
           "approximation": j.get("approximation"), "baseline": j.get("baseline"), "trust_weight": j.get("trust_weight"),
           "spec": {k: v for k, v in (j.get("spec") or {}).items() if k not in ("gammas", "betas")} or None,
           "shots": j.get("shots"), "qasm_source": j.get("qasm_source"), "error": (j.get("error") or "")[:300] or None}
    if ev:
        out["search"] = {"best_validated_loss": ev.get("best_nonlinear_loss"), "best_validated": ev["best"]["bitstring"],
                         "new_validations": ev.get("new_validations"), "distinct_states_sampled": ev.get("distinct_states"),
                         "validated": [{"bitstring": c["bitstring"], "samples": c["samples"], "loss": round(c["nonlinear_loss"], 4)}
                                       for c in ev.get("validated", [])]}
        if oracle:
            out["oracle_metrics"] = {k: ev.get(k) for k in ("min_possible_loss", "expected_nonlinear_loss", "approximation_ratio",
                                                            "p_consistent", "uniform_p_consistent", "p_top8")}
            if ev.get("truth"):
                out["truth"] = {k: ev["truth"][k] for k in ("recovered_exactly", "p_truth", "best_hamming_distance", "parameter_level_error")}
    if tr:
        out["physical"] = {k: tr.get(k) for k in ("gates", "two_qubit_gates", "two_qubit_depth", "backend", "within_budget")}
    if j.get("circuit"):
        out["logical"] = {k: j["circuit"].get(k) for k in ("gates", "two_qubit_gates", "depth")}
    if j.get("ideal_tvd") is not None:
        out["tvd_vs_ideal"] = j["ideal_tvd"]
    if oracle and j.get("qubo_quality"):
        out["qubo_quality_oracle"] = j["qubo_quality"]
    if j.get("duplicate_of"):
        out["duplicate_of"] = j["duplicate_of"]
    if j.get("provider_job_id"):
        out["provider_job_id"], out["backend"], out["provider_status"] = j["provider_job_id"], j.get("backend"), j.get("provider_status")
    return out


def observed_history(exp: dict) -> dict[str, float]:
    """Every hypothesis forward-simulated in this experiment, in validation order → nonlinear loss."""
    jobs = sorted(store().query("jobs", exp["owner"], experiment_id=exp["id"], limit=500), key=lambda j: j.get("created_at") or "")
    seen: dict[str, float] = {}
    for j in jobs:
        for c in (j.get("evaluation") or {}).get("validated", []):
            seen.setdefault(c["bitstring"], c["nonlinear_loss"])
    return seen


def economics(exp: dict, observed: dict[str, float] | None = None) -> dict:
    observed = observed_history(exp) if observed is None else observed
    best = min(observed, key=observed.get) if observed else None
    return {"forward_simulations_used": len(observed), "hypotheses_unsimulated": nm.N_STATES - len(observed),
            "exhaustive_search_cost": nm.N_STATES, "validation_budget_per_run": inv.DEFAULT_VALIDATION_BUDGET,
            "best_validated": best, "best_validated_loss": observed.get(best) if best else None,
            "note": "each run spends up to K forward simulations on its most-sampled not-yet-simulated states; "
                    "a run whose samples are all already simulated learns nothing new"}


def search_fidelity(q: inv.Qubo, observed: dict[str, float]) -> dict:
    """How well the QUBO ranks the hypotheses simulated so far (no oracle information)."""
    e = q.energies()
    argmin = nm.bits_to_bitstring(nm.all_bits()[int(np.argmin(e))])
    out: dict[str, Any] = {"qubo_argmin": argmin, "qubo_argmin_already_simulated": argmin in observed,
                           "qubo_argmin_loss_if_simulated": observed.get(argmin), "points": len(observed)}
    if len(observed) >= 5:
        states = list(observed)
        qe = np.array([e[nm.grid_index(nm.bitstring_to_bits(s))] for s in states])
        lo = np.array([observed[s] for s in states])
        rq, rl = np.argsort(np.argsort(qe)), np.argsort(np.argsort(lo))
        out["spearman_vs_simulated"] = float(np.corrcoef(rq, rl)[0, 1]) if len(states) > 2 else None
        best = min(observed, key=observed.get)
        out["qubo_rank_of_best_simulated"] = int((e < e[nm.grid_index(nm.bitstring_to_bits(best))]).sum()) + 1
    return out


def experiment_state(exp: dict, oracle: bool | None = None) -> dict:
    oracle = ORACLE if oracle is None else oracle
    jobs = store().query("jobs", exp["owner"], experiment_id=exp["id"], limit=40)
    revs = sorted(store().query("revisions", exp["owner"], experiment_id=exp["id"], limit=20), key=lambda r: r.get("number", 0))
    t = exp["target"]
    observed = observed_history(exp)
    problem = {"n_qubits": nm.N_BITS, "encoding": "2 bits per parameter, little endian (level = b0 + 2*b1); qubit 2j,2j+1 → parameter j",
               "param_names": list(nm.PARAM_NAMES), "param_levels": nm.LEVELS.tolist(),
               "feature_names": list(nm.FEATURE_NAMES), "observed_features": t["features"],
               "feature_weights": t["weights"],
               "gate_budget_physical": qm.GATE_BUDGET, "offline_transpile_target": qm.OFFLINE_TARGET,
               "approximations": list(inv.APPROXIMATIONS), "information": "blind" if not oracle else "oracle"}
    if oracle:
        target = runner.target_of(exp)
        losses = inv.nonlinear_losses(target)
        problem["oracle_loss_stats"] = {"min": float(losses.min()), "median": float(sorted(losses)[128]),
                                        "consistency_threshold": inv.consistency_threshold(target, losses)}
    best = exp.get("best") or {}
    return {
        "experiment": {"id": exp["id"], "title": exp["title"], "source": t["source"], "label": t["label"],
                       "best_validated": {k: best.get(k) for k in ("bitstring", "nonlinear_loss", "parameters", "job_id")} if best else None,
                       "baseline": exp.get("baseline"), "rounds": exp.get("rounds")},
        "problem": problem,
        "economics": economics(exp, observed),
        "simulated_hypotheses": [{"bitstring": s, "loss": round(v, 4)} for s, v in sorted(observed.items(), key=lambda kv: kv[1])[:40]],
        "jobs": [compact_job(j, oracle) for j in jobs if j.get("kind") == "sample"],
        "revisions": [{k: r.get(k) for k in ("number", "diagnosis", "change", "verdict", "metric_before", "metric_after",
                                              "comparison_basis", "new_best", "next_step")} for r in revs],
    }


# ---------------------------------------------------------------- design-iteration tools

SPEC_SCHEMA = {
    "type": "object", "description": "Structured QAOA design. Omit gammas/betas to have them optimised on a statevector.",
    "properties": {
        "reps": {"type": "integer", "minimum": 1, "maximum": 4},
        "gammas": {"type": ["array", "null"], "items": {"type": "number"}},
        "betas": {"type": ["array", "null"], "items": {"type": "number"}},
        "prune_threshold": {"type": "number", "description": "drop couplings |J|<t*max|coef| (0..1)"},
        "max_couplings": {"type": ["integer", "null"], "description": "keep only the strongest k ZZ couplings"},
        "warm_start": {"type": ["string", "null"], "description": "8-char bitstring to bias the initial state (warm-start QAOA)"},
        "warm_epsilon": {"type": "number"},
        "coupling_order": {"type": "string", "enum": ["strength", "greedy_coloring"]},
        "optimization_level": {"type": "integer", "minimum": 0, "maximum": 3},
        "beta": {"type": "number", "description": "THRML inverse temperature (thrml provider only)"},
        "ionq_noise": {"type": "string", "enum": ["ideal", "aria-1", "forte-1"], "description": "IonQ simulator noise model (ionq_simulator only)"},
    },
}
PROBLEM_PROPS = {
    "approximation": {"type": "string", "enum": list(inv.APPROXIMATIONS)},
    "baseline": {"type": ["string", "null"], "description": "8-char bitstring linearisation point; default = experiment best"},
    "trust_weight": {"type": "number", "description": "Hamming penalty weight for trust_region (0..2)"},
}
CIRCUIT_PROPS = {**PROBLEM_PROPS, "spec": SPEC_SCHEMA,
                 "qasm": {"type": ["string", "null"], "description": "Your own OpenQASM 2.0 circuit on 8 qubits (qelib1.inc incl. rzz). Overrides spec."}}


def _fn(name, description, props, required=()):
    return llm.Tool(name, description, {"type": "object", "properties": props, "required": list(required)})


DESIGN_TOOLS = [
    _fn("inspect_state", "Experiment, observed features, every hypothesis simulated so far with its loss, forward-simulation "
        "economics, prior jobs (search-side metrics), previous revisions with their next_step, and budgets.", {}),
    _fn("build_problem", "Construct a QUBO/Ising approximation of the nonlinear objective. Reports its argmin and how well it ranks "
        "the hypotheses already simulated (Spearman vs simulated losses) — no oracle information.", PROBLEM_PROPS, ["approximation"]),
    _fn("compile_circuit", "Build a circuit (spec or your QASM) without running it: logical/physical gate counts after transpiling to "
        "the IBM heavy-hex target, two-qubit depth, budget check, the ideal output distribution (top states, whether each was "
        "already simulated, expected QUBO energy) and the compiled QASM. Costs no forward simulations.", CIRCUIT_PROPS, ["approximation"]),
    _fn("run_experiment", "Execute on a simulator/sampler now. Spends up to K forward simulations on the most-sampled states not yet "
        "simulated. An identical configuration already run in this experiment is not re-executed (its earlier result is returned) "
        "unless force_rerun=true. You then receive the rendered comparison image (search-side only).",
        {**CIRCUIT_PROPS, "provider": {"type": "string", "enum": sorted(SYNC_PROVIDERS)},
         "shots": {"type": "integer", "minimum": 128, "maximum": 8192},
         "force_rerun": {"type": "boolean", "description": "re-execute an identical configuration (e.g. to measure shot noise)"}},
        ["provider", "approximation"]),
    _fn("submit_hardware", "Queue the circuit on a physical QPU (see the backend catalog for connectivity and cost). "
        "Asynchronous; only if the user allowed autonomous QPU use.",
        {**CIRCUIT_PROPS, "provider": {"type": "string", "enum": sorted(backends.ids(hardware=True))}, "shots": {"type": "integer"}},
        ["provider", "approximation"]),
    _fn("record_revision", "Finish the iteration: record what you observed, your diagnosis, the single change you made and why. "
        "`reference_job_id` is the job you are improving on (ideally same provider and shots, so the comparison is on equal "
        "footing); `revised_job_id` the job that tests your change; `next_step` is what the next iteration should try.",
        {"observation": {"type": "string"}, "diagnosis": {"type": "string"}, "change": {"type": "string"},
         "rationale": {"type": "string"}, "reference_job_id": {"type": ["string", "null"]}, "revised_job_id": {"type": ["string", "null"]},
         "next_step": {"type": "string"}},
        ["observation", "diagnosis", "change", "rationale"]),
]

DESIGN_INSTRUCTIONS = f"""You are cortex², an autonomous quantum-circuit engineer working on a computational-neuroscience
inverse problem. An observed EEG feature vector y must be explained by a two-population Wilson–Cowan neural-mass model
f(theta) with four parameters (excitatory drive P, inhibitory gain c2, recurrent excitation c1, synaptic time constant tau),
each encoded in 2 qubits (8 qubits, 256 hypotheses). The scientific objective is the *nonlinear* weighted residual
||f(theta) - y||_W^2. Circuits can only optimise a quadratic (QUBO/Ising) approximation of it; every sample is decoded and
re-simulated, and each run validates (forward-simulates) only its {inv.DEFAULT_VALIDATION_BUDGET} most frequently sampled
states that were *not simulated before*, so a circuit is good when it concentrates probability on new hypotheses with low
nonlinear loss. Forward simulations are the scarce resource: the goal is the lowest validated loss with the fewest of them
(exhaustive search costs 256). You work blind, like a real experimenter: you only know the losses of hypotheses that have
actually been simulated — never the global minimum or (for synthetic data) the hidden configuration.

Your engineering levers: the approximation (trust_region with a baseline = linearisation point, usually the current best
validated hypothesis, and trust_weight; secant; jacobian; regression; feature_regression; surrogate = ridge-fitted QUBO
learned from every hypothesis already validated in this experiment — note: in the equal-budget benchmark (11 hidden
configurations, 64 forward simulations) surrogate + noisy QAOA recovered 5/11 vs 3/11 for random search, while a fixed
trust region tends to stall re-sampling already-simulated states; the best possible quadratic ranks the truth ~3rd–9th),
the validation budget is spent on not-yet-validated hypotheses first, the execution target — IBM superconducting
heavy-hex (Aer noise model / QPU: non-neighbour couplings need SWAPs, so full QAOA ≈ 424 physical gates and must be
pruned) versus IonQ trapped ions (ionq_simulator with the Aria/Forte noise model / ionq_qpu: all-to-all connectivity, every
ZZ coupling is one two-qubit gate, so the *unpruned* problem fits the budget), QAOA depth (reps),
angle choices, coupling pruning (prune_threshold / max_couplings) to fit the ~{qm.GATE_BUDGET}-gate *physical* budget after
transpilation to IBM heavy-hex hardware, warm starts, transpiler optimisation level, and — when the structured spec cannot
express your idea — your own OpenQASM 2.0 circuit (e.g. hardware-native coupling order, custom mixers, partial entanglers).

Protocol for this iteration: (1) inspect_state — read the previous revisions, and start from the last revision's next_step
unless the evidence contradicts it; (2) identify the most important measured failure of the current best approach (QUBO
ranks simulated hypotheses badly, its argmin is already simulated so runs learn nothing new, over-budget physical circuit,
noise destroying concentration, stuck baseline, …); (3) make ONE well-motivated change and use compile_circuit (free) to
check gates/depth and whether the ideal distribution puts mass on not-yet-simulated states; (4) test it with ONE
run_experiment using the same provider and shots as the reference so the comparison is on equal footing (prefer aer_noisy
or ionq_simulator so hardware noise is represented); do not re-run configurations that were already run; look carefully at
the rendered image; (5) call record_revision with reference_job_id, revised_job_id and a concrete next_step. If there is
no prior job, establish a baseline first and then revise it. Spend at most two run_experiment calls per iteration.

Execution backends available in this deployment (registry; ids are the `provider` values):
{backends.agent_brief()}

Rules: never invent measurements; quote numbers only from tool outputs. The verdict (improved/regressed/unchanged) is
computed by the system from measured metrics, not by you. These are model hypotheses about a simplified neural mass,
not clinical findings or seizure causes. 256 states are trivially enumerable classically: do not claim quantum advantage.
Keep text concise and specific."""


class DesignSession:
    def __init__(self, job: dict):
        self.job = job
        self.uid = job["owner"]
        self.exp = store().get("experiments", job["experiment_id"])
        self.trace: list[dict] = []
        self.ran: list[str] = []
        self.images: list[str] = []
        self.revision: dict | None = None

    # each tool returns (json_result, optional png bytes to show the model)
    def inspect_state(self, **_):
        s = session(self.uid)
        return {**experiment_state(self.exp), "budgets": {k: s[k] for k in ("allow_autonomous_qpu", "qpu_jobs_budget", "qpu_jobs_total")},
                "backends": backends.catalog()}, None

    def build_problem(self, approximation, baseline=None, trust_weight=0.15, **_):
        _, q, ising, quality = runner.build_problem(self.exp, approximation, baseline, float(trust_weight))
        couplings = sorted(ising.couplings(), key=lambda c: -abs(c[2]))
        out = {"search_fidelity": search_fidelity(q, observed_history(self.exp)), "ising_scale": ising.scale(),
               "h": [round(v, 4) for v in ising.h], "strongest_couplings": [[i, j, round(v, 4)] for i, j, v in couplings[:12]],
               "n_couplings": len(couplings), "meta": q.meta}
        if ORACLE:
            out["qubo_quality_oracle"] = quality
        return out, None

    def compile_circuit(self, approximation, baseline=None, trust_weight=0.15, spec=None, qasm=None, **_):
        p = runner.preview(self.exp, {"approximation": approximation, "baseline": baseline, "trust_weight": trust_weight,
                                      "spec": spec, "qasm": qasm})
        observed = observed_history(self.exp)
        top = p["ideal"]["top"]
        new_mass = sum(t["p"] for t in top if t["bitstring"] not in observed)
        ideal = {"top": [{"bitstring": t["bitstring"], "p": round(t["p"], 4), "already_simulated": t["bitstring"] in observed,
                          "loss_if_simulated": observed.get(t["bitstring"])} for t in top[:8]],
                 "mass_on_unsimulated_among_top16": round(new_mass, 4)}
        if ORACLE:
            ideal["oracle"] = {k: v for k, v in p["ideal"].items() if k != "top"}
        q = p["qasm"]
        spec_out = {k: v for k, v in (p["spec"] or {}).items() if k not in ("gammas", "betas")} if p["spec"] else None
        return {"spec": spec_out, "angles": {k: (p["spec"] or {}).get(k) for k in ("gammas", "betas")} if p["spec"] else None,
                "logical": {k: p["circuit"][k] for k in ("gates", "depth", "two_qubit_gates", "two_qubit_depth", "ops")},
                "physical": p["transpiled"], "ideal": ideal,
                "qasm": q if len(q) < 6000 else q[:6000] + "\n// …truncated"}, None

    def _job_body(self, provider, approximation, baseline, trust_weight, spec, qasm, shots):
        return {"provider": provider, "approximation": approximation, "baseline": baseline, "trust_weight": trust_weight,
                "spec": spec, "qasm": qasm, "shots": shots or qm.DEFAULT_SHOTS,
                "title": f"agent rev · {provider} · {approximation}"}

    def _config_key(self, body: dict) -> str:
        """Identity of a requested configuration. Surrogate QUBOs depend on the simulated history, so it is part of the key."""
        cfg = {k: body.get(k) for k in ("provider", "approximation", "trust_weight", "shots")}
        cfg["baseline"] = body.get("baseline") or self.exp.get("baseline") or "00000000"
        cfg["spec"] = {k: v for k, v in (body.get("spec") or {}).items() if v is not None}
        cfg["qasm"] = hashlib.sha256(body["qasm"].encode()).hexdigest()[:16] if body.get("qasm") else None
        if body.get("approximation") == "surrogate":
            cfg["history"] = len(observed_history(self.exp))
        return json.dumps(cfg, sort_keys=True, default=str)

    def run_experiment(self, provider, approximation, baseline=None, trust_weight=0.15, spec=None, qasm=None, shots=None,
                       force_rerun=False, **_):
        if provider not in SYNC_PROVIDERS:
            return {"error": f"provider must be one of {sorted(SYNC_PROVIDERS)}"}, None
        body = self._job_body(provider, approximation, baseline, trust_weight, spec, qasm, shots)
        key = self._config_key(body)
        if not force_rerun:
            for prev in store().query("jobs", self.uid, experiment_id=self.exp["id"], limit=500):
                if prev.get("config_key") == key and prev.get("status") == "completed":
                    if prev["id"] not in self.ran:
                        self.ran.append(prev["id"])
                    return {"not_rerun": "identical configuration already ran in this experiment; no forward simulations spent",
                            "duplicate_of": prev["id"], "job": compact_job(prev), "economics": economics(self.exp)}, None
        job = runner.create_job(self.uid, self.exp["id"], body, created_by="agent", autonomous=True, enqueue=False)
        store().update("jobs", job["id"], {"in_iteration": self.job["id"], "status": "running", "config_key": key})
        job = runner.execute_sample_job(store().get("jobs", job["id"]))
        self.ran.append(job["id"])
        self.exp = store().get("experiments", self.exp["id"])
        observed = observed_history(self.exp)
        png = None
        if job.get("evaluation"):
            try:
                from . import render

                png = render.agent_figure(self.exp, job, observed)
            except Exception:
                log.exception("agent figure failed for %s", job["id"])
        if job.get("image"):
            self.images.append(job["image"])
        return {"job": compact_job(job), "economics": economics(self.exp, observed)}, png

    def submit_hardware(self, provider, approximation, baseline=None, trust_weight=0.15, spec=None, qasm=None, shots=None, **_):
        avail = {p["id"]: p for p in runner.provider_availability()}.get(provider)
        if provider not in runner.HARDWARE_PROVIDERS or not avail or not avail["available"]:
            return {"denied": (avail or {}).get("reason") or f"{provider} is not a hardware provider"}, None
        if not reserve_budget(self.uid, qpu=True):
            return {"denied": "autonomous QPU use is disabled or its budget is exhausted; the user can submit from the UI"}, None
        job = runner.create_job(self.uid, self.exp["id"], self._job_body(provider, approximation, baseline, trust_weight, spec, qasm, shots),
                                created_by="agent", autonomous=True)
        self.ran.append(job["id"])
        return {"queued": compact_job(job), "note": "asynchronous; results arrive later and the operator will review them"}, None

    def record_revision(self, observation, diagnosis, change, rationale, reference_job_id=None, revised_job_id=None, next_step="", **_):
        self.revision = {"observation": observation, "diagnosis": diagnosis, "change": change, "rationale": rationale,
                         "reference_job_id": reference_job_id, "revised_job_id": revised_job_id, "next_step": next_step}
        return {"recorded": True}, None


def _metric_tuple(job: dict | None):
    if not job or not job.get("evaluation"):
        return None
    ev = job["evaluation"]
    return ev["best_nonlinear_loss"], ev["p_consistent"], (job.get("transpiled") or {}).get("gates")


AR_TOLERANCE = 0.02


def verdict(before: dict | None, after: dict | None, best_known_before: float | None = None) -> str:
    """Computed by the evaluator from measured values — never taken from the model.

    1. progress: the revised job validated a hypothesis better than anything simulated before the iteration → improved;
    2. otherwise compare the sample distributions on the nonlinear loss (approximation ratio, evaluator-side; robust to the
       unseen-first validation rule, under which a re-run cannot re-find an already-simulated best);
    3. legacy fallback when ratios are missing: best validated loss, then P(consistent), then fewer in-budget physical gates.
    """
    b = _metric_tuple(after)
    if b is None:
        return "untested"
    if best_known_before is not None and b[0] < best_known_before - (1e-9 + 1e-6 * abs(best_known_before)):
        return "improved"
    a = _metric_tuple(before)
    if a is None:
        return "untested" if best_known_before is None else "unchanged"
    ar_a = before["evaluation"].get("approximation_ratio")
    ar_b = after["evaluation"].get("approximation_ratio")
    if ar_a is not None and ar_b is not None:
        if ar_b > ar_a + AR_TOLERANCE:
            return "improved"
        if ar_b < ar_a - AR_TOLERANCE:
            return "regressed"
        if a[2] is not None and b[2] is not None and b[2] < a[2] and (after.get("transpiled") or {}).get("within_budget"):
            return "improved"
        return "unchanged"
    tol = 1e-9 + 1e-6 * abs(a[0])
    if b[0] < a[0] - tol:
        return "improved"
    if b[0] > a[0] + tol:
        return "regressed"
    if b[1] > a[1] + 0.01:
        return "improved"
    if b[1] < a[1] - 0.01:
        return "regressed"
    if a[2] is not None and b[2] is not None and b[2] < a[2] and (after.get("transpiled") or {}).get("within_budget"):
        return "improved"
    return "unchanged"


def choose_reference(model_ref: dict | None, revised: dict | None, prior_jobs: list[dict], best_before_job: dict | None):
    """Pick the job the revision is judged against; prefer equal footing (same provider and shots).

    Returns (job, basis) where basis ∈ model_specified | same_provider | experiment_best | none.
    """
    usable = [j for j in prior_jobs if j.get("kind") == "sample" and j.get("evaluation") and (not revised or j["id"] != revised["id"])]
    if model_ref and model_ref.get("evaluation") and (not revised or model_ref["id"] != revised["id"]):
        same = revised and model_ref.get("provider") == revised.get("provider") and model_ref.get("shots") == revised.get("shots")
        return model_ref, "model_specified" if same or not revised else "model_specified_cross_provider"
    if revised:
        same = [j for j in usable if j.get("provider") == revised.get("provider") and j.get("shots") == revised.get("shots")]
        if same:
            return max(same, key=lambda j: j.get("created_at") or ""), "same_provider"
    if best_before_job and best_before_job.get("evaluation") and (not revised or best_before_job["id"] != revised["id"]):
        return best_before_job, "experiment_best"
    return None, "none"


def _diff(a: str | None, b: str | None, label_a="before", label_b="after") -> str | None:
    if not a or not b or a == b:
        return None
    lines = list(difflib.unified_diff(a.splitlines(), b.splitlines(), label_a, label_b, lineterm="", n=1))
    return "\n".join(lines[:240]) if lines else None


def run_iteration(job: dict) -> dict:
    """One autonomous design revision (kind=agent_iteration)."""
    ds = DesignSession(job)
    exp = ds.exp
    store().update("experiments", exp["id"], {"status": "running"})
    best_before_job = store().get("jobs", exp["best"]["job_id"]) if exp.get("best") else None
    prior_jobs = [j for j in store().query("jobs", job["owner"], experiment_id=exp["id"], limit=500) if j["id"] != job["id"]]
    seen_before = observed_history(exp)
    best_known_before = min(seen_before.values()) if seen_before else None
    previous_revs = sorted(store().query("revisions", job["owner"], experiment_id=exp["id"], limit=500), key=lambda r: r.get("number", 0))
    num = len(previous_revs) + 1
    if not agent_configured():
        raise PermissionError("no model provider configured")

    def dispatch(name, args):
        fn = getattr(ds, name, None)
        if name.startswith("_") or fn is None or name not in {t.name for t in DESIGN_TOOLS}:
            return {"error": f"unknown tool {name}"}, None
        return fn(**args)

    def on_step(name, args, result):
        summary = json.dumps(result, default=str)[:400]
        ds.trace.append({"tool": name, "args": {k: v for k, v in args.items() if k != "qasm"} | ({"qasm": "(custom)"} if args.get("qasm") else {}),
                         "summary": summary, "time": now()})
        store().update("jobs", job["id"], {"tool_trace": ds.trace[-40:], "updated_at": now()})

    snap = artifacts().get(f"{job['owner']}/{exp['id']}/snapshot.png")
    carry = ""
    if previous_revs:
        last = previous_revs[-1]
        carry = (f"\nPrevious revision {last.get('number')} [{last.get('verdict')}]: change = {last.get('change') or '—'}"
                 f"\nIts proposed next step: {last.get('next_step') or '(none recorded)'}")
    econ = economics(exp, seen_before)
    first = {"role": "user", "text": (job.get("command") or "Run one design iteration.")
             + f"\nExperiment id: {exp['id']}. Revision number: {num}."
             + f"\nForward simulations used so far: {econ['forward_simulations_used']}/256; best validated "
             + (f"{econ['best_validated']} (loss {econ['best_validated_loss']:.4f})." if econ["best_validated"] else "none yet.")
             + carry
             + ("\nAttached: the user's current 3D lab view (illustrative EEG overlay, context only)." if snap else ""),
             "images": [snap] if snap else []}
    provenance, final_text, _ = llm.run_tools(DESIGN_INSTRUCTIONS, first, DESIGN_TOOLS, dispatch, max_steps=MAX_STEPS,
                                              effort=REASONING, on_step=on_step, stop=lambda: ds.revision is not None)
    rev = ds.revision or {"observation": final_text[:2000] or "(model ended without recording a revision)", "diagnosis": "",
                          "change": "", "rationale": "", "reference_job_id": None, "revised_job_id": None}
    known = {j["id"]: j for j in store().query("jobs", job["owner"], experiment_id=exp["id"], limit=500)}
    ran_jobs = [known[i] for i in ds.ran if i in known]
    executed = [j for j in ran_jobs if j.get("evaluation")]
    revised_id = rev.get("revised_job_id") if rev.get("revised_job_id") in ds.ran else (executed[-1]["id"] if executed else None)
    rev_job = known.get(revised_id) if revised_id else None
    # Jobs the agent ran earlier in this iteration also count as possible references (e.g. a fresh baseline).
    candidates_for_ref = prior_jobs + [j for j in ran_jobs if not rev_job or j["id"] != rev_job["id"]]
    ref_job, basis = choose_reference(known.get(rev.get("reference_job_id")), rev_job, candidates_for_ref, best_before_job)
    v = verdict(ref_job, rev_job, best_known_before)
    new_best = bool(rev_job and rev_job.get("evaluation") and best_known_before is not None
                    and rev_job["evaluation"]["best_nonlinear_loss"] < best_known_before - 1e-9)
    mb, ma = _metric_tuple(ref_job), _metric_tuple(rev_job)
    seen_after = observed_history(store().get("experiments", exp["id"]))
    record = {
        "owner": job["owner"], "experiment_id": exp["id"], "number": num, "created_at": now(),
        "model": provenance[-1]["provider"] if provenance else None, "provenance": provenance,
        "response_ids": [p["response_id"] for p in provenance if p.get("response_id")], "job_id": job["id"], **{k: rev.get(k, "") for k in ("observation", "diagnosis", "change", "rationale", "next_step")},
        "reference_job_id": ref_job["id"] if ref_job else None, "revised_job_id": rev_job["id"] if rev_job else None,
        "job_ids": ds.ran, "metric": "best_nonlinear_loss",
        "metric_before": mb[0] if mb else None, "metric_after": ma[0] if ma else None,
        "secondary": {"p_consistent_before": mb[1] if mb else None, "p_consistent_after": ma[1] if ma else None,
                      "physical_gates_before": mb[2] if mb else None, "physical_gates_after": ma[2] if ma else None,
                      "approximation_ratio_before": (ref_job or {}).get("evaluation", {}).get("approximation_ratio") if ref_job else None,
                      "approximation_ratio_after": (rev_job or {}).get("evaluation", {}).get("approximation_ratio") if rev_job else None,
                      "provider_before": (ref_job or {}).get("provider"), "provider_after": (rev_job or {}).get("provider")},
        "comparison_basis": basis, "new_best": new_best,
        "best_known_before": best_known_before, "best_known_after": min(seen_after.values()) if seen_after else None,
        "forward_simulations_before": len(seen_before), "forward_simulations_after": len(seen_after),
        "information": "oracle" if ORACLE else "blind",
        "approximation_before": (ref_job or {}).get("approximation"), "approximation_after": (rev_job or {}).get("approximation"),
        "spec_before": (ref_job or {}).get("spec"), "spec_after": (rev_job or {}).get("spec"),
        "spec_diff": _diff(json.dumps((ref_job or {}).get("spec"), indent=1, sort_keys=True) if ref_job else None,
                           json.dumps((rev_job or {}).get("spec"), indent=1, sort_keys=True) if rev_job else None, "spec.before", "spec.after"),
        "qasm_diff": _diff((ref_job or {}).get("qasm_compiled"), (rev_job or {}).get("qasm_compiled"), "circuit.before.qasm", "circuit.after.qasm"),
        "custom_qasm": bool(rev_job and rev_job.get("qasm_source") == "agent_qasm"),
        "verdict": v, "image": (rev_job or {}).get("image"), "tool_trace": ds.trace,
    }
    r = store().create("revisions", record)
    store().update("jobs", job["id"], {"status": "completed", "revision_id": r["id"], "updated_at": now(),
                                       "result": {"verdict": v, "summary": rev.get("change")}})
    store().update("experiments", exp["id"], {"status": "idle", "updated_at": now()})
    delta = f" ({mb[0]:.3f} → {ma[0]:.3f})" if mb and ma else ""
    runner.feed(job["owner"], "agent", f"Revision {num} [{v}]{delta}: {rev.get('change') or rev.get('observation')}", exp["id"], job["id"],
                {"revision_id": r["id"]})
    after_job(job["owner"], job["id"])
    return store().get("jobs", job["id"])


def start_iteration(uid: str, exp_id: str, instruction: str | None = None, created_by="user", autonomous=False) -> dict:
    from . import tasks

    if not agent_configured():
        raise PermissionError("no model provider configured: set GEMINI_API_KEY or AGENT_PROVIDERS")
    runner.owned("experiments", exp_id, uid)
    job = store().create("jobs", {"owner": uid, "experiment_id": exp_id, "kind": "agent_iteration", "provider": None,
                                  "title": "agent design iteration", "status": "queued", "created_at": now(), "updated_at": now(),
                                  "created_by": created_by, "autonomous": autonomous, "command": instruction, "timings": {"queued": now()}})
    tasks.enqueue(job["id"])
    return job


# ---------------------------------------------------------------- long-running operator

OPERATOR_TOOLS = [
    _fn("list_experiments", "All of the user's experiments with best result so far.", {}),
    _fn("list_jobs", "Recent jobs (all experiments) with status and measured metrics.", {"status": {"type": ["string", "null"]}}),
    _fn("get_job", "Full details of one job.", {"job_id": {"type": "string"}}, ["job_id"]),
    _fn("dispatch_job", "Queue a sampling job on an experiment (consumes autonomous budget unless the user asked for it in this message).",
        {"experiment_id": {"type": "string"}, "provider": {"type": "string", "enum": list(runner.PROVIDERS)}, **CIRCUIT_PROPS,
         "shots": {"type": "integer"}}, ["experiment_id", "provider", "approximation"]),
    _fn("start_design_iteration", "Ask the circuit engineer to run one revision on an experiment.",
        {"experiment_id": {"type": "string"}, "instruction": {"type": "string"}}, ["experiment_id"]),
    _fn("cancel_job", "Cancel a queued/running/submitted job.", {"job_id": {"type": "string"}}, ["job_id"]),
    _fn("retry_job", "Re-queue a failed job with the same configuration.", {"job_id": {"type": "string"}}, ["job_id"]),
    _fn("create_experiment", "Create a new experiment.", {"source": {"type": "string", "enum": ["synthetic", "recording"]},
        "truth_bitstring": {"type": ["string", "null"]}, "dataset_id": {"type": ["string", "null"]},
        "channel": {"type": ["string", "null"]}, "segment": {"type": ["string", "null"]}}, ["source"]),
    _fn("update_memory", "Replace your rolling research memory (≤1500 chars): goals, open questions, what's running, next steps.",
        {"memory": {"type": "string"}}, ["memory"]),
]

OPERATOR_INSTRUCTIONS = """You are the cortex² research operator: a long-running assistant that supervises a user's
quantum/thermodynamic/classical experiments on an 8-qubit neural-mass inverse problem (Wilson–Cowan model fitted to EEG
features). You keep a rolling memory across ticks. On each tick you see the user's message (if any), your memory, and can
list/inspect jobs. Babysit the backend: notice failed or stuck jobs and retry or cancel them, follow up on finished IBM jobs,
compare providers on equal footing (same approximation/spec/shots), and start design iterations when an experiment has a
clear failure to fix. Make good use of the budget: prefer cheap simulators to test ideas and reserve physical QPU runs for
circuits that are within the gate budget and already validated on the noisy simulator. Never fabricate results, never claim
quantum advantage (256 states are classically enumerable), and keep clinical language out: these are model hypotheses.
Finish with a short reply to the user (2–6 sentences, concrete numbers from tools) and update_memory."""


def run_operator(job: dict) -> dict:
    uid = job["owner"]
    s = session(uid)
    user_initiated = job.get("created_by") == "user"
    if not agent_configured():
        raise PermissionError("no model provider configured")
    actions: list[dict] = []

    def dispatch(name, args):
        if name == "list_experiments":
            exps = store().query("experiments", uid, limit=30)
            return {"experiments": [{"id": e["id"], "title": e["title"], "source": e["target"]["source"], "best": e.get("best"),
                                     "rounds": e.get("rounds"), "status": e.get("status"), "updated_at": e.get("updated_at")} for e in exps]}, None
        if name == "list_jobs":
            jobs = store().query("jobs", uid, limit=60)
            if args.get("status"):
                jobs = [j for j in jobs if j.get("status") == args["status"]]
            return {"jobs": [compact_job(j) for j in jobs[:40]]}, None
        if name == "get_job":
            return {"job": compact_job(runner.owned("jobs", args["job_id"], uid))}, None
        if name == "dispatch_job":
            qpu = args["provider"] in runner.HARDWARE_PROVIDERS
            if not user_initiated or qpu:
                if not reserve_budget(uid, qpu=qpu):
                    return {"denied": "autonomous budget exhausted or autonomous QPU disabled"}, None
            body = {k: args.get(k) for k in ("provider", "approximation", "baseline", "trust_weight", "spec", "qasm", "shots") if args.get(k) is not None}
            j = runner.create_job(uid, args["experiment_id"], body, created_by="agent", autonomous=not user_initiated)
            actions.append({"action": "dispatch", "job_id": j["id"], "provider": j["provider"]})
            return {"queued": compact_job(j)}, None
        if name == "start_design_iteration":
            if not user_initiated and not reserve_budget(uid):
                return {"denied": "autonomous budget exhausted"}, None
            j = start_iteration(uid, args["experiment_id"], args.get("instruction"), created_by="agent", autonomous=not user_initiated)
            actions.append({"action": "iterate", "job_id": j["id"]})
            return {"queued": {"id": j["id"], "kind": "agent_iteration"}}, None
        if name == "cancel_job":
            j = runner.cancel_job(uid, args["job_id"])
            actions.append({"action": "cancel", "job_id": j["id"]})
            return {"status": j["status"]}, None
        if name == "retry_job":
            old = runner.owned("jobs", args["job_id"], uid)
            if old.get("kind") != "sample" or old.get("status") != "failed":
                return {"error": "only failed sampling jobs can be retried"}, None
            if old["provider"] in runner.HARDWARE_PROVIDERS and not user_initiated and not reserve_budget(uid, qpu=True):
                return {"denied": "autonomous QPU disabled or budget exhausted"}, None
            body = {k: old.get(k) for k in ("provider", "approximation", "baseline", "trust_weight", "spec", "qasm", "shots")}
            j = runner.create_job(uid, old["experiment_id"], body, created_by="agent", autonomous=not user_initiated)
            actions.append({"action": "retry", "job_id": j["id"], "of": old["id"]})
            return {"queued": compact_job(j)}, None
        if name == "create_experiment":
            e = runner.create_experiment(uid, {k: v for k, v in args.items() if v is not None})
            actions.append({"action": "create_experiment", "experiment_id": e["id"]})
            return {"experiment": {"id": e["id"], "title": e["title"]}}, None
        if name == "update_memory":
            store().update("sessions", uid, {"operator_memory": args["memory"][:1500]})
            return {"ok": True}, None
        return {"error": f"unknown tool {name}"}, None

    recent_feed = store().query("feed", uid, order="time", limit=16)
    convo = "\n".join(f"[{f['kind']}] {f['text'][:400]}" for f in reversed(recent_feed))
    text = (f"Now: {now()}\nYour memory:\n{s.get('operator_memory') or '(empty)'}\n\nRecent activity:\n{convo}\n\n"
            f"Budgets: autonomous jobs {s['autonomous_jobs_total']}/{s['max_autonomous_jobs']}, "
            f"autonomous QPU {'allowed' if s['allow_autonomous_qpu'] else 'not allowed'} ({s['qpu_jobs_total']}/{s['qpu_jobs_budget']}). "
            f"Backends:\n{backends.agent_brief()}\n\n"
            + (f"User message: {job['command']}" if user_initiated else f"Automatic tick: {job.get('command') or 'review state'}")
            + (f"\nFocused experiment: {job['experiment_id']}" if job.get("experiment_id") else ""))
    provenance, reply, _ = llm.run_tools(OPERATOR_INSTRUCTIONS, {"role": "user", "text": text}, OPERATOR_TOOLS, dispatch,
                                         max_steps=14, effort=REASONING)
    reply = reply.strip() or "(no reply)"
    runner.feed(uid, "agent", reply, job.get("experiment_id"), job["id"], {"actions": actions})
    store().update("sessions", uid, {"last_tick": now()})
    store().update("jobs", job["id"], {"status": "completed", "result": {"reply": reply, "actions": actions},
                                       "provenance": provenance, "model": provenance[-1]["provider"] if provenance else None,
                                       "updated_at": now()})
    return store().get("jobs", job["id"])


def schedule_operator(uid: str, command: str, experiment_id: str | None = None, created_by: str = "agent") -> dict | None:
    from . import tasks

    if not agent_configured():
        return None
    if created_by == "agent":
        pending = [j for j in store().query("jobs", uid, limit=40) if j.get("kind") == "agent_operator" and j.get("status") in ("queued", "running")]
        if pending:
            return None
    job = store().create("jobs", {"owner": uid, "experiment_id": experiment_id, "kind": "agent_operator", "provider": None,
                                  "title": "research operator" if created_by == "agent" else "operator reply",
                                  "status": "queued", "created_at": now(), "updated_at": now(), "created_by": created_by,
                                  "autonomous": created_by == "agent", "command": command, "timings": {"queued": now()}})
    tasks.enqueue(job["id"], delay=2 if created_by == "agent" else 0)
    return job


def after_job(uid: str, job_id: str) -> None:
    """Autopilot hook: let the operator review finished work (not jobs run inside an iteration)."""
    job = store().get("jobs", job_id)
    if not job or job.get("in_iteration") or job.get("kind") == "agent_operator":
        return
    if session(uid).get("autopilot"):
        schedule_operator(uid, f"Job {job_id} ({job.get('provider') or job.get('kind')}) finished with status {job.get('status')}. Review and decide next steps.",
                          job.get("experiment_id"))


def heartbeat() -> dict:
    """Cloud Scheduler: repair stuck work and wake autopilot operators."""
    from . import tasks

    cutoff_running = (datetime.now(timezone.utc) - timedelta(minutes=45)).isoformat()
    cutoff_poll = (datetime.now(timezone.utc) - timedelta(minutes=12)).isoformat()
    stats = {"repolled": 0, "failed_stuck": 0, "ticks": 0}
    for status in ("submitted", "running"):
        for j in store().where("jobs", "status", status, limit=500):
            if status == "submitted" and (j.get("updated_at") or "") < cutoff_poll:
                tasks.enqueue(j["id"], "poll", attempt=int(time.time()))  # unique task name
                stats["repolled"] += 1
            if status == "running" and (j.get("updated_at") or "") < cutoff_running:
                store().update("jobs", j["id"], {"status": "failed", "error": "worker timed out (no progress for 45 min)", "updated_at": now()})
                runner.feed(j["owner"], "error", f"Job {j['id'][:8]} timed out and was marked failed.", j.get("experiment_id"), j["id"])
                stats["failed_stuck"] += 1
    for s in store().where("sessions", "autopilot", True, limit=200):
        last = s.get("last_tick") or ""
        if last < (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat():
            if schedule_operator(s["id"], "Periodic heartbeat: check running jobs and research progress."):
                stats["ticks"] += 1
    return stats
