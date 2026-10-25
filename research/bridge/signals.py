"""Pure signal processing for the OpenBCI bridge (no BrainFlow / hardware needed, unit-tested).

Visualisation-grade estimates only: band powers, blink events, eyes-closed alpha state and a
per-channel quality label. Not clinical EEG interpretation.
"""
from __future__ import annotations

import glob
import sys
from collections import deque

import numpy as np
from scipy.signal import butter, iirnotch, sosfilt, sosfilt_zi, tf2sos

BANDS = {"delta": (1, 4), "theta": (4, 8), "alpha": (8, 13), "beta": (13, 30), "gamma": (30, 45)}
FRONTAL = ("fp1", "fp2", "af7", "af8", "afz", "fpz")
OCCIPITAL = ("o1", "o2", "oz", "po3", "po4", "po7", "po8")

# Cyton ADS1299 at gain 24: full scale ±4.5 V / 24 ≈ ±187,500 µV. Railed ≈ within 5 % of that.
CYTON_FULL_SCALE_UV = 187_500.0


class Filters:
    """Causal 1–45 Hz band-pass + mains notch, streaming state kept between chunks."""

    def __init__(self, fs: float, n_channels: int, mains: float = 60.0, low: float = 1.0, high: float = 45.0):
        sos = butter(4, [low, min(high, fs / 2 - 1)], btype="band", fs=fs, output="sos")
        if mains and mains < fs / 2:
            b, a = iirnotch(mains, 30.0, fs)
            sos = np.vstack([sos, tf2sos(b, a)])
        self.sos = sos
        self.n = n_channels
        self.zi: np.ndarray | None = None

    def reset(self) -> None:
        self.zi = None

    def __call__(self, x: np.ndarray) -> np.ndarray:  # x: (channels, samples)
        x = np.asarray(x, dtype=float)
        if x.shape[1] == 0:
            return x
        if self.zi is None:
            self.zi = sosfilt_zi(self.sos)[:, None, :] * x[None, :, 0, None]
        y, self.zi = sosfilt(self.sos, x, axis=1, zi=self.zi)
        return y


def bandpowers(x: np.ndarray, fs: float) -> dict:
    """Relative band power (%) of one channel plus RMS µV. Empty dict if < 1 s of data."""
    x = np.asarray(x, dtype=float)
    if len(x) < fs:
        return {}
    x = x - x.mean()
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / fs)
    total = spec[(f >= 1) & (f < 45)].sum() + 1e-12
    out = {k: round(float(100 * spec[(f >= a) & (f < b)].sum() / total), 2) for k, (a, b) in BANDS.items()}
    out["rms_uv"] = round(float(np.sqrt(np.mean(x ** 2))), 2)
    return out


def average_bands(per_channel: list[dict]) -> dict:
    valid = [p for p in per_channel if p]
    keys = list(BANDS) + ["rms_uv"]
    return {k: round(float(np.mean([p[k] for p in valid])), 2) if valid else 0.0 for k in keys}


def channel_quality(raw: np.ndarray, filtered: np.ndarray, full_scale_uv: float = CYTON_FULL_SCALE_UV) -> str:
    """Label for one channel window: ok | flat | railed | noisy | line_noise | no data.

    raw = unfiltered µV (railing is a DC phenomenon, invisible after the band-pass);
    filtered = 1–45 Hz µV.
    """
    raw = np.asarray(raw, dtype=float)
    filtered = np.asarray(filtered, dtype=float)
    if raw.size == 0 or filtered.size == 0:
        return "no data"
    if np.max(np.abs(raw)) >= 0.95 * full_scale_uv or np.mean(np.abs(np.diff(raw)) == 0) > 0.9:
        return "railed"
    sd = float(np.std(filtered))
    if sd < 0.3:
        return "flat"
    if sd > 200:
        return "noisy"
    return "ok"


def line_noise_ratio(raw: np.ndarray, fs: float, mains: float = 60.0) -> float:
    """Mains power relative to 1–45 Hz power in the unfiltered signal (electrode contact proxy)."""
    raw = np.asarray(raw, dtype=float)
    if len(raw) < fs or mains >= fs / 2:
        return 0.0
    raw = raw - raw.mean()
    spec = np.abs(np.fft.rfft(raw * np.hanning(len(raw)))) ** 2
    f = np.fft.rfftfreq(len(raw), 1 / fs)
    line = spec[(f >= mains - 2) & (f <= mains + 2)].sum()
    eeg = spec[(f >= 1) & (f < 45)].sum() + 1e-12
    return float(line / eeg)


class BlinkDetector:
    """Frontal blink events: a large, brief (100–400 ms), mostly-monophasic deflection.

    Each update looks at the most recent `fs * 0.6` samples of the frontal channels (band-passed
    1–45 Hz). A blink fires when the peak in the last 250 ms exceeds both an absolute floor and
    `k` × robust noise (MAD) of the preceding 2 s, with a refractory period.
    """

    def __init__(self, fs: float, threshold_uv: float = 40.0, k: float = 5.0, refractory_s: float = 0.45):
        self.fs, self.threshold_uv, self.k, self.refractory_s = fs, threshold_uv, k, refractory_s
        self.last_t = -1e9
        self.count = 0

    def update(self, frontal: np.ndarray, t: float) -> bool:
        """frontal: (channels, samples) filtered µV, newest sample last; t: seconds."""
        frontal = np.atleast_2d(np.asarray(frontal, dtype=float))
        if frontal.size == 0 or frontal.shape[1] < int(self.fs * 0.6):
            return False
        recent = frontal[:, -int(0.25 * self.fs):]
        base = frontal[:, -int(2.0 * self.fs):-int(0.3 * self.fs)] if frontal.shape[1] > int(0.9 * self.fs) else frontal
        mad = np.median(np.abs(base - np.median(base, axis=1, keepdims=True)), axis=1) * 1.4826 + 1e-6
        peak = np.max(np.abs(recent), axis=1)
        hit = bool(np.any((peak > self.threshold_uv) & (peak > self.k * mad)))
        if hit and t - self.last_t > self.refractory_s:
            self.last_t = t
            self.count += 1
            return True
        return False


