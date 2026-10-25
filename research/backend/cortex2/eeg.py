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

DATA_DIR = Path(os.environ.get("CORTEX_DATASETS", Path(__file__).resolve().parents[2] / "data"))


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
