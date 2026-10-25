"""Classical baselines: exact enumeration, budgeted random search, simulated annealing on the QUBO."""
from __future__ import annotations

import time

import numpy as np

from . import neural as nm
from .inverse import Qubo, Target, nonlinear_losses


def exact_counts(target: Target) -> tuple[dict[str, int], dict]:
    """Enumerate all 256 hypotheses with the nonlinear model; returns the ranked list as 1-count samples."""
    start = time.monotonic()
    losses = nonlinear_losses(target)
    order = np.argsort(losses)
    counts = {nm.bits_to_bitstring(nm.all_bits()[k]): int(nm.N_STATES - r) for r, k in enumerate(order)}
    return counts, {"mode": "exact_enumeration", "forward_evaluations": nm.N_STATES,
                    "elapsed_seconds": round(time.monotonic() - start, 6),
                    "note": "counts encode rank (best=256) so the top-K validation budget picks the true top-K"}


def random_counts(shots: int = 1024, seed: int = 0) -> tuple[dict[str, int], dict]:
    rng = np.random.default_rng(seed)
    counts: dict[str, int] = {}
    for k in rng.integers(0, nm.N_STATES, shots):
        s = nm.bits_to_bitstring(nm.all_bits()[k])
        counts[s] = counts.get(s, 0) + 1
    return counts, {"mode": "uniform_random", "seed": seed}


def anneal_counts(qubo: Qubo, shots: int = 1024, sweeps: int = 60, t0: float = 2.0, t1: float = 0.02, seed: int = 0):
    """Single-flip Metropolis simulated annealing on the QUBO energy (same objective as QAOA/THRML)."""
    rng = np.random.default_rng(seed)
    Q, l = qubo.Q, qubo.linear
    scale = float(max(np.abs(Q).max(), np.abs(l).max(), 1e-12))
    start = time.monotonic()
    b = rng.integers(0, 2, (shots, nm.N_BITS)).astype(float)
    temps = np.geomspace(t0, t1, sweeps)
    for T in temps:
        for i in range(nm.N_BITS):
            # ΔE for flipping bit i: (1-2b_i)(Q_ii + l_i + 2 Σ_{j≠i} Q_ij b_j)
            field = Q[i, i] + l[i] + 2 * (b @ Q[i] - Q[i, i] * b[:, i])
            delta = (1 - 2 * b[:, i]) * field / scale
            accept = rng.random(shots) < np.exp(-np.clip(delta, 0, None) / T)
            b[accept, i] = 1 - b[accept, i]
    counts: dict[str, int] = {}
    for row in b.astype(int):
        s = nm.bits_to_bitstring(row)
        counts[s] = counts.get(s, 0) + 1
    return counts, {"mode": "simulated_annealing", "sweeps": sweeps, "t0": t0, "t1": t1, "seed": seed,
                    "elapsed_seconds": round(time.monotonic() - start, 4)}
