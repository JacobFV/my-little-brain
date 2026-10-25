"""Reproducible cortex² benchmark (no cloud, no API keys).

For hidden synthetic Wilson–Cowan configurations, every provider runs the same protocol:
a trust-region QUBO around the current best validated hypothesis, an in-budget QAOA circuit
(6 strongest couplings, p=1) for gate-model providers, R rounds, validation budget K=8 forward
simulations per round. Reports exact recovery, residual reduction, physical gate counts and
noisy-vs-ideal agreement. Output: experiments/benchmark.json and experiments/BENCHMARK.md.

    python experiments/benchmark.py [--rounds 4] [--seeds 8] [--shots 1024]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from cortex2 import classical, inverse as inv, neural as nm, quantum as qm, runner, thermo  # noqa: E402

PROVIDERS = ["random", "classical_anneal", "thrml", "aer_ideal", "aer_noisy"]
SPEC = {"reps": 1, "max_couplings": 6}


def sample(provider, target, q, ising, shots, seed):
    if provider == "random":
        return classical.random_counts(shots, seed)[0], {}
    if provider == "classical_anneal":
        return classical.anneal_counts(q, shots, seed=seed)[0], {}
    if provider == "thrml":
        return thermo.sample(ising, shots, beta=3.0, seed=seed)[0], {}
    spec = qm.CircuitSpec.from_json(SPEC)
    spec.gammas, spec.betas, _ = qm.optimise_angles(ising, spec, objective=q.energies(), restarts=4)
    qc = qm.build_qaoa(ising, spec)
    _, t = qm.transpile(qc)
    counts, _ = qm.run_simulator(qc, shots, noisy=(provider == "aer_noisy"), seed=seed)
    return counts, {"physical_gates": t["gates"], "two_qubit_depth": t["two_qubit_depth"],
                    "tvd_vs_ideal": qm.total_variation(qm.normalise(counts), qm.ideal_distribution(qc))}


def campaign(provider, target, rounds, shots, seed):
    baseline, best_loss, history, evals = "00000000", np.inf, [], 0
    for r in range(rounds):
        q = inv.build_qubo(target, "trust_region", baseline=baseline, trust_weight=0.15)
        counts, extra = sample(provider, target, q, q.to_ising(), shots, seed + r)
        ev = inv.evaluate_counts(target, counts, q)
        evals += ev["validation_budget"]
        if ev["best_nonlinear_loss"] < best_loss:
            best_loss, baseline = ev["best_nonlinear_loss"], ev["best"]["bitstring"]
        history.append({"round": r + 1, "best_loss": best_loss, "baseline": baseline, "p_consistent": ev["p_consistent"],
                        "approximation_ratio": ev["approximation_ratio"], **extra})
    losses = inv.nonlinear_losses(target)
    truth = nm.bits_to_bitstring(target.truth_bits)
    return {"provider": provider, "final": baseline, "final_loss": best_loss, "min_loss": float(losses.min()),
            "recovered_truth": baseline == truth, "consistent": bool(best_loss <= inv.consistency_threshold(target, losses)),
            "forward_evaluations": evals, "history": history}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=4)
    ap.add_argument("--seeds", type=int, default=8)
    ap.add_argument("--shots", type=int, default=1024)
    a = ap.parse_args()
    truths = [p["bitstring"] for p in runner.SYNTHETIC_PRESETS]
    rng = np.random.default_rng(2026)
    truths += [nm.bits_to_bitstring(rng.integers(0, 2, 8)) for _ in range(a.seeds)]
    started = time.time()
    rows = []
    for i, truth in enumerate(truths):
        target = inv.synthetic_target(truth)
        for p in PROVIDERS:
            res = campaign(p, target, a.rounds, a.shots, seed=100 + i)
            res["truth"] = truth
            rows.append(res)
            print(f"{truth} {p:17s} final {res['final']} loss {res['final_loss']:.3f} (min {res['min_loss']:.3f}) "
                  f"recovered={res['recovered_truth']} consistent={res['consistent']}", flush=True)
    summary = {}
    for p in PROVIDERS:
        rs = [r for r in rows if r["provider"] == p]
        g = [h.get("physical_gates") for r in rs for h in r["history"] if h.get("physical_gates")]
        tv = [h.get("tvd_vs_ideal") for r in rs for h in r["history"] if h.get("tvd_vs_ideal") is not None]
        summary[p] = {"recovery_rate": float(np.mean([r["recovered_truth"] for r in rs])),
                      "consistent_rate": float(np.mean([r["consistent"] for r in rs])),
                      "median_loss_over_min": float(np.median([r["final_loss"] / max(r["min_loss"], 1e-9) for r in rs])),
                      "forward_evaluations": int(np.mean([r["forward_evaluations"] for r in rs])),
                      "mean_physical_gates": float(np.mean(g)) if g else None,
                      "mean_tvd_vs_ideal": float(np.mean(tv)) if tv else None}
    exact_evals = nm.N_STATES
    out = {"protocol": {"rounds": a.rounds, "shots": a.shots, "validation_budget": inv.DEFAULT_VALIDATION_BUDGET,
                        "approximation": "trust_region(0.15) around best-so-far", "circuit": SPEC,
                        "offline_target": qm.OFFLINE_TARGET, "levels": nm.LEVELS.tolist(), "truths": truths,
                        "exact_enumeration_forward_evaluations": exact_evals},
           "summary": summary, "runs": rows, "elapsed_seconds": round(time.time() - started, 1)}
    here = Path(__file__).parent
    (here / "benchmark.json").write_text(json.dumps(out, indent=1))
    lines = ["# cortex² benchmark", "", f"{len(truths)} hidden synthetic configurations · {a.rounds} rounds · "
             f"{a.shots} shots · K={inv.DEFAULT_VALIDATION_BUDGET} validated hypotheses/round "
             f"({a.rounds * inv.DEFAULT_VALIDATION_BUDGET} forward simulations vs {exact_evals} for exhaustive search).", "",
             "| provider | exact recovery | in consistent set | median loss / min | physical gates | TVD vs ideal |",
             "|---|---|---|---|---|---|"]
    for p, s in summary.items():
        lines.append(f"| {p} | {s['recovery_rate']:.0%} | {s['consistent_rate']:.0%} | {s['median_loss_over_min']:.2f} | "
                     f"{'' if s['mean_physical_gates'] is None else round(s['mean_physical_gates'])} | "
                     f"{'' if s['mean_tvd_vs_ideal'] is None else round(s['mean_tvd_vs_ideal'], 3)} |")
    lines += ["", "256 hypotheses are trivially enumerable classically; this measures sampler quality under a",
              "fixed validation budget, not quantum advantage. Regenerate: `python experiments/benchmark.py`."]
    (here / "BENCHMARK.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
