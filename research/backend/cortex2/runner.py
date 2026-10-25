"""Experiments and jobs: build the inverse problem, compile, execute on a provider, evaluate, persist.

Every provider samples the same Ising/QUBO objective; every result is re-scored against the
nonlinear neural model. Physical IBM jobs are submitted and then polled by delayed tasks.
"""
from __future__ import annotations

import logging
import time
import traceback
from typing import Any

import numpy as np

from . import backends, eeg, inverse as inv, neural as nm, quantum as qm
from .store import artifacts, now, store

log = logging.getLogger("cortex2.runner")

# Provider tables are derived from the backend registry (cortex2/backends.py).
PROVIDERS = {bid: {"label": b.label, "kind": b.kind} for bid, b in backends.REGISTRY.items()}
GATE_PROVIDERS = set(backends.ids(paradigm="gate"))
HARDWARE_PROVIDERS = set(backends.ids(hardware=True))
TERMINAL = {"completed", "failed", "cancelled"}
SYNTHETIC_PRESETS = [
    {"bitstring": "10101011", "label": "alpha rhythm · P 3.0, c2 16, c1 16, τ 30 ms"},
    {"bitstring": "11111011", "label": "slow high-drive theta (seizure-like) · P 3.0, c2 16, c1 18, τ 55 ms"},
    {"bitstring": "00110010", "label": "fast beta/gamma · P 2.5, c2 10, c1 18, τ 8 ms"},
]


def provider_availability() -> list[dict]:
    return backends.catalog()


# ---------------------------------------------------------------- experiments

def _downsample(x: np.ndarray, fs: float, seconds: float = 4.0, max_points: int = 1000) -> dict:
    x = np.asarray(x, dtype=float)[: int(seconds * fs)]
    step = max(1, int(np.ceil(len(x) / max_points)))
    return {"fs": fs / step, "samples": [round(float(v), 4) for v in x[::step]]}


def create_experiment(uid: str, req: dict) -> dict:
    source = req.get("source", "synthetic")
    if source == "synthetic":
        target = inv.synthetic_target(req.get("truth_bitstring"), rng_seed=req.get("random_seed"))
        title = req.get("title") or f"synthetic recovery · hidden {nm.bits_to_bitstring(target.truth_bits)}"
    elif source == "recording":
        ds, ch, seg = req["dataset_id"], req.get("channel") or "FP1-F7", req.get("segment") or "ictal"
        x, fs, meta = eeg.segment(ds, ch, seg)
        target = inv.recording_target(x, fs, f"{eeg.dataset(ds)['label']} · {ch} · {seg}", meta)
        title = req.get("title") or f"{ds} {ch} {seg}"
    elif source == "openbci":
        rec = store().get("eeg_recordings", req["recording_id"])
        if not rec or rec.get("owner") != uid:
            raise KeyError("recording not found")
        chans = rec["channel_names"]
        ch = req.get("channel") or chans[0]
        x = eeg.preprocess(np.asarray(rec["data"][chans.index(ch)], dtype=float), float(rec["fs"]))
        target = inv.recording_target(x, float(rec["fs"]), f"OpenBCI · {rec['label']} · {ch}",
                                      {"recording_id": rec["id"], "channel": ch})
        target.source = "openbci"
        title = req.get("title") or f"OpenBCI {rec['label']} {ch}"
    else:
        raise ValueError(f"unknown source {source!r}")
    doc = {
        "owner": uid, "title": title[:160], "created_at": now(), "updated_at": now(),
        "target": target.to_json(), "observed_trace": _downsample(target.trace, target.trace_fs),
        "best": None, "baseline": "00000000", "rounds": 0, "status": "idle",
        "model_version": {"levels": nm.LEVELS.tolist(), "sim_seconds": nm.SIM_SECONDS, "noise_seed": nm.NOISE_SEED,
                          "fs": nm.SIM_FS, "features": list(nm.FEATURE_NAMES)},
    }
    exp = store().create("experiments", doc)
    feed(uid, "system", f"New experiment: {title}. Target source: {target.label}.", experiment_id=exp["id"])
    return exp


