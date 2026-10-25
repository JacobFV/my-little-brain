"""The 8-bit neural inverse problem, its quadratic (QUBO) approximations and evaluation.

    theta* = argmin_theta || f(theta) - y_EEG ||_W^2

theta is encoded with 2 bits per parameter (256 hypotheses). The nonlinear
loss is the scientific objective; a QUBO is only an approximation of it that a
QAOA circuit or an Ising sampler can search. Every sampled bitstring is decoded
and re-scored against the *nonlinear* forward model, so a poor approximation
shows up as a poor measured result rather than being hidden.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np

from . import neural as nm

Approximation = Literal["surrogate", "secant", "jacobian", "regression", "feature_regression", "trust_region"]
APPROXIMATIONS = ("surrogate", "secant", "jacobian", "regression", "feature_regression", "trust_region")
MIN_SURROGATE_POINTS = 12
DEFAULT_VALIDATION_BUDGET = 8

OBSERVATION_SEED = 1234      # synthetic "recording" uses different noise than the model
NOISE_REPLICATE_SEEDS = (101, 202, 303)


@dataclass
class Target:
    """An observed EEG feature vector to explain."""
    source: Literal["synthetic", "recording", "openbci"]
    features: np.ndarray
    weights: np.ndarray
    label: str
    truth_bits: np.ndarray | None = None
    trace: np.ndarray | None = None          # display waveform (z-scored)
    trace_fs: float = nm.SIM_FS
    meta: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "source": self.source, "label": self.label,
            "features": self.features.tolist(), "weights": self.weights.tolist(),
            "feature_names": list(nm.FEATURE_NAMES),
            "truth_bitstring": nm.bits_to_bitstring(self.truth_bits) if self.truth_bits is not None else None,
            "truth_params": nm.describe_params(nm.levels_to_params(nm.bits_to_levels(self.truth_bits))[0])
            if self.truth_bits is not None else None,
            "meta": self.meta,
        }


_SCALE: np.ndarray | None = None
_NOISE_VAR: np.ndarray | None = None


def feature_scale() -> np.ndarray:
    """Per-feature spread over the hypothesis grid; W = diag(1/scale^2) makes features commensurate."""
    global _SCALE
    if _SCALE is None:
        _SCALE = nm.forward_table().features.std(axis=0) + 1e-6
    return _SCALE


def model_noise_var() -> np.ndarray:
    """Per-feature variance due to the stochastic input alone (averaged over the grid)."""
    global _NOISE_VAR
    if _NOISE_VAR is None:
        t = nm.forward_table()
        reps = [t.features] + [nm.features(nm.simulate(t.params, seed=s), nm.SIM_FS) for s in NOISE_REPLICATE_SEEDS]
        _NOISE_VAR = np.var(np.stack(reps), axis=0).mean(axis=0)
    return _NOISE_VAR


def default_weights(include_amplitude: bool = True) -> np.ndarray:
    w = 1.0 / feature_scale() ** 2
    if not include_amplitude:
        w[-1] = 0.0
    return w / w.sum() * nm.N_FEATURES


def synthetic_target(truth_bitstring: str | None = None, seed: int = OBSERVATION_SEED, rng_seed: int | None = None) -> Target:
    """A synthetic recording from a known hidden configuration, simulated with independent noise."""
    if truth_bitstring is None:
        rng = np.random.default_rng(rng_seed)
        truth = rng.integers(0, 2, nm.N_BITS)
    else:
        truth = nm.bitstring_to_bits(truth_bitstring)
    params = nm.levels_to_params(nm.bits_to_levels(truth))
    trace = nm.simulate(params, seed=seed)[:, 0]
    return Target("synthetic", nm.features(trace, nm.SIM_FS)[0], default_weights(True),
                  f"synthetic hidden configuration (noise seed {seed})", truth_bits=truth,
                  trace=_z(trace), meta={"noise_seed": seed})


def recording_target(signal: np.ndarray, fs: float, label: str, meta: dict | None = None) -> Target:
    """Real EEG: amplitude units differ from the model, so only spectral shape is fitted."""
    signal = np.asarray(signal, dtype=float)
    return Target("recording", nm.features(signal, fs)[0], default_weights(False), label,
                  trace=_z(signal), trace_fs=fs, meta=meta or {})


def _z(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    return (x - x.mean()) / (x.std() + 1e-12)


# ---------------------------------------------------------------- nonlinear objective

def nonlinear_losses(target: Target) -> np.ndarray:
    """Exact weighted residual of the nonlinear forward model for all 256 states (index = integer state)."""
    r = nm.forward_table().features - target.features[None, :]
    return (r ** 2 * target.weights[None, :]).sum(axis=1)


def consistency_threshold(target: Target, losses: np.ndarray) -> float:
    """States within the stochastic noise floor of the best state are observationally equivalent."""
    noise_loss = float(2 * (model_noise_var() * target.weights).sum())
    return float(losses.min() + 3 * noise_loss)


# ---------------------------------------------------------------- QUBO approximations

@dataclass
class Qubo:
    """E(b) = b^T Q b + linear^T b + constant, Q symmetric (diagonal acts linearly since b_i^2 = b_i)."""
    Q: np.ndarray
    linear: np.ndarray
    constant: float
    method: str
    meta: dict = field(default_factory=dict)

    def energies(self) -> np.ndarray:
        b = nm.all_bits().astype(float)
        return np.einsum("ki,ij,kj->k", b, self.Q, b) + b @ self.linear + self.constant

    def energy(self, bits) -> float:
        b = np.asarray(bits, dtype=float)
        return float(b @ self.Q @ b + self.linear @ b + self.constant)

    def to_ising(self) -> "Ising":
        return qubo_to_ising(self)

    def to_json(self) -> dict:
        return {"Q": self.Q.tolist(), "linear": self.linear.tolist(), "constant": self.constant,
                "method": self.method, "meta": self.meta}


@dataclass
class Ising:
    """E(z) = offset + sum_i h_i z_i + sum_{i<j} J_ij z_i z_j, with bit b = (1 - z) / 2 (|0> ↔ z=+1)."""
    h: np.ndarray
    J: np.ndarray  # strictly upper-triangular
    offset: float

    def couplings(self, threshold: float = 0.0):
        n = len(self.h)
        return [(i, j, float(self.J[i, j])) for i in range(n) for j in range(i + 1, n) if abs(self.J[i, j]) > threshold]

    def scale(self) -> float:
        return float(max(np.abs(self.h).max(), np.abs(self.J).max(), 1e-12))

    def to_json(self) -> dict:
        return {"h": self.h.tolist(), "J": self.J.tolist(), "offset": self.offset}


def qubo_to_ising(q: Qubo) -> Ising:
    n = len(q.linear)
    a = np.diag(q.Q) + q.linear
    pair = 2 * np.triu(q.Q, 1)
    h = -a / 2 - (pair.sum(axis=1) + pair.sum(axis=0)) / 4
    J = pair / 4
    offset = q.constant + a.sum() / 2 + pair.sum() / 4
    return Ising(h, J, float(offset))


def _quadratic_from_linear_model(J: np.ndarray, c: np.ndarray, w: np.ndarray, method: str, meta: dict) -> Qubo:
    """||J b + c||_W^2 as a QUBO."""
    WJ = J * w[:, None]
    Q = J.T @ WJ
    linear = 2 * (c * w) @ J
    return Qubo((Q + Q.T) / 2, linear, float((c ** 2 * w).sum()), method, meta)


def _bit_secant(base: np.ndarray) -> np.ndarray:
    """J[:, i] = f(base with bit i = 1) - f(base with bit i = 0), using the exact forward table."""
    table = nm.forward_table().features
    cols = []
    for i in range(nm.N_BITS):
        on, off = base.copy(), base.copy()
        on[i], off[i] = 1, 0
        cols.append(table[nm.grid_index(on)] - table[nm.grid_index(off)])
    return np.stack(cols, axis=1)


def _pair_index():
    return [(i, j) for i in range(nm.N_BITS) for j in range(i + 1, nm.N_BITS)]


def _design(b: np.ndarray) -> np.ndarray:
    return np.hstack([np.ones((len(b), 1)), b, np.stack([b[:, i] * b[:, j] for i, j in _pair_index()], axis=1)])


def _qubo_from_coef(coef: np.ndarray, method: str, meta: dict) -> Qubo:
    Q = np.zeros((nm.N_BITS, nm.N_BITS))
    for k, (i, j) in enumerate(_pair_index()):
        Q[i, j] = Q[j, i] = coef[1 + nm.N_BITS + k] / 2
    return Qubo(Q, coef[1:1 + nm.N_BITS].copy(), float(coef[0]), method, meta)


def surrogate_qubo(observed: dict[str, float], ridge: float = 0.3, log_transform: bool = True) -> Qubo:
    """Learned quadratic surrogate of the loss from hypotheses already validated (BOCS / FMQA style).

    Ridge regression of (log) nonlinear loss on bits + pairwise products, fitted only to states that
    were actually simulated, so the surrogate never peeks at unevaluated hypotheses.
    """
    states = sorted(observed)
    b = np.array([nm.bitstring_to_bits(s) for s in states], dtype=float)
    y = np.array([observed[s] for s in states], dtype=float)
    yt = np.log(y + 1e-3) if log_transform else y
    X = _design(b)
    reg = ridge * np.eye(X.shape[1])
    reg[0, 0] = 0.0
    coef = np.linalg.solve(X.T @ X + reg, X.T @ yt)
    resid = yt - X @ coef
    return _qubo_from_coef(coef, "surrogate", {"points": len(states), "ridge": ridge, "log_transform": log_transform,
                                               "train_rmse": float(np.sqrt(np.mean(resid ** 2))),
                                               "note": "fitted only to validated hypotheses"})


def build_qubo(target: Target, method: Approximation = "secant", baseline: str | None = None,
               trust_weight: float = 0.0, samples: int = 64, seed: int = 0,
               observed: dict[str, float] | None = None, ridge: float = 0.3) -> Qubo:
    """Construct the quadratic surrogate of the nonlinear loss for `target`.

    secant        linearise around a baseline state using exact per-bit finite differences
    jacobian      linearise in continuous parameter space around the grid centre (level 1.5)
    regression    least-squares fit of all 37 QUBO coefficients to the true loss on `samples` states
    feature_regression  least-squares *linear* model of the features in the bits on `samples` states
    trust_region  secant around `baseline` plus a Hamming-distance penalty (Gauss–Newton style step)
    """
    w, y = target.weights, target.features
    table = nm.forward_table().features
    if method == "surrogate":
        if observed and len(observed) >= MIN_SURROGATE_POINTS:
            return surrogate_qubo(observed, ridge)
        # cold start: not enough validated data yet → explore with the secant model
        q = build_qubo(target, "secant", baseline=baseline)
        q.method = "surrogate"
        q.meta = {**q.meta, "cold_start": True, "points": len(observed or {})}
        return q
    if method in ("secant", "trust_region"):
        base = nm.bitstring_to_bits(baseline) if baseline else np.zeros(nm.N_BITS, dtype=int)
        J = _bit_secant(base)
        c = table[nm.grid_index(base)] - J @ base - y
        q = _quadratic_from_linear_model(J, c, w, method, {"baseline": nm.bits_to_bitstring(base)})
        if method == "trust_region" and trust_weight > 0:
            # lambda * Hamming(b, base) = lambda * sum_i (b_i + base_i - 2 b_i base_i): linear in b
            scale = float(np.abs(q.linear).max())
            lam = trust_weight * scale
            q.linear = q.linear + lam * (1 - 2 * base)
            q.constant += lam * float(base.sum())
            q.meta["trust_weight"] = trust_weight
        return q
    if method == "jacobian":
        centre = np.full(nm.N_PARAMS, 1.5)
        eps = 0.25

        def at(levels):
            vals = np.stack([np.interp(levels[:, j], np.arange(4), nm.LEVELS[j]) for j in range(nm.N_PARAMS)], axis=1)
            return nm.forward(vals)

        probes = np.vstack([centre] + [centre + eps * np.eye(nm.N_PARAMS)[j] for j in range(nm.N_PARAMS)]
                           + [centre - eps * np.eye(nm.N_PARAMS)[j] for j in range(nm.N_PARAMS)])
        f = at(probes)
        G = np.stack([(f[1 + j] - f[1 + nm.N_PARAMS + j]) / (2 * eps) for j in range(nm.N_PARAMS)], axis=1)
        A = np.zeros((nm.N_PARAMS, nm.N_BITS))   # level_j = b_{2j} + 2 b_{2j+1}
        for j in range(nm.N_PARAMS):
            A[j, 2 * j], A[j, 2 * j + 1] = 1, 2
        J = G @ A
        c = f[0] - G @ centre - y
        return _quadratic_from_linear_model(J, c, w, "jacobian", {"centre_level": 1.5, "eps": eps})
    if method == "feature_regression":
        rng = np.random.default_rng(seed)
        idx = np.sort(rng.choice(nm.N_STATES, size=min(samples, nm.N_STATES), replace=False))
        bits = nm.all_bits().astype(float)
        X = np.hstack([np.ones((len(idx), 1)), bits[idx]])
        coef, *_ = np.linalg.lstsq(X, table[idx], rcond=None)
        return _quadratic_from_linear_model(coef[1:].T, coef[0] - y, w, "feature_regression",
                                            {"samples": int(len(idx)), "seed": seed})
    if method == "regression":
        losses = nonlinear_losses(target)
        rng = np.random.default_rng(seed)
        idx = np.sort(rng.choice(nm.N_STATES, size=min(samples, nm.N_STATES), replace=False))
        bits = nm.all_bits()
        pairs = [(i, j) for i in range(nm.N_BITS) for j in range(i + 1, nm.N_BITS)]

        def design(b):
            return np.hstack([np.ones((len(b), 1)), b, np.stack([b[:, i] * b[:, j] for i, j in pairs], axis=1)])

        X = design(bits[idx].astype(float))
        coef, *_ = np.linalg.lstsq(X, losses[idx], rcond=None)
        Q = np.zeros((nm.N_BITS, nm.N_BITS))
        for k, (i, j) in enumerate(pairs):
            Q[i, j] = Q[j, i] = coef[1 + nm.N_BITS + k] / 2
        pred = design(bits.astype(float)) @ coef
        held = np.setdiff1d(np.arange(nm.N_STATES), idx)
        r2 = 1 - np.var(pred[held] - losses[held]) / (np.var(losses[held]) + 1e-12) if len(held) else 1.0
        return Qubo(Q, coef[1:1 + nm.N_BITS].copy(), float(coef[0]), "regression",
                    {"samples": int(len(idx)), "seed": seed, "heldout_r2": float(r2),
                     "note": "forward-model evaluations used for the fit count toward classical cost"})
    raise ValueError(f"unknown approximation {method!r}")


def approximation_quality(target: Target, q: Qubo) -> dict:
    """How faithfully the QUBO ranks hypotheses compared with the nonlinear objective."""
    losses = nonlinear_losses(target)
    e = q.energies()
    qubo_best = int(np.argmin(e))
    rank_corr = float(np.corrcoef(np.argsort(np.argsort(e)), np.argsort(np.argsort(losses)))[0, 1])
    true_best = int(np.argmin(losses))
    return {
        "qubo_argmin": nm.bits_to_bitstring(nm.all_bits()[qubo_best]),
        "qubo_argmin_nonlinear_loss": float(losses[qubo_best]),
        "nonlinear_argmin": nm.bits_to_bitstring(nm.all_bits()[true_best]),
        "nonlinear_min_loss": float(losses[true_best]),
        "rank_of_nonlinear_argmin_under_qubo": int((e < e[true_best]).sum()) + 1,
        "spearman": rank_corr,
    }


# ---------------------------------------------------------------- evaluation of samples

def evaluate_counts(target: Target, counts: dict[str, int], qubo: Qubo | None = None,
                    validation_budget: int = DEFAULT_VALIDATION_BUDGET, already_validated: set[str] | None = None) -> dict:
    """Decode measured bitstrings, rescore with the nonlinear model and report recovery metrics.

    Only the `validation_budget` most frequently sampled distinct states are re-simulated
    ("validated"); `best` is chosen among those. With 256 states and ~1k shots almost every
    state appears at least once, so choosing among *all* samples would just be enumeration.
    """
    if not counts:
        raise ValueError("provider returned no samples")
    losses = nonlinear_losses(target)
    total = int(sum(counts.values()))
    thresh = consistency_threshold(target, losses)
    consistent = set(np.flatnonzero(losses <= thresh).tolist())
    order = np.argsort(losses)
    top8 = set(order[:8].tolist())
    energies = qubo.energies() if qubo is not None else None
    candidates, p_consistent, p_top8, exp_loss = [], 0.0, 0.0, 0.0
    for state, n in counts.items():
        bits = nm.bitstring_to_bits(state)
        k = nm.grid_index(bits)
        p = n / total
        exp_loss += p * losses[k]
        p_consistent += p * (k in consistent)
        p_top8 += p * (k in top8)
        params = nm.levels_to_params(nm.bits_to_levels(bits))[0]
        candidates.append({
            "bitstring": state, "samples": int(n), "probability": p,
            "nonlinear_loss": float(losses[k]),
            "nonlinear_rank": int((losses < losses[k]).sum()) + 1,
            "qubo_energy": float(energies[k]) if energies is not None else None,
            "consistent": k in consistent,
            "levels": nm.bits_to_levels(bits)[0].tolist(),
            "parameters": nm.describe_params(params),
        })
    seen = already_validated or set()
    by_count = sorted(candidates, key=lambda c: (c["bitstring"] in seen, -c["samples"], c["bitstring"]))
    validated = by_count[:max(1, validation_budget)]   # most-sampled *new* hypotheses first
    for c in validated:
        c["validated"] = True
    candidates.sort(key=lambda c: c["nonlinear_loss"])
    best = min(validated, key=lambda c: c["nonlinear_loss"])
    best_any = candidates[0]
    uniform_loss = float(losses.mean())
    out = {
        "shots": total, "distinct_states": len(counts),
        "validation_budget": int(validation_budget),
        "new_validations": sum(1 for c in validated if c["bitstring"] not in seen),
        "best": best, "best_any_sample": best_any,
        "validated": sorted(validated, key=lambda c: c["nonlinear_loss"]),
        "candidates": candidates[:24],
        "best_nonlinear_loss": best["nonlinear_loss"],
        "best_consistent": bool(best["consistent"]),
        "expected_nonlinear_loss": float(exp_loss),
        "uniform_expected_loss": uniform_loss,
        "min_possible_loss": float(losses.min()),
        # 1 = samples concentrate on the optimum, 0 = no better than random guessing
        "approximation_ratio": float((uniform_loss - exp_loss) / (uniform_loss - losses.min() + 1e-12)),
        "p_consistent": float(p_consistent),
        "p_top8": float(p_top8),
        "consistent_set_size": len(consistent),
        "uniform_p_consistent": len(consistent) / nm.N_STATES,
    }
    if target.truth_bits is not None:
        t = nm.grid_index(target.truth_bits)
        truth_levels = nm.bits_to_levels(target.truth_bits)[0]
        best_levels = np.array(best["levels"])
        out["truth"] = {
            "bitstring": nm.bits_to_bitstring(target.truth_bits),
            "p_truth": float(counts.get(nm.bits_to_bitstring(target.truth_bits), 0) / total),
            "uniform_p_truth": 1 / nm.N_STATES,
            "recovered_exactly": best["bitstring"] == nm.bits_to_bitstring(target.truth_bits),
            "truth_in_consistent_set": t in consistent,
            "best_hamming_distance": int((nm.bitstring_to_bits(best["bitstring"]) != target.truth_bits).sum()),
            "parameter_level_error": {n: int(abs(a - b)) for n, a, b in zip(nm.PARAM_NAMES, best_levels, truth_levels)},
            "truth_nonlinear_rank": int((losses < losses[t]).sum()) + 1,
        }
    return out


def landscape(target: Target, qubo: Qubo | None = None) -> dict:
    """All 256 hypotheses with their nonlinear loss (and QUBO energy) for the 16x16 explorer."""
    losses = nonlinear_losses(target)
    bits = nm.all_bits()
    thresh = consistency_threshold(target, losses)
    energies = qubo.energies() if qubo is not None else None
    return {
        "states": [nm.bits_to_bitstring(b) for b in bits],
        "levels": nm.bits_to_levels(bits).tolist(),
        "nonlinear_loss": losses.tolist(),
        "qubo_energy": energies.tolist() if energies is not None else None,
        "consistency_threshold": thresh,
        "param_names": list(nm.PARAM_NAMES),
        "param_levels": nm.LEVELS.tolist(),
    }


def simulated_trace(bitstring: str, seconds: float = 2.0) -> np.ndarray:
    """z-scored excitatory activity of a hypothesis for waveform comparison."""
    t = nm.forward_table()
    k = nm.grid_index(nm.bitstring_to_bits(bitstring))
    return _z(t.traces[: int(seconds * nm.SIM_FS), k])
