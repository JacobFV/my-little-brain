"""Recorded EEG: CHB-MIT excerpt loading, preprocessing, OpenBCI recordings and display summaries.

CHB-MIT Scalp EEG Database (Shoeb 2009; Goldberger et al. 2000, PhysioNet), ODC-By 1.0.
Only a short excerpt around one annotated seizure is bundled (see data/chbmit/README.md).
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import neural as nm

DATA_DIR = Path((os.environ.get("CORTEX_DATASETS") or Path(__file__).resolve().parents[2] / "data"))


# Per-signal header fields: (name, width). Field k for signal i starts at 256 + ns*offset_k + width_k*i.
_EDF_FIELDS = (("label", 16), ("transducer", 80), ("dimension", 8), ("pmin", 8), ("pmax", 8),
               ("dmin", 8), ("dmax", 8), ("prefilter", 80), ("spr", 8), ("reserved", 32))


def read_edf_header(raw: bytes) -> dict:
    ns = int(raw[252:256])
    fields, offset = {}, 0
    for name, width in _EDF_FIELDS:
        fields[name] = [raw[256 + ns * offset + width * i: 256 + ns * offset + width * (i + 1)].decode("ascii", "replace").strip()
                        for i in range(ns)]
        offset += width
    num = lambda k, t=float: [t(v) for v in fields[k]]
    return {"header_bytes": int(raw[184:192]), "records": int(raw[236:244]), "record_seconds": float(raw[244:252]),
            "signals": ns, "labels": fields["label"], "pmin": num("pmin"), "pmax": num("pmax"),
            "dmin": num("dmin"), "dmax": num("dmax"), "spr": num("spr", int)}


def decode_edf_records(header: dict, block: bytes) -> np.ndarray:
    """Decode whole data records (all signals equal sample rate) → (channels, samples) physical units."""
    ns, spr = header["signals"], header["spr"][0]
    ints = np.frombuffer(block, dtype="<i2").reshape(-1, ns, spr)
    digital = ints.transpose(1, 0, 2).reshape(ns, -1).astype(np.float64)
    gain = (np.array(header["pmax"]) - header["pmin"]) / (np.array(header["dmax"]) - header["dmin"])
    return (digital - np.array(header["dmin"])[:, None]) * gain[:, None] + np.array(header["pmin"])[:, None]


def preprocess(x: np.ndarray, fs: float, notch: float | None = 60.0) -> np.ndarray:
    """Zero-phase 1–45 Hz band-pass and optional mains notch."""
    from scipy.signal import butter, filtfilt, iirnotch

    x = np.asarray(x, dtype=float)
    b, a = butter(4, [1.0 / (fs / 2), min(45.0, fs / 2 - 1) / (fs / 2)], btype="band")
    y = filtfilt(b, a, x, axis=-1)
    if notch and notch < fs / 2:
        bn, an = iirnotch(notch, 30.0, fs)
        y = filtfilt(bn, an, y, axis=-1)
    return y


@lru_cache(maxsize=1)
def datasets() -> list[dict]:
    out = []
    for meta_path in sorted((DATA_DIR / "chbmit").glob("*.json")):
        meta = json.loads(meta_path.read_text())
        meta["path"] = str(meta_path.with_suffix(".npz"))
        out.append(meta)
    return out


def dataset(dataset_id: str) -> dict:
    for d in datasets():
        if d["id"] == dataset_id:
            return d
    raise KeyError(f"unknown dataset {dataset_id!r}")


@lru_cache(maxsize=4)
def _load(path: str) -> np.ndarray:
    return np.load(path)["data"].astype(np.float64)


def segment(dataset_id: str, channel: str, segment_name: str) -> tuple[np.ndarray, float, dict]:
    d = dataset(dataset_id)
    if channel not in d["channels"]:
        raise KeyError(f"channel {channel!r} not in {dataset_id}")
    seg = d["segments"][segment_name]
    data = _load(d["path"])
    fs = float(d["fs"])
    i0 = int((seg["start"] - d["excerpt_start"]) * fs)
    i1 = int((seg["end"] - d["excerpt_start"]) * fs)
    x = preprocess(data[d["channels"].index(channel)], fs)[i0:i1]
    return x, fs, {"dataset_id": dataset_id, "channel": channel, "segment": segment_name, **seg,
                   "citation": d["citation"], "license": d["license"]}


def summarize_frame(samples: list[list[float]], fs: float) -> dict:
    """Band powers of a short multichannel window (display only)."""
    per = []
    for ch in samples:
        x = np.asarray(ch, dtype=float)
        per.append(nm.band_powers(x, fs) if len(x) >= fs else {})
    keys = nm.CLASSIC_BANDS.keys()
    avg = {k: float(np.mean([p[k] for p in per if p])) if any(per) else 0.0 for k in keys}
    return {"bands": avg, "per_channel_bands": per}


# ---------------------------------------------------------------- multichannel sources (spectrogram triage)

def load_source(uid: str, dataset_id: str | None = None, recording_id: str | None = None,
                start: float | None = None, end: float | None = None) -> dict:
    """Preprocessed multichannel EEG for a CHB-MIT excerpt or an OpenBCI recording, optionally windowed.

    Times are seconds in the source's own clock (CHB-MIT: seconds into the EDF file).
    """
    if dataset_id:
        d = dataset(dataset_id)
        fs = float(d["fs"])
        raw = _load(d["path"])
        t0 = float(d["excerpt_start"])
        names = list(d["channels"])
        events = [{"label": "seizure", "start": s["start"], "end": s["end"]} for s in d.get("seizures", [])]
        label = d["label"]
    elif recording_id:
        from .store import artifacts, store

        rec = store().get("eeg_recordings", recording_id)
        if not rec or rec.get("owner") != uid:
            raise KeyError("recording not found")
        data = rec.get("data") if rec.get("data") is not None else artifacts().get_json(rec["data_path"])
        if data is None:
            raise KeyError("recording data missing")
        raw = np.asarray(data, dtype=float)
        fs = float(rec["fs"])
        t0, names, events, label = 0.0, list(rec["channel_names"]), [], f"OpenBCI · {rec['label']}"
    else:
        raise ValueError("give dataset_id or recording_id")
    total = raw.shape[1] / fs
    a = max(t0, float(start) if start is not None else t0)
    b = min(t0 + total, float(end) if end is not None else t0 + total)
    if b - a < 4:
        raise ValueError(f"window must be ≥4 s inside [{t0:.0f}, {t0 + total:.0f}] s")
    x = preprocess(raw, fs)[:, int((a - t0) * fs): int((b - t0) * fs)]
    return {"data": x, "fs": fs, "names": names, "start": a, "end": b, "events": events, "label": label,
            "dataset_id": dataset_id, "recording_id": recording_id, "bounds": [t0, t0 + total]}


def channel_summary(x: np.ndarray, fs: float, names: list[str], start: float, window: float = 4.0) -> list[dict]:
    """Per-channel numbers that accompany the spectrogram image: band powers and their largest change over time."""
    out = []
    step = int(window * fs)
    for name, ch in zip(names, x):
        wins = [ch[i:i + step] for i in range(0, len(ch) - step + 1, step)] or [ch]
        bands = [nm.band_powers(w, fs) for w in wins]
        rms = [float(np.sqrt(np.mean(w ** 2))) for w in wins]
        dom = {k: float(np.mean([b[k] for b in bands])) for k in nm.CLASSIC_BANDS}
        peak_rms = int(np.argmax(rms))
        out.append({"channel": name, "mean_band_pct": {k: round(v, 1) for k, v in dom.items()},
                    "rms_uv_median": round(float(np.median(rms)), 1), "rms_uv_max": round(max(rms), 1),
                    "rms_peak_time_s": round(start + peak_rms * window, 1),
                    "rms_ratio_max_over_median": round(float(max(rms) / (np.median(rms) + 1e-9)), 2)})
    return out