def target_of(exp: dict) -> inv.Target:
    t = exp["target"]
    truth = nm.bitstring_to_bits(t["truth_bitstring"]) if t.get("truth_bitstring") else None
    return inv.Target(t["source"], np.asarray(t["features"]), np.asarray(t["weights"]), t["label"],
                      truth_bits=truth, meta=t.get("meta", {}))


def owned(coll: str, doc_id: str, uid: str) -> dict:
    doc = store().get(coll, doc_id)
    if not doc or doc.get("owner") != uid:
        raise KeyError(f"{coll[:-1]} not found")
    return doc


def feed(uid: str, kind: str, text: str, experiment_id: str | None = None, job_id: str | None = None, data: Any = None):
    return store().create("feed", {"owner": uid, "kind": kind, "text": text[:8000], "experiment_id": experiment_id,
                                   "job_id": job_id, "time": now(), "created_at": now(), "data": data})


# ---------------------------------------------------------------- problem + circuit

def validated_history(exp: dict, exclude_job: str | None = None) -> dict[str, float]:
    """Every hypothesis already re-simulated in this experiment → its nonlinear loss."""
    seen: dict[str, float] = {}
    for j in store().query("jobs", exp["owner"], experiment_id=exp["id"], limit=500):
        if j.get("id") == exclude_job or not j.get("evaluation"):
            continue
        for c in j["evaluation"].get("validated", []):
            seen[c["bitstring"]] = c["nonlinear_loss"]
    return seen


def build_problem(exp: dict, approximation: str = "trust_region", baseline: str | None = None,
                  trust_weight: float = 0.15, samples: int = 64, seed: int = 0, observed: dict[str, float] | None = None):
    target = target_of(exp)
    if approximation not in inv.APPROXIMATIONS:
        raise ValueError(f"approximation must be one of {inv.APPROXIMATIONS}")
    base = baseline or exp.get("baseline") or "00000000"
    if approximation == "surrogate" and observed is None:
        observed = validated_history(exp)
    q = inv.build_qubo(target, approximation, baseline=base, trust_weight=trust_weight, samples=samples, seed=seed,
                       observed=observed)
    return target, q, q.to_ising(), inv.approximation_quality(target, q)


def compile_circuit(ising: inv.Ising, qubo: inv.Qubo, spec_json: dict | None = None, qasm: str | None = None):
    """Returns (logical circuit, spec, source). Angles are optimised against the *full* QUBO energy."""
    if qasm:
        return qm.parse_qasm(qasm), None, "agent_qasm"
    spec = qm.CircuitSpec.from_json(spec_json)
    if spec.gammas is None or spec.betas is None or len(spec.gammas) != spec.reps or len(spec.betas) != spec.reps:
        spec.gammas, spec.betas, _ = qm.optimise_angles(ising, spec, objective=qubo.energies())
    return qm.build_qaoa(ising, spec), spec, "spec"


def preview(exp: dict, body: dict) -> dict:
    target, q, ising, quality = build_problem(exp, body.get("approximation", "trust_region"), body.get("baseline"),
                                              float(body.get("trust_weight", 0.15)))
    qc, spec, source = compile_circuit(ising, q, body.get("spec"), body.get("qasm"))
    _, tstats = qm.transpile(qc, optimization_level=(spec.optimization_level if spec else 3))
    ideal = qm.ideal_distribution(qc)
    return {"qubo_quality": quality, "ising": ising.to_json(), "spec": spec.to_json() if spec else None,
            "qasm_source": source, "circuit": qm.describe(qc), "transpiled": tstats,
            "ideal": ideal_summary(target, ideal), "qasm": qm.to_qasm(qc)}


