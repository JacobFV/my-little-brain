"""Reproducible cortex² benchmark (no cloud, no API keys).

For hidden synthetic Wilson–Cowan configurations, each *protocol* (sampler × QUBO approximation)
runs R rounds. Every round it builds a QUBO (trust region around the best validated hypothesis, or
a ridge surrogate learned from every hypothesis validated so far), samples 1024 shots, and spends
a validation budget of K=8 forward simulations on the most-sampled hypotheses *not yet simulated*.
The baseline is random search without replacement: K fresh uniformly random hypotheses per round.
Everyone therefore has the same forward-simulation budget (≤ R·K distinct simulations vs 256 for
exhaustive search); the count actually used is reported (concentrated samplers can use fewer).

Gate-model protocols use an in-budget QAOA circuit (6 strongest couplings, p=1) transpiled to the
offline IBM heavy-hex target. Output: experiments/benchmark.json and experiments/BENCHMARK.md.

    python experiments/benchmark.py [--rounds 8] [--seeds 8] [--shots 1024]
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

K = inv.DEFAULT_VALIDATION_BUDGET
SPEC = {"reps": 1, "max_couplings": 6}
# (protocol name, sampler, approximation)
PROTOCOLS = [
    ("random_unseen", "random", None),
    ("anneal · trust_region", "classical_anneal", "trust_region"),
    ("thrml · trust_region", "thrml", "trust_region"),
    ("aer_ideal · trust_region", "aer_ideal", "trust_region"),
    ("aer_noisy · trust_region", "aer_noisy", "trust_region"),
    ("anneal · surrogate", "classical_anneal", "surrogate"),
    ("aer_noisy · surrogate", "aer_noisy", "surrogate"),
]
ALL = [nm.bits_to_bitstring(b) for b in nm.all_bits()]


def sample(sampler, q, ising, shots, seed):
    if sampler == "classical_anneal":
        return classical.anneal_counts(q, shots, seed=seed)[0], {}
    if sampler == "thrml":
        return thermo.sample(ising, shots, beta=3.0, seed=seed)[0], {}
    spec = qm.CircuitSpec.from_json(SPEC)
    spec.gammas, spec.betas, _ = qm.optimise_angles(ising, spec, objective=q.energies(), restarts=4)
    qc = qm.build_qaoa(ising, spec)
    _, t = qm.transpile(qc)
    counts, _ = qm.run_simulator(qc, shots, noisy=(sampler == "aer_noisy"), seed=seed)
    return counts, {"physical_gates": t["gates"], "two_qubit_depth": t["two_qubit_depth"],
                    "tvd_vs_ideal": qm.total_variation(qm.normalise(counts), qm.ideal_distribution(qc))}


def campaign(protocol, sampler, approximation, target, rounds, shots, seed):
    losses = inv.nonlinear_losses(target)
    observed: dict[str, float] = {}           # every hypothesis forward-simulated so far
    rng = np.random.default_rng(seed)
    history = []
    for r in range(rounds):
        extra: dict = {}
        if sampler == "random":
            unseen = [s for s in ALL if s not in observed]
            for s in rng.choice(unseen, size=min(K, len(unseen)), replace=False):
                observed[s] = float(losses[nm.grid_index(nm.bitstring_to_bits(s))])
            ar = None
        else:
            baseline = min(observed, key=observed.get) if observed else "00000000"
            q = inv.build_qubo(target, approximation, baseline=baseline, trust_weight=0.15, observed=observed)
            counts, extra = sample(sampler, q, q.to_ising(), shots, seed + r)
            ev = inv.evaluate_counts(target, counts, q, K, already_validated=set(observed))
            for c in ev["validated"]:
                observed[c["bitstring"]] = c["nonlinear_loss"]
            ar = ev["approximation_ratio"]
        best = min(observed, key=observed.get)
        history.append({"round": r + 1, "best": best, "best_loss": observed[best], "forward_evaluations": len(observed),
                        "approximation_ratio": ar, **extra})
    best = min(observed, key=observed.get)
    truth = nm.bits_to_bitstring(target.truth_bits)
    return {"protocol": protocol, "final": best, "final_loss": observed[best], "min_loss": float(losses.min()),
            "recovered_truth": best == truth, "consistent": bool(observed[best] <= inv.consistency_threshold(target, losses)),
            "forward_evaluations": len(observed), "truth_simulated": truth in observed, "history": history}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=8)
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
        for name, sampler, approx in PROTOCOLS:
            res = campaign(name, sampler, approx, target, a.rounds, a.shots, seed=100 + i)
            res["truth"] = truth
            rows.append(res)
            print(f"{truth} {name:26s} final {res['final']} loss {res['final_loss']:.3f} (min {res['min_loss']:.3f}) "
                  f"sims {res['forward_evaluations']:3d} recovered={res['recovered_truth']} consistent={res['consistent']}", flush=True)
    summary = {}
    for name, _, _ in PROTOCOLS:
        rs = [r for r in rows if r["protocol"] == name]
        g = [h.get("physical_gates") for r in rs for h in r["history"] if h.get("physical_gates")]
        tv = [h.get("tvd_vs_ideal") for r in rs for h in r["history"] if h.get("tvd_vs_ideal") is not None]
        ar = [h["approximation_ratio"] for r in rs for h in r["history"] if h.get("approximation_ratio") is not None]
        summary[name] = {"n": len(rs),
                         "recovered": int(sum(r["recovered_truth"] for r in rs)),
                         "consistent": int(sum(r["consistent"] for r in rs)),
                         "recovery_rate": float(np.mean([r["recovered_truth"] for r in rs])),
                         "consistent_rate": float(np.mean([r["consistent"] for r in rs])),
                         "median_loss_over_min": float(np.median([r["final_loss"] / max(r["min_loss"], 1e-9) for r in rs])),
                         "mean_forward_evaluations": float(np.mean([r["forward_evaluations"] for r in rs])),
                         "mean_approximation_ratio": float(np.mean(ar)) if ar else None,
                         "mean_physical_gates": float(np.mean(g)) if g else None,
                         "mean_tvd_vs_ideal": float(np.mean(tv)) if tv else None}
    budget = a.rounds * K
    out = {"protocol": {"rounds": a.rounds, "shots": a.shots, "validation_budget_per_round": K, "max_forward_evaluations": budget,
                        "validation": "most-sampled not-yet-simulated hypotheses first", "trust_weight": 0.15,
                        "surrogate": f"ridge QUBO on log-loss of validated hypotheses (secant cold start < {inv.MIN_SURROGATE_POINTS} points)",
                        "circuit": SPEC, "offline_target": qm.OFFLINE_TARGET, "levels": nm.LEVELS.tolist(), "truths": truths,
                        "random_expected_recovery": budget / nm.N_STATES},
           "summary": summary, "runs": rows, "elapsed_seconds": round(time.time() - started, 1)}
    here = Path(__file__).parent
    (here / "benchmark.json").write_text(json.dumps(out, indent=1))
    n = len(truths)
    lines = ["# cortex² benchmark", "",
             f"{n} hidden synthetic configurations · {a.rounds} rounds · {a.shots} shots · K={K} new hypotheses validated per round",
             f"(≤{budget} forward simulations vs 256 for exhaustive search; random search without replacement is expected to",
             f"simulate the truth with probability {budget}/256 = {budget / nm.N_STATES:.0%}).", "",
             "| protocol | exact recovery | in consistent set | median loss / min | forward sims used | mean approx. ratio | physical gates | TVD vs ideal |",
             "|---|---|---|---|---|---|---|---|"]
    for p, s in summary.items():
        lines.append(f"| {p} | {s['recovered']}/{s['n']} ({s['recovery_rate']:.0%}) | {s['consistent']}/{s['n']} ({s['consistent_rate']:.0%}) | "
                     f"{s['median_loss_over_min']:.2f} | {s['mean_forward_evaluations']:.1f} | "
                     f"{'' if s['mean_approximation_ratio'] is None else round(s['mean_approximation_ratio'], 3)} | "
                     f"{'' if s['mean_physical_gates'] is None else round(s['mean_physical_gates'])} | "
                     f"{'' if s['mean_tvd_vs_ideal'] is None else round(s['mean_tvd_vs_ideal'], 3)} |")
    lines += ["", "**Reading this honestly.**",
              "- 256 hypotheses are trivially enumerable classically; this measures sampler quality under a fixed",
              "  forward-simulation budget, not quantum advantage.",
              f"- With {n} configurations per protocol, differences of one or two recoveries are within noise.",
              "- Approximation ratio = (E_uniform − E_samples)/(E_uniform − min) of the nonlinear loss under the sample",
              "  distribution: 1 = all probability on the optimum, 0 = no better than uniform.",
              "- Even the best possible quadratic surrogate (fitted on all 256 states) ranks the truth only ~3rd–9th on",
              "  these landscapes, which caps every QUBO-based protocol.", "",
              f"Regenerate: `python research/experiments/benchmark.py --rounds {a.rounds} --seeds {a.seeds}` "
              f"({out['elapsed_seconds']:.0f} s on the authoring machine)."]
    (here / "BENCHMARK.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
