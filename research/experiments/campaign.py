"""Autonomous design-agent campaign → reproducible evidence artifact.

Runs N real agent iterations (the configured model chain, e.g. Gemini 4 Argon) on one experiment,
starting from the same naive in-budget QAOA baseline, against a local store. The agent works blind
(search-side information only); every verdict is computed by the evaluator from measured results.
Only simulators/samplers are available to it (hardware submission is denied: the session does not
allow autonomous QPU use).

    set -a; source research/.env; set +a
    python research/experiments/campaign.py --preset alpha        # synthetic 10101011
    python research/experiments/campaign.py --preset theta        # synthetic 11111011
    python research/experiments/campaign.py --preset ictal        # CHB-MIT chb01_03 T7-P7 seizure segment

Writes research/experiments/campaigns/<preset>.json and <preset>.md.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRESETS = {
    "alpha": {"source": "synthetic", "truth_bitstring": "10101011", "title": "synthetic alpha rhythm 10101011"},
    "theta": {"source": "synthetic", "truth_bitstring": "11111011", "title": "synthetic slow high-drive theta 11111011"},
    "ictal": {"source": "recording", "dataset_id": "chbmit-chb01_03", "channel": "T7-P7", "segment": "ictal",
              "title": "CHB-MIT chb01_03 T7-P7 ictal"},
}
BASELINE = {"provider": "aer_noisy", "approximation": "trust_region", "baseline": "00000000", "trust_weight": 0.15,
            "spec": {"reps": 1, "max_couplings": 6}, "shots": 1024, "title": "naive in-budget QAOA baseline"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", choices=PRESETS, required=True)
    ap.add_argument("--iterations", type=int, default=5)
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--env-file", default=str(HERE.parent / ".env"), help="KEY=VALUE file (values already in the environment win)")
    a = ap.parse_args()
    env_file = Path(a.env_file)
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key and not key.startswith("#") and value:
                os.environ.setdefault(key, value)
    os.environ["CORTEX_DATA_DIR"] = a.data_dir or tempfile.mkdtemp(prefix=f"cortex2-campaign-{a.preset}-")
    os.environ.pop("K_SERVICE", None)
    sys.path.insert(0, str(HERE.parent / "backend"))
    from cortex2 import agent, inverse as inv, llm, neural as nm, runner, tasks  # noqa: E402
    from cortex2.store import now, store  # noqa: E402

    tasks.set_local_handler(runner.handle_task)
    if not agent.agent_configured():
        raise SystemExit("no model provider configured (source research/.env)")
    uid = f"campaign-{a.preset}"
    preset = PRESETS[a.preset]
    exp = runner.create_experiment(uid, {k: v for k, v in preset.items()})
    target = runner.target_of(exp)
    losses = inv.nonlinear_losses(target)
    order = sorted(range(nm.N_STATES), key=lambda k: losses[k])
    threshold = inv.consistency_threshold(target, losses)
    truth = exp["target"].get("truth_bitstring")

    def rank(bitstring):
        return order.index(nm.grid_index(nm.bitstring_to_bits(bitstring))) + 1

    def evaluator(job):
        ev = job.get("evaluation") or {}
        tr = job.get("transpiled") or {}
        return {"job_id": job["id"], "provider": job.get("provider"), "approximation": job.get("approximation"),
                "baseline": job.get("baseline"), "trust_weight": job.get("trust_weight"), "shots": job.get("shots"),
                "spec": {k: v for k, v in (job.get("spec") or {}).items() if k not in ("gammas", "betas")} or None,
                "qasm_source": job.get("qasm_source"), "created_by": job.get("created_by"),
                "best_validated": ev.get("best", {}).get("bitstring"), "best_validated_loss": ev.get("best_nonlinear_loss"),
                "new_validations": ev.get("new_validations"), "approximation_ratio": ev.get("approximation_ratio"),
                "p_consistent": ev.get("p_consistent"), "physical_gates": tr.get("gates"), "two_qubit_gates": tr.get("two_qubit_gates"),
                "two_qubit_depth": tr.get("two_qubit_depth"), "transpile_target": tr.get("backend"), "tvd_vs_ideal": job.get("ideal_tvd"),
                "truth_recovered": (ev.get("truth") or {}).get("recovered_exactly"), "error": job.get("error")}

    started = time.time()
    base = runner.create_job(uid, exp["id"], BASELINE, enqueue=False)
    base = runner.execute_sample_job(store().get("jobs", base["id"]))
    print(f"baseline: best {base['evaluation']['best']['bitstring']} loss {base['evaluation']['best_nonlinear_loss']:.4f} "
          f"(global min {losses.min():.4f}); physical gates {base['transpiled']['gates']}", flush=True)
    timeline = []
    for i in range(1, a.iterations + 1):
        t0 = time.time()
        job = store().create("jobs", {"owner": uid, "experiment_id": exp["id"], "kind": "agent_iteration", "status": "running",
                                      "created_at": now(), "updated_at": now(), "created_by": "user", "title": f"campaign iteration {i}",
                                      "command": f"Campaign iteration {i}/{a.iterations}: lower the best validated loss while spending "
                                                 f"as few forward simulations as possible."})
        try:
            done = agent.run_iteration(store().get("jobs", job["id"]))
        except Exception as exc:  # record and continue; a failed iteration is evidence too
            print(f"iteration {i} failed: {exc}", flush=True)
            timeline.append({"iteration": i, "error": f"{type(exc).__name__}: {exc}"[:500], "seconds": round(time.time() - t0, 1)})
            continue
        rev = store().get("revisions", done["revision_id"])
        e = store().get("experiments", exp["id"])
        best = e.get("best") or {}
        entry = {"iteration": i, "seconds": round(time.time() - t0, 1), "verdict": rev["verdict"],
                 "comparison_basis": rev.get("comparison_basis"), "new_best": rev.get("new_best"),
                 "metric_before": rev.get("metric_before"), "metric_after": rev.get("metric_after"),
                 "best_known_before": rev.get("best_known_before"), "best_known_after": rev.get("best_known_after"),
                 "forward_simulations_after": rev.get("forward_simulations_after"),
                 "experiment_best": best.get("bitstring"), "experiment_best_loss": best.get("nonlinear_loss"),
                 "experiment_best_rank": rank(best["bitstring"]) if best else None,
                 "providers": sorted({p["provider"] for p in rev.get("provenance") or []}),
                 "model_turns": len(rev.get("provenance") or []),
                 "observation": rev.get("observation"), "diagnosis": rev.get("diagnosis"), "change": rev.get("change"),
                 "rationale": rev.get("rationale"), "next_step": rev.get("next_step"),
                 "custom_qasm": rev.get("custom_qasm"), "secondary": rev.get("secondary"),
                 "reference": evaluator(store().get("jobs", rev["reference_job_id"])) if rev.get("reference_job_id") else None,
                 "revised": evaluator(store().get("jobs", rev["revised_job_id"])) if rev.get("revised_job_id") else None,
                 "jobs_run": [evaluator(store().get("jobs", j)) for j in rev.get("job_ids", [])],
                 "tool_trace": [{"tool": t["tool"], "args": t["args"]} for t in rev.get("tool_trace", [])],
                 "qasm_diff": rev.get("qasm_diff"), "spec_diff": rev.get("spec_diff")}
        timeline.append(entry)
        print(f"iteration {i}: [{rev['verdict']}] ({rev.get('comparison_basis')}) best {best.get('bitstring')} "
              f"loss {best.get('nonlinear_loss', float('nan')):.4f} rank {entry['experiment_best_rank']}/256 · "
              f"sims {rev.get('forward_simulations_after')} · {entry['providers']} · {rev.get('change', '')[:120]}", flush=True)

    e = store().get("experiments", exp["id"])
    best = e.get("best") or {}
    seen = set()
    for j in store().query("jobs", uid, experiment_id=exp["id"], limit=500):
        for c in (j.get("evaluation") or {}).get("validated", []):
            seen.add(c["bitstring"])
    providers = collections.Counter(p for t in timeline for p in t.get("providers", []))
    result = {
        "preset": a.preset, "experiment": {"title": e["title"], "target": {k: v for k, v in e["target"].items() if k != "features"},
                                           "features": e["target"]["features"]},
        "model_version": e.get("model_version"), "agent_information": "oracle" if agent.ORACLE else "blind",
        "model_chain": llm.router().status(), "baseline": evaluator(base),
        "iterations": timeline,
        "outcome": {
            "best": best.get("bitstring"), "best_loss": best.get("nonlinear_loss"), "best_parameters": best.get("parameters"),
            "global_min_loss": float(losses.min()), "global_argmin": nm.bits_to_bitstring(nm.all_bits()[order[0]]),
            "best_rank_of_256": rank(best["bitstring"]) if best else None,
            "best_in_consistent_set": bool(best and best["nonlinear_loss"] <= threshold),
            "consistent_set_size": int((losses <= threshold).sum()),
            "hidden_truth": truth, "truth_recovered": bool(truth and best.get("bitstring") == truth),
            "forward_simulations_used": len(seen), "exhaustive_cost": nm.N_STATES,
            "verdicts": dict(collections.Counter(t.get("verdict", "error") for t in timeline)),
            "new_best_iterations": [t["iteration"] for t in timeline if t.get("new_best")],
            "model_providers_used": dict(providers),
        },
        "elapsed_seconds": round(time.time() - started, 1), "generated_at": now(),
    }
    out_dir = HERE / "campaigns"
    out_dir.mkdir(exist_ok=True)
    (out_dir / f"{a.preset}.json").write_text(json.dumps(result, indent=1, default=str))
    (out_dir / f"{a.preset}.md").write_text(markdown(result))
    print(markdown(result))


def markdown(r: dict) -> str:
    o, b = r["outcome"], r["baseline"]
    lines = [f"# Campaign: {r['experiment']['title']}", "",
             f"Agent information: **{r['agent_information']}** (search-side only) · model chain head: "
             f"`{r['model_chain'][0]['provider'] if r['model_chain'] else '?'}` · providers that answered: "
             + ", ".join(f"`{p}` ×{n}" for p, n in o["model_providers_used"].items()), "",
             f"**Baseline** (naive in-budget QAOA, {b['provider']}, {b['approximation']} @ {b['baseline']}, "
             f"{b['physical_gates']} physical gates): best validated `{b['best_validated']}` loss {b['best_validated_loss']:.4f}.", "",
             f"**Outcome:** best validated `{o['best']}` loss {o['best_loss']:.4f} — rank {o['best_rank_of_256']}/256 "
             f"(global minimum `{o['global_argmin']}` {o['global_min_loss']:.4f}); "
             f"{'inside' if o['best_in_consistent_set'] else 'outside'} the noise-consistent set ({o['consistent_set_size']} states); "
             + (f"hidden truth `{o['hidden_truth']}` {'**recovered**' if o['truth_recovered'] else 'not recovered'}; " if o["hidden_truth"] else "")
             + f"{o['forward_simulations_used']} forward simulations vs {o['exhaustive_cost']} exhaustive. "
             f"Verdicts: {o['verdicts']}; new best found in iterations {o['new_best_iterations'] or 'none'}.", "",
             "| # | verdict (basis) | best before → after | rank | sims | revised run | change |", "|---|---|---|---|---|---|---|"]
    for t in r["iterations"]:
        if t.get("error"):
            lines.append(f"| {t['iteration']} | error | | | | | {t['error'][:120]} |")
            continue
        rv = t.get("revised") or {}
        run = (f"{rv.get('provider')} · {rv.get('approximation')}"
               + (f" · {rv.get('physical_gates')} gates" if rv.get("physical_gates") else "")
               + (" · custom QASM" if t.get("custom_qasm") else "")) if rv else "—"
        bb, ba = t.get("best_known_before"), t.get("best_known_after")
        lines.append(f"| {t['iteration']} | {t['verdict']} ({t['comparison_basis']}) | "
                     f"{'—' if bb is None else f'{bb:.4f}'} → {'—' if ba is None else f'{ba:.4f}'} | {t['experiment_best_rank']} | "
                     f"{t['forward_simulations_after']} | {run} | {(t.get('change') or '').replace('|', '/')[:160]} |")
    lines += ["", "## Revisions", ""]
    for t in r["iterations"]:
        if t.get("error"):
            continue
        lines += [f"### Iteration {t['iteration']} — {t['verdict']}", "",
                  f"- **Observation:** {t.get('observation')}", f"- **Diagnosis:** {t.get('diagnosis')}",
                  f"- **Change:** {t.get('change')}", f"- **Rationale:** {t.get('rationale')}",
                  f"- **Next step:** {t.get('next_step')}",
                  f"- Tools: {' → '.join(x['tool'] for x in t['tool_trace'])}", ""]
    lines += ["Verdicts are computed by the evaluator (new best validated hypothesis, else sample-distribution quality "
              "on equal footing), never taken from the model. 256 hypotheses are classically enumerable; this documents "
              "the agent's engineering loop, not quantum advantage.", "",
              f"Regenerate: `python research/experiments/campaign.py --preset {r['preset']}` ({r['elapsed_seconds']:.0f} s)."]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