def ideal_summary(target: inv.Target, dist: dict[str, float]) -> dict:
    losses = inv.nonlinear_losses(target)
    thresh = inv.consistency_threshold(target, losses)
    exp_loss = sum(p * losses[nm.grid_index(nm.bitstring_to_bits(s))] for s, p in dist.items())
    p_cons = sum(p for s, p in dist.items() if losses[nm.grid_index(nm.bitstring_to_bits(s))] <= thresh)
    out = {"expected_nonlinear_loss": float(exp_loss), "p_consistent": float(p_cons),
           "top": [{"bitstring": s, "p": p} for s, p in sorted(dist.items(), key=lambda kv: -kv[1])[:16]]}
    if target.truth_bits is not None:
        out["p_truth"] = float(dist.get(nm.bits_to_bitstring(target.truth_bits), 0.0))
    return out


# ---------------------------------------------------------------- jobs

def create_job(uid: str, exp_id: str, body: dict, created_by: str = "user", autonomous: bool = False,
               revision_id: str | None = None, enqueue: bool = True) -> dict:
    from . import tasks

    provider = body.get("provider")
    if provider not in PROVIDERS:
        raise ValueError(f"provider must be one of {list(PROVIDERS)}")
    avail = {p["id"]: p for p in provider_availability()}[provider]
    if not avail["available"]:
        raise PermissionError(avail["reason"])
    if body.get("qasm") and provider not in GATE_PROVIDERS:
        raise ValueError("qasm circuits run only on gate-model providers")
    exp = owned("experiments", exp_id, uid)
    shots = int(min(max(int(body.get("shots", qm.DEFAULT_SHOTS)), 64), 8192))
    job = store().create("jobs", {
        "owner": uid, "experiment_id": exp_id, "kind": "sample", "provider": provider,
        "title": body.get("title") or f"{PROVIDERS[provider]['label']} · {body.get('approximation', 'trust_region')}",
        "status": "queued", "created_at": now(), "updated_at": now(), "created_by": created_by,
        "autonomous": autonomous, "approximation": body.get("approximation", "trust_region"),
        "baseline": body.get("baseline") or exp.get("baseline") or "00000000",
        "trust_weight": float(body.get("trust_weight", 0.15)), "spec": body.get("spec"),
        "qasm": body.get("qasm"), "shots": shots, "validation_budget": int(body.get("validation_budget", inv.DEFAULT_VALIDATION_BUDGET)),
        "revision_id": revision_id, "error": None, "timings": {"queued": now()},
    })
    if enqueue:
        try:
            tasks.enqueue(job["id"])
        except Exception as exc:
            store().update("jobs", job["id"], {"status": "failed", "error": f"queue unavailable: {exc}", "updated_at": now()})
            raise
    return store().get("jobs", job["id"])


def claim(job_id: str, from_status: str, to_status: str) -> dict | None:
    def fn(cur):
        if not cur or cur.get("status") != from_status:
            return None
        return {"status": to_status, "updated_at": now()}
    return store().transact("jobs", job_id, fn)