class AlphaDetector:
    """Eyes-closed state from occipital alpha (Berger effect).

    Tracks the occipital alpha fraction (8–13 Hz / 1–45 Hz power) with an adaptive baseline taken
    from the lower quantile of recent history (eyes-open periods dominate a waking recording), on an
    exponentially smoothed estimate. state: "eyes_closed" when alpha ≥ `ratio` × baseline and
    ≥ `min_fraction`, with hysteresis;
    "eyes_open" otherwise; "unknown" until there is enough data or no occipital channel.
    """

    def __init__(self, ratio: float = 2.0, min_fraction: float = 0.35, history_s: float = 60.0, update_hz: float = 4.0,
                 smoothing: float = 0.35):
        self.ratio, self.min_fraction, self.smoothing = ratio, min_fraction, smoothing
        self.history: deque[float] = deque(maxlen=int(history_s * update_hz))
        self.state = "unknown"
        self.alpha = 0.0
        self.baseline: float | None = None

    @staticmethod
    def fraction(x: np.ndarray, fs: float) -> float:
        x = np.asarray(x, dtype=float)
        x = x - x.mean()
        spec = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
        f = np.fft.rfftfreq(len(x), 1 / fs)
        return float(spec[(f >= 8) & (f < 13)].sum() / (spec[(f >= 1) & (f < 45)].sum() + 1e-12))

    def update(self, occipital: np.ndarray, fs: float) -> str:
        occipital = np.atleast_2d(np.asarray(occipital, dtype=float))
        if occipital.size == 0 or occipital.shape[1] < 2 * fs:
            return self.state
        instant = float(np.mean([self.fraction(ch[-int(2 * fs):], fs) for ch in occipital]))
        # exponential smoothing (~1 s at 4 Hz) suppresses 2-s-window variance of eyes-open alpha
        self.alpha = instant if not self.history else (1 - self.smoothing) * self.alpha + self.smoothing * instant
        self.history.append(self.alpha)
        if len(self.history) < 8:
            self.baseline = None
            self.state = "unknown"
            return self.state
        self.baseline = float(max(np.quantile(np.asarray(self.history), 0.2), 0.03))
        enter = self.alpha >= max(self.ratio * self.baseline, self.min_fraction)
        stay = self.alpha >= max(0.75 * self.ratio * self.baseline, 0.75 * self.min_fraction)
        self.state = "eyes_closed" if (enter or (self.state == "eyes_closed" and stay)) else "eyes_open"
        return self.state

    def to_json(self) -> dict:
        return {"alpha_state": self.state, "alpha_fraction": round(self.alpha, 4),
                "alpha_baseline": None if self.baseline is None else round(self.baseline, 4)}


def detect_serial_ports() -> list[str]:
    """Candidate OpenBCI dongle ports (FTDI). macOS prefers /dev/cu.* (non-blocking open)."""
    if sys.platform == "darwin":
        pats = ["/dev/cu.usbserial-*", "/dev/cu.usbmodem*"]
    elif sys.platform.startswith("linux"):
        pats = ["/dev/ttyUSB*", "/dev/ttyACM*"]
    else:
        pats = []
    ports: list[str] = []
    for p in pats:
        ports += sorted(glob.glob(p))
    if sys.platform.startswith("win"):
        try:
            from serial.tools import list_ports  # optional pyserial

            ports = [p.device for p in list_ports.comports() if "FTDI" in (p.manufacturer or "") or "USB" in (p.description or "")]
        except ImportError:
            pass
    return ports


def explain_board_error(exc: Exception, board: str, port: str) -> str:
    """Turn BrainFlow's terse errors into an actionable message."""
    text = str(exc)
    low = text.lower()
    if board.startswith("cyton") or board == "ganglion":
        if "unable_to_open_port" in low or "unable to open port" in low or "resource busy" in low or "port_busy" in low:
            return (f"Cannot open serial port {port or '(none)'}: it is missing or busy. Close the OpenBCI GUI (only one "
                    "program can hold the dongle), re-plug the USB dongle, and check `ls /dev/cu.usbserial*`.")
        if "board_not_ready" in low or "board not ready" in low or "no data" in low or "timeout" in low:
            return ("The dongle opened but the board did not answer. Turn the board on (switch to PC, not OFF/BLE), "
                    "make sure the dongle switch is on GPIO_6, and that the board battery is charged.")
    if "ganglion" in board and ("ble" in low or "bluetooth" in low or "mac" in low):
        return ("Ganglion over BLE failed: grant Bluetooth permission to your terminal (System Settings → Privacy → "
                "Bluetooth), make sure the Ganglion's blue LED is blinking, or pass --mac-address.")
    if "invalid_arguments" in low or "invalid arguments" in low:
        return f"BrainFlow rejected the parameters for board '{board}': {text}"
    return f"{board}: {text}"
