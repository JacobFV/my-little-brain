"""Two-population Wilson–Cowan neural-mass forward model and EEG feature map.

The model is a deliberately small, tractable stand-in for a cortical column:
an excitatory (E) and inhibitory (I) population driven by a noisy external
input. The simulated "EEG" is the excitatory population activity. Its four
parameters are *model* quantities, not directly measured biological causes.

Everything is vectorised over a batch of hypotheses and driven by one shared,
seeded noise realisation, so f(theta) is deterministic and two hypotheses only
differ because their dynamics differ.
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import product

import numpy as np

PARAM_NAMES = ("excitatory_drive", "inhibitory_gain", "recurrent_excitation", "synaptic_tau_ms")
PARAM_LABELS = {
    "excitatory_drive": "external input P into the excitatory population",
    "inhibitory_gain": "I→E coupling c2 (strength of suppression)",
    "recurrent_excitation": "E→E coupling c1 (positive feedback)",
    "synaptic_tau_ms": "excitatory membrane/synaptic time constant (ms)",
}
# Four levels per parameter (2 bits each) → 256 hypotheses. Chosen so the grid
# spans quiescent, oscillatory and high-amplitude regimes with few degeneracies.
LEVELS = np.array([
    [1.5, 2.0, 2.5, 3.0],      # P
    [10.0, 13.0, 16.0, 19.0],  # c2
    [12.0, 14.0, 16.0, 18.0],  # c1
    [8.0, 16.0, 30.0, 55.0],   # tau_e (ms): spans ~3–26 Hz rhythms
])
N_PARAMS = 4
BITS_PER_PARAM = 2
N_BITS = N_PARAMS * BITS_PER_PARAM
N_STATES = 2 ** N_BITS

# Fixed Wilson–Cowan constants (Wilson & Cowan 1972 limit-cycle regime).
C3, C4, Q_I = 15.0, 3.0, 0.0
A_E, TH_E, A_I, TH_I = 1.3, 4.0, 2.0, 3.7
TAU_RATIO = 1.6       # tau_i = TAU_RATIO * tau_e
NOISE_STD = 0.35

SIM_FS = 2000.0       # Hz
SIM_SECONDS = 9.0
SIM_TRANSIENT = 1.0   # s discarded
NOISE_SEED = 7

BAND_EDGES = np.geomspace(1.0, 45.0, 11)   # 10 log-spaced spectral bands
FEATURE_NAMES = tuple(
    [f"rel_logpow_{a:.1f}-{b:.1f}Hz" for a, b in zip(BAND_EDGES[:-1], BAND_EDGES[1:])] + ["log_amplitude"]
)
N_FEATURES = len(FEATURE_NAMES)
CLASSIC_BANDS = {"delta": (1, 4), "theta": (4, 8), "alpha": (8, 13), "beta": (13, 30), "gamma": (30, 45)}


def _sigmoid(x, a, th):
    return 1.0 / (1.0 + np.exp(-a * (x - th))) - 1.0 / (1.0 + np.exp(a * th))


def levels_to_params(levels) -> np.ndarray:
    """(n, 4) integer levels → (n, 4) physical parameter values."""
    lv = np.atleast_2d(np.asarray(levels, dtype=int))
    return np.stack([LEVELS[j][lv[:, j]] for j in range(N_PARAMS)], axis=1)


def bits_to_levels(bits) -> np.ndarray:
    """(n, 8) bits, little-endian per parameter (bit0 + 2*bit1) → (n, 4) levels."""
    b = np.atleast_2d(np.asarray(bits, dtype=int))
    return b[:, 0::2] + 2 * b[:, 1::2]


def levels_to_bits(levels) -> np.ndarray:
    lv = np.atleast_2d(np.asarray(levels, dtype=int))
    out = np.zeros((lv.shape[0], N_BITS), dtype=int)
    out[:, 0::2] = lv & 1
    out[:, 1::2] = (lv >> 1) & 1
    return out


def bitstring_to_bits(state: str) -> np.ndarray:
    """Qiskit bitstrings are big-endian (qubit 0 is the rightmost character)."""
    return np.array([int(c) for c in state[::-1]], dtype=int)


def bits_to_bitstring(bits) -> str:
    return "".join(str(int(b)) for b in np.asarray(bits)[::-1])


def all_bits() -> np.ndarray:
    """All 256 states, row k = bits of integer k (bit i = qubit i)."""
    k = np.arange(N_STATES)
    return ((k[:, None] >> np.arange(N_BITS)) & 1).astype(int)


def describe_params(values) -> dict:
    return {name: float(v) for name, v in zip(PARAM_NAMES, np.asarray(values, dtype=float).ravel())}


def simulate(params, seconds: float = SIM_SECONDS, fs: float = SIM_FS, seed: int = NOISE_SEED) -> np.ndarray:
    """Euler–Maruyama integration of a batch of Wilson–Cowan columns.

    params: (n, 4) [P, c2, c1, tau_e_ms] (continuous values allowed).
    returns: (steps, n) excitatory activity after the transient.
    """
    p = np.atleast_2d(np.asarray(params, dtype=float))
    drive, c2, c1, tau_ms = p.T
    dt = 1.0 / fs
    steps = int(round(seconds * fs))
    skip = int(round(SIM_TRANSIENT * fs))
    noise = np.random.default_rng(seed).standard_normal(steps) * NOISE_STD
    te = tau_ms / 1000.0
    ti = te * TAU_RATIO
    e = np.full(p.shape[0], 0.1)
    i = np.full(p.shape[0], 0.05)
    out = np.empty((steps - skip, p.shape[0]))
    for k in range(steps):
        de = (-e + (1 - e) * _sigmoid(c1 * e - c2 * i + drive + noise[k], A_E, TH_E)) / te
        di = (-i + (1 - i) * _sigmoid(C3 * e - C4 * i + Q_I, A_I, TH_I)) / ti
        e = e + dt * de
        i = i + dt * di
        if k >= skip:
            out[k - skip] = e
    return out


def spectrum(x: np.ndarray, fs: float, segment_seconds: float = 1.0):
    """Welch-style averaged periodogram over non-overlapping Hann segments. x: (n,) or (n, batch)."""
    x = np.asarray(x, dtype=float)
    if x.ndim == 1:
        x = x[:, None]
    x = x - x.mean(axis=0, keepdims=True)
    seg = int(round(fs * segment_seconds))
    k = max(1, x.shape[0] // seg)
    seg = min(seg, x.shape[0])
    xs = x[: k * seg].reshape(k, seg, -1)
    window = np.hanning(seg)[None, :, None]
    power = (np.abs(np.fft.rfft(xs * window, axis=1)) ** 2).mean(axis=0)
    return np.fft.rfftfreq(seg, 1.0 / fs), power


def features(x: np.ndarray, fs: float) -> np.ndarray:
    """EEG feature vector(s): 10 relative log band powers + log amplitude. Returns (batch, 11)."""
    x = np.asarray(x, dtype=float)
    if x.ndim == 1:
        x = x[:, None]
    f, power = spectrum(x, fs)
    bp = np.array([power[(f >= a) & (f < b)].sum(axis=0) for a, b in zip(BAND_EDGES[:-1], BAND_EDGES[1:])])
    rel = np.log10(bp / (bp.sum(axis=0, keepdims=True) + 1e-30) + 1e-6)
    amp = np.log10(x.std(axis=0) + 1e-6)
    return np.vstack([rel, amp[None]]).T


def band_powers(x: np.ndarray, fs: float) -> dict:
    """Relative classic band power percentages for display."""
    f, power = spectrum(np.asarray(x, dtype=float), fs)
    power = power[:, 0]
    total = power[(f >= 1) & (f < 45)].sum() + 1e-30
    return {k: float(100 * power[(f >= a) & (f < b)].sum() / total) for k, (a, b) in CLASSIC_BANDS.items()}


@dataclass
class ForwardTable:
    """Cached forward model over the whole 256-state grid (cheap: one batched simulation)."""
    bits: np.ndarray        # (256, 8)
    params: np.ndarray      # (256, 4)
    features: np.ndarray    # (256, 11)
    traces: np.ndarray      # (steps, 256)


_TABLE: ForwardTable | None = None


def forward_table() -> ForwardTable:
    global _TABLE
    if _TABLE is None:
        bits = all_bits()
        params = levels_to_params(bits_to_levels(bits))
        traces = simulate(params)
        _TABLE = ForwardTable(bits, params, features(traces, SIM_FS), traces)
    return _TABLE


def forward(params) -> np.ndarray:
    """f(theta): (n, 4) continuous params → (n, 11) features."""
    return features(simulate(params), SIM_FS)


def grid_index(bits) -> int:
    b = np.asarray(bits, dtype=int).ravel()
    return int(sum(int(v) << i for i, v in enumerate(b)))


def all_levels():
    return np.array(list(product(range(4), repeat=N_PARAMS)))