def execute_sample_job(job: dict) -> dict:
    """Run synchronously or submit asynchronously, depending on the backend's capabilities."""
    from . import tasks

    jid = job["id"]
    exp = store().get("experiments", job["experiment_id"])
    target, q, ising, quality = build_problem(exp, job["approximation"], job.get("baseline"), job.get("trust_weight", 0.15))
    patch: dict[str, Any] = {"qubo_quality": quality, "ising": ising.to_json(), "timings": {**job.get("timings", {}), "started": now()}}
    backend = backends.get(job["provider"])
    options = dict(job.get("spec") or {})
    t0 = time.monotonic()
    if backend.caps.paradigm == "gate":
        qc, spec, source = compile_circuit(ising, q, job.get("spec"), job.get("qasm"))
        if spec:
            options["optimization_level"] = spec.optimization_level
        ideal = qm.ideal_distribution(qc)
        patch.update({"spec": {**options, **spec.to_json()} if spec else None, "qasm_source": source,
                      "circuit": qm.describe(qc), "qasm_compiled": qm.to_qasm(qc), "ideal": ideal_summary(target, ideal)})
        if backend.caps.mode == "async":
            sub = backend.submit(qc, job["shots"], options, name=f"cortex2 {jid}")
            patch.update({"status": "submitted", "provider_job_id": sub["provider_job_id"], "backend": sub["backend"],
                          "transpiled": sub["transpiled"], "isa_circuit": sub.get("isa_circuit"), "ideal_distribution": ideal,
                          "provider_status": sub.get("provider_status"), "updated_at": now()})
            store().update("jobs", jid, patch)
            t = sub["transpiled"]
            feed(job["owner"], "result", f"Submitted to {backend.label} ({sub['backend']}) as {sub['provider_job_id']}: "
                 f"{t.get('gates')} physical gates, {t.get('two_qubit_gates')} two-qubit, connectivity {backend.caps.connectivity}.",
                 job["experiment_id"], jid)
            tasks.enqueue(jid, "poll", delay=20, attempt=1)
            return store().get("jobs", jid)
        counts, runner, tstats, isa = backend.run(qc, job["shots"], options)
        patch.update({"transpiled": tstats, "isa_circuit": qm.describe(isa), "ideal_tvd": qm.total_variation(qm.normalise(counts), ideal)})
        for k in ("provider_job_id", "backend"):
            if runner.get(k):
                patch[k] = runner[k]
    elif backend.caps.paradigm == "ising":
        counts, runner, reference = backend.sample(ising, q, job["shots"], options)
        if reference is not None:
            patch["ideal_tvd"] = qm.total_variation(qm.normalise(counts), reference)
    else:
        counts, runner = backend.solve(target, q, job["shots"], options)
    runner["wall_seconds"] = round(time.monotonic() - t0, 3)
    return finish_job(job, exp, target, q, counts, runner, patch)


def finish_job(job, exp, target, q, counts, runner, patch) -> dict:
    jid = job["id"]
    evaluation = inv.evaluate_counts(target, counts, q, job.get("validation_budget", inv.DEFAULT_VALIDATION_BUDGET),
                                     already_validated=set(validated_history(exp, exclude_job=jid)))
    patch.update({"counts": counts, "evaluation": evaluation, "runner": runner, "updated_at": now(),
                  "timings": {**job.get("timings", {}), **patch.get("timings", {}), "finished": now()}})
    store().update("jobs", jid, patch)
    try:
        render_job(store().get("jobs", jid))      # before "completed", so readers always see the image
    except Exception:
        log.exception("render failed for %s", jid)
    store().update("jobs", jid, {"status": "completed", "updated_at": now()})
    best = evaluation["best"]
    improved = update_experiment_best(exp, best, jid)
    gates = (patch.get("transpiled") or {}).get("gates")
    text = (f"{PROVIDERS[job['provider']]['label']}: best validated hypothesis {best['bitstring']} "
            f"(loss {best['nonlinear_loss']:.3f}, min possible {evaluation['min_possible_loss']:.3f}); "
            f"P(consistent) {evaluation['p_consistent']:.3f} vs uniform {evaluation['uniform_p_consistent']:.3f}"
            + (f"; {gates} physical gates" if gates is not None else "")
            + (f"; hidden truth recovered" if evaluation.get("truth", {}).get("recovered_exactly") else "")
            + (" — new best for this experiment." if improved else "."))
    feed(job["owner"], "result", text, job["experiment_id"], jid)
    from . import agent
    agent.after_job(job["owner"], jid)
    return store().get("jobs", jid)


def update_experiment_best(exp: dict, best: dict, job_id: str) -> bool:
    improved = {"v": False}

    def fn(cur):
        if not cur:
            return None
        patch = {"rounds": int(cur.get("rounds", 0)) + 1, "updated_at": now()}
        prev = cur.get("best")
        if prev is None or best["nonlinear_loss"] < prev["nonlinear_loss"] - 1e-12:
            improved["v"] = True
            patch["best"] = {"bitstring": best["bitstring"], "nonlinear_loss": best["nonlinear_loss"],
                             "parameters": best["parameters"], "consistent": best["consistent"], "job_id": job_id}
            patch["baseline"] = best["bitstring"]
        return patch

    store().transact("experiments", exp["id"], fn)
    return improved["v"]


