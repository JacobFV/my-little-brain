"""Realistic synthetic Cyton recording for demos and tests without a headset.

8 channels in the default Ultracortex montage (Fp1, Fp2, C3, C4, P7, P8, O1, O2) at 250 Hz:
1/f background, weak resting alpha, eyes-closed periods with strong occipital/parietal alpha,
frontal blinks during eyes-open periods, a DC electrode offset and 60 Hz mains pickup.
Written in BrainFlow's file format for the PLAYBACK_FILE_BOARD with Cyton as master board.

    python research/bridge/fixture.py [out.csv]
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

FS = 250.0
CHANNELS = ["Fp1", "Fp2", "C3", "C4", "P7", "P8", "O1", "O2"]
EYES_CLOSED = [(20.0, 35.0), (45.0, 55.0)]
DEFAULT_PATH = Path(__file__).resolve().parent / "fixtures" / "cyton_demo_playback.csv"


def pink(n: int, rng: np.random.Generator) -> np.ndarray:
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / FS)
    spec[1:] /= np.sqrt(f[1:])
    spec[0] = 0
    x = np.fft.irfft(spec, n)
    return x / x.std()


def blink_waveform(fs: float = FS, amplitude: float = 180.0, width_s: float = 0.25) -> np.ndarray:
    """Asymmetric monophasic eye-blink artifact (fast rise, slower decay)."""
    t = np.arange(int(width_s * 2 * fs)) / fs
    rise, decay = width_s * 0.35, width_s * 0.65
    w = np.where(t < rise, np.sin(np.pi / 2 * t / rise) ** 2, np.exp(-((t - rise) / (decay / 2)) ** 2))
    return amplitude * w


def generate(seconds: float = 60.0, seed: int = 7, closed_alpha_uv: float = 25.0, blink_uv: float = 180.0) -> tuple[np.ndarray, dict]:
    """Returns (channels × samples µV raw signal, ground-truth events)."""
    rng = np.random.default_rng(seed)
    n = int(seconds * FS)
    t = np.arange(n) / FS
    closed = np.zeros(n, dtype=bool)
    for a, b in EYES_CLOSED:
        closed |= (t >= a) & (t < b)
    # smooth eyes-closed envelope (alpha waxes over ~0.5 s)
    env = np.convolve(closed.astype(float), np.ones(int(0.5 * FS)) / int(0.5 * FS), mode="same")
    alpha_phase = 2 * np.pi * np.cumsum(10.0 + 0.4 * np.sin(2 * np.pi * 0.1 * t)) / FS
    x = np.zeros((len(CHANNELS), n))
    blinks: list[float] = []
    bt = 2.0
    while bt < seconds - 1:
        if not closed[int(bt * FS)]:
            blinks.append(round(bt, 3))
        bt += rng.uniform(3.0, 5.0)
    bw = blink_waveform(amplitude=blink_uv)
    for i, ch in enumerate(CHANNELS):
        sig = 10.0 * pink(n, rng)
        posterior = 1.0 if ch in ("O1", "O2") else 0.6 if ch in ("P7", "P8") else 0.15
        sig += (3.0 + closed_alpha_uv * env * posterior) * np.sin(alpha_phase + rng.uniform(0, 2 * np.pi))
        if ch in ("Fp1", "Fp2"):
            for b in blinks:
                k = int(b * FS)
                seg = bw[: n - k] * rng.uniform(0.85, 1.15)
                sig[k:k + len(seg)] += seg
        sig += 5.0 * np.sin(2 * np.pi * 60.0 * t + i)          # mains pickup
        sig += rng.uniform(-3000, 3000)                          # electrode DC offset
        x[i] = sig
    return x, {"blinks": blinks, "eyes_closed": EYES_CLOSED, "fs": FS, "channels": CHANNELS}


def write_playback(path: Path = DEFAULT_PATH, seconds: float = 60.0, seed: int = 7) -> Path:
    from brainflow.board_shim import BoardIds, BoardShim
    from brainflow.data_filter import DataFilter

    board = BoardIds.CYTON_BOARD.value
    x, _ = generate(seconds, seed)
    n = x.shape[1]
    data = np.zeros((BoardShim.get_num_rows(board), n))
    data[BoardShim.get_package_num_channel(board)] = np.arange(n) % 256
    for row, ch in zip(BoardShim.get_eeg_channels(board), x):
        data[row] = ch
    data[BoardShim.get_timestamp_channel(board)] = 1.7e9 + np.arange(n) / FS
    path.parent.mkdir(parents=True, exist_ok=True)
    DataFilter.write_file(data, str(path), "w")
    return path


def ensure_playback(path: Path = DEFAULT_PATH) -> Path:
    return path if path.exists() else write_playback(path)


if __name__ == "__main__":
    out = write_playback(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PATH)
    print(f"wrote {out}")