def poll_provider_job(job: dict, attempt: int) -> dict:
    from . import tasks

    backend = backends.get(job["provider"])
    res = backend.poll(job["provider_job_id"], job["shots"])
    if res["status"] == "pending":
        store().update("jobs", job["id"], {"provider_status": res.get("provider_status"), "updated_at": now(), "poll_attempt": attempt})
        tasks.enqueue(job["id"], "poll", delay=min(300, 20 * (min(attempt, 50) + 1)), attempt=attempt + 1)
        return store().get("jobs", job["id"])
    if res["status"] == "failed":
        store().update("jobs", job["id"], {"status": "failed", "error": res["error"], "updated_at": now()})
        feed(job["owner"], "error", res["error"], job["experiment_id"], job["id"])
        return store().get("jobs", job["id"])
    exp = store().get("experiments", job["experiment_id"])
    target, q, _, _ = build_problem(exp, job["approximation"], job.get("baseline"), job.get("trust_weight", 0.15))
    counts = res["counts"]
    seconds = res.get("quantum_seconds") or ((res.get("execution_time_ms") or 0) / 1000 or None)
    patch = {"quantum_seconds": seconds, "provider_status": "done",
             "ideal_tvd": qm.total_variation(qm.normalise(counts), job.get("ideal_distribution") or {})}
    runner = {"mode": f"{backend.id}_hardware", "backend": job.get("backend"), "provider_job_id": job["provider_job_id"]}
    return finish_job(job, exp, target, q, counts, runner, patch)


def handle_task(payload: dict) -> dict:
    """Entry point for Cloud Tasks (and local threads)."""
    from . import agent

    jid, step = payload["job_id"], payload.get("step", "execute")
    job = store().get("jobs", jid)
    if not job:
        return {"missing": True}
    if job["status"] in TERMINAL:
        return {"terminal": job["status"]}
    try:
        if step == "poll":
            if job["status"] != "submitted":
                return {"not_pollable": job["status"]}
            return {"status": poll_provider_job(job, int(payload.get("attempt", 1)))["status"]}
        if not claim(jid, "queued", "running"):
            return {"already_claimed": True}
        job = store().get("jobs", jid)
        if job["kind"] == "sample":
            return {"status": execute_sample_job(job)["status"]}
        if job["kind"] == "agent_iteration":
            return {"status": agent.run_iteration(job)["status"]}
        if job["kind"] == "agent_operator":
            return {"status": agent.run_operator(job)["status"]}
        raise ValueError(f"unknown job kind {job['kind']}")
    except Exception as exc:
        log.exception("job %s failed", jid)
        store().update("jobs", jid, {"status": "failed", "error": f"{type(exc).__name__}: {exc}"[:2000],
                                     "traceback": traceback.format_exc()[-4000:], "updated_at": now()})
        feed(job["owner"], "error", f"Job {jid[:8]} ({job.get('provider') or job['kind']}) failed: {exc}",
             job.get("experiment_id"), jid)
        return {"status": "failed"}


def cancel_job(uid: str, job_id: str) -> dict:
    job = owned("jobs", job_id, uid)
    if job["status"] in TERMINAL:
        return job
    if job["status"] == "submitted" and job.get("provider_job_id"):
        try:
            backends.get(job["provider"]).cancel(job["provider_job_id"])
        except Exception as exc:
            log.warning("provider cancel failed: %s", exc)
    store().update("jobs", job_id, {"status": "cancelled", "updated_at": now()})
    return store().get("jobs", job_id)


# ---------------------------------------------------------------- rendering

def render_job(job: dict) -> str | None:
    """Comparison figure for a completed job (also what the agent looks at)."""
    if not job.get("evaluation"):
        return None
    from . import render

    exp = store().get("experiments", job["experiment_id"])
    png = render.job_figure(exp, job)
    path = artifacts().put(f"{job['owner']}/{job['experiment_id']}/jobs/{job['id']}.png", png)
    store().update("jobs", job["id"], {"image": path})
    return path
