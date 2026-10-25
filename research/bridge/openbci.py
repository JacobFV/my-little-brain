"""cortex² OpenBCI bridge: BrainFlow acquisition on your laptop → the lab.

  * ws://127.0.0.1:8765   ~20 Hz frames for the browser (lowest latency; same machine as the headset)
  * cloud (optional)      2 Hz summary frames to the deployed API using a device token from the lab
  * recordings            `--record 30` or a {"type":"record"} message from the lab uploads ≤60 s for inverse modelling

Examples
  python openbci.py --board synthetic                                  # no hardware
  python openbci.py --board cyton --serial-port /dev/cu.usbserial-XXXX # Cyton dongle (macOS)
  python openbci.py --board ganglion --mac-address XX:XX:...           # Ganglion (native BLE)
  CORTEX_API=https://cortex2-….run.app CORTEX_INGEST_TOKEN=… python openbci.py --board cyton --serial-port … --cloud

Band powers and blink detection are for visualisation, not clinical interpretation.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import threading
import time
from collections import deque

import numpy as np
import requests
from brainflow.board_shim import BoardIds, BoardShim, BrainFlowInputParams
from scipy.signal import butter, iirnotch, sosfilt, sosfilt_zi, tf2sos

BOARDS = {
    "synthetic": BoardIds.SYNTHETIC_BOARD.value,
    "cyton": BoardIds.CYTON_BOARD.value,
    "cyton-daisy": BoardIds.CYTON_DAISY_BOARD.value,
    "ganglion": BoardIds.GANGLION_BOARD.value,
    "ganglion-native": BoardIds.GANGLION_NATIVE_BOARD.value,
    "cyton-wifi": BoardIds.CYTON_WIFI_BOARD.value,
    "playback": BoardIds.PLAYBACK_FILE_BOARD.value,
}
# Default Ultracortex electrode positions.
DEFAULT_CHANNELS = {
    "cyton": "Fp1,Fp2,C3,C4,P7,P8,O1,O2",
    "cyton-wifi": "Fp1,Fp2,C3,C4,P7,P8,O1,O2",
    "cyton-daisy": "Fp1,Fp2,C3,C4,P7,P8,O1,O2,F7,F8,F3,F4,T7,T8,P3,P4",
    "ganglion": "Fp1,Fp2,O1,O2",
    "ganglion-native": "Fp1,Fp2,O1,O2",
    "synthetic": "Fp1,Fp2,C3,C4,P7,P8,O1,O2,F7,F8,F3,F4,T7,T8,P3,P4",
    "playback": "Fp1,Fp2,C3,C4,P7,P8,O1,O2",
}
BANDS = {"delta": (1, 4), "theta": (4, 8), "alpha": (8, 13), "beta": (13, 30), "gamma": (30, 45)}
FRONTAL = ("fp1", "fp2", "af7", "af8", "f7", "f8")


class Filters:
    """Causal 1–45 Hz band-pass + mains notch per channel, streaming state preserved between chunks."""

    def __init__(self, fs: float, n: int, mains: float):
        sos = butter(4, [1.0, min(45.0, fs / 2 - 1)], btype="band", fs=fs, output="sos")
        if mains and mains < fs / 2:
            b, a = iirnotch(mains, 30.0, fs)
            sos = np.vstack([sos, tf2sos(b, a)])
        self.sos = sos
        self.zi: np.ndarray | None = None  # (sections, channels, 2), seeded from the first sample

    def __call__(self, x: np.ndarray) -> np.ndarray:  # x: (channels, samples)
        if self.zi is None:
            self.zi = sosfilt_zi(self.sos)[:, None, :] * x[None, :, 0, None]
        y = np.empty_like(x)
        for c in range(x.shape[0]):
            y[c], self.zi[:, c, :] = sosfilt(self.sos, x[c], zi=self.zi[:, c, :])
        return y


def bandpowers(x: np.ndarray, fs: float) -> dict:
    x = x - x.mean()
    if len(x) < fs:
        return {}
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / fs)
    total = spec[(f >= 1) & (f < 45)].sum() + 1e-12
    out = {k: round(float(100 * spec[(f >= a) & (f < b)].sum() / total), 2) for k, (a, b) in BANDS.items()}
    out["rms_uv"] = round(float(np.sqrt(np.mean(x ** 2))), 2)
    return out


class Bridge:
    def __init__(self, args):
        self.args = args
        self.board_id = BOARDS[args.board]
        p = BrainFlowInputParams()
        p.serial_port, p.mac_address, p.ip_address = args.serial_port, args.mac_address, args.ip_address
        if args.board == "playback":
            p.file = args.file
            p.master_board = BoardIds.CYTON_BOARD.value
        self.board = BoardShim(self.board_id, p)
        desc_id = p.master_board if args.board == "playback" else self.board_id
        self.fs = float(BoardShim.get_sampling_rate(desc_id))
        self.eeg_rows = BoardShim.get_eeg_channels(desc_id)
        names = (args.channels or DEFAULT_CHANNELS.get(args.board, "")).split(",")
        self.names = [n.strip() for n in names if n.strip()][: len(self.eeg_rows)]
        self.names += [f"ch{i + 1}" for i in range(len(self.names), len(self.eeg_rows))]
        self.filters = Filters(self.fs, len(self.eeg_rows), args.mains)
        self.buffer = deque(maxlen=int(self.fs * 64))  # filtered (channels,) columns, ≥60 s for recordings
        self.pending: list[np.ndarray] = []
        self.lock = threading.Lock()
        self.last_blink = 0.0
        self.blink_count = 0
        self.clients: set = set()
        self.recording: dict | None = None
        self.stop = threading.Event()
        self.http = requests.Session()

    # ---- acquisition thread
    def acquire(self):
        self.board.prepare_session()
        self.board.start_stream(45000)
        print(f"streaming {self.args.board} at {self.fs:.0f} Hz, channels {', '.join(self.names)}")
        try:
            while not self.stop.is_set():
                time.sleep(0.04)
                data = self.board.get_board_data()
                if data.shape[1] == 0:
                    continue
                raw = np.asarray(data[self.eeg_rows], dtype=float)
                filt = self.filters(raw)
                with self.lock:
                    for col in filt.T:
                        self.buffer.append(col)
                    self.pending.append(filt)
        finally:
            self.board.stop_stream()
            self.board.release_session()

    def window(self, seconds: float) -> np.ndarray:
        with self.lock:
            n = min(len(self.buffer), int(seconds * self.fs))
            return np.array(list(self.buffer)[-n:]).T if n else np.zeros((len(self.names), 0))

    def quality(self, w: np.ndarray) -> list[str]:
        out = []
        for ch in w:
            if ch.size == 0:
                out.append("no data")
            elif np.std(ch) < 0.3:
                out.append("flat")
            elif np.max(np.abs(ch)) > 1500:
                out.append("railed/noisy")
            else:
                out.append("ok")
        return out

    def detect_blink(self, w: np.ndarray) -> bool:
        idx = [i for i, n in enumerate(self.names) if n.lower() in FRONTAL]
        if not idx or w.shape[1] < self.fs * 0.6:
            return False
        recent = w[idx, -int(0.25 * self.fs):]
        base = w[idx, -int(2 * self.fs):]
        mad = np.median(np.abs(base - np.median(base, axis=1, keepdims=True)), axis=1) + 1e-6
        peak = np.max(np.abs(recent), axis=1)
        now = time.time()
        if np.any((peak > self.args.blink_uv) & (peak > 6 * 1.4826 * mad)) and now - self.last_blink > 0.45:
            self.last_blink = now
            self.blink_count += 1
            return True
        return False

    def frame(self, new: np.ndarray) -> dict:
        w = self.window(2.0)
        step = max(1, int(self.fs // 125))
        per = [bandpowers(ch, self.fs) for ch in w]
        avg = {k: round(float(np.mean([p[k] for p in per if p])), 2) if any(per) else 0.0 for k in list(BANDS) + ["rms_uv"]}
        return {"type": "frame", "t": time.time(), "board": self.args.board, "fs": self.fs / step,
                "channel_names": self.names, "samples": [[round(float(v), 2) for v in ch[::step]] for ch in new],
                "bands": avg, "per_channel_bands": per, "blink": self.detect_blink(w), "blink_count": self.blink_count,
                "quality": self.quality(w), "recording": bool(self.recording)}

    # ---- cloud
    def cloud_enabled(self) -> bool:
        return bool(self.args.cloud and os.environ.get("CORTEX_API") and os.environ.get("CORTEX_INGEST_TOKEN"))

    def post(self, path: str, payload: dict, timeout=15) -> dict:
        r = self.http.post(os.environ["CORTEX_API"].rstrip("/") + path, json=payload, timeout=timeout,
                           headers={"Authorization": f"Bearer {os.environ['CORTEX_INGEST_TOKEN']}"})
        if r.status_code >= 400:
            raise RuntimeError(f"{path} → {r.status_code}: {r.text[:200]}")
        return r.json()

    def cloud_loop(self):
        while not self.stop.is_set():
            time.sleep(0.5)
            w = self.window(1.0)
            if w.shape[1] < self.fs * 0.5:
                continue
            step = max(1, int(self.fs // 125))
            f = self.frame(np.zeros((len(self.names), 0)))
            try:
                self.post("/v1/eeg/ingest", {**{k: f[k] for k in ("board", "channel_names", "bands", "per_channel_bands", "blink")},
                                             "fs": self.fs / step, "quality": ",".join(f["quality"]),
                                             "samples": [[round(float(v), 2) for v in ch[::step]][-256:] for ch in w]}, timeout=5)
            except Exception as exc:
                print(f"cloud ingest failed: {exc}")

    def record_and_upload(self, seconds: float, label: str) -> str:
        seconds = float(min(max(seconds, 4), 60))
        self.recording = {"label": label, "seconds": seconds}
        print(f"recording '{label}' for {seconds:.0f} s …")
        time.sleep(seconds + 0.3)
        w = self.window(seconds)
        self.recording = None
        step = max(1, int(np.ceil(self.fs / 250)))
        chans = list(range(min(8, len(self.names))))
        payload = {"label": label, "fs": self.fs / step, "channel_names": [self.names[i] for i in chans],
                   "data": [[round(float(v), 3) for v in w[i, ::step]] for i in chans]}
        if not self.cloud_enabled():
            path = f"recording-{int(time.time())}.json"
            with open(path, "w") as fh:
                json.dump(payload, fh)
            raise RuntimeError(f"cloud upload not configured (--cloud, CORTEX_API, CORTEX_INGEST_TOKEN); saved {path}")
        rid = self.post("/v1/eeg/recordings", payload, timeout=60)["recording_id"]
        print(f"uploaded recording {rid}")
        return rid

    # ---- websocket
    async def ws_handler(self, ws):
        self.clients.add(ws)
        try:
            await ws.send(json.dumps({"type": "hello", "board": self.args.board, "fs": self.fs, "channel_names": self.names,
                                      "cloud": self.cloud_enabled()}))
            async for msg in ws:
                try:
                    m = json.loads(msg)
                except ValueError:
                    continue
                if m.get("type") == "record":
                    loop = asyncio.get_running_loop()
                    async def run(m=m):
                        try:
                            rid = await loop.run_in_executor(None, self.record_and_upload, float(m.get("seconds", 30)), str(m.get("label", "lab recording"))[:120])
                            await ws.send(json.dumps({"type": "recording", "recording_id": rid}))
                        except Exception as exc:
                            await ws.send(json.dumps({"type": "error", "message": str(exc)}))
                    asyncio.create_task(run())
        finally:
            self.clients.discard(ws)

    async def broadcast(self):
        while not self.stop.is_set():
            await asyncio.sleep(0.05)
            with self.lock:
                chunks, self.pending = self.pending, []
            if not chunks or not self.clients:
                continue
            msg = json.dumps(self.frame(np.hstack(chunks)))
            for ws in list(self.clients):
                try:
                    await ws.send(msg)
                except Exception:
                    self.clients.discard(ws)

    async def serve(self):
        import websockets

        allowed = [o for o in self.args.allow_origin.split(",") if o] or None
        async with websockets.serve(self.ws_handler, "127.0.0.1", self.args.ws_port, origins=allowed, max_size=2**20):
            print(f"lab websocket on ws://127.0.0.1:{self.args.ws_port}")
            await self.broadcast()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", choices=BOARDS, default="synthetic")
    ap.add_argument("--serial-port", default="")
    ap.add_argument("--mac-address", default="")
    ap.add_argument("--ip-address", default="")
    ap.add_argument("--file", default="", help="BrainFlow CSV for --board playback")
    ap.add_argument("--channels", default="", help="comma-separated electrode names in channel order")
    ap.add_argument("--mains", type=float, default=60.0, help="notch frequency (50 in EU/Asia, 0 to disable)")
    ap.add_argument("--blink-uv", type=float, default=80.0, help="frontal blink threshold (µV)")
    ap.add_argument("--ws-port", type=int, default=8765)
    ap.add_argument("--allow-origin", default="", help="restrict browser origins (comma-separated); default any")
    ap.add_argument("--cloud", action="store_true", help="also stream summaries to CORTEX_API with CORTEX_INGEST_TOKEN")
    ap.add_argument("--record", type=float, default=0, help="record N seconds (≤60) after a 3 s settle, upload, and keep streaming")
    ap.add_argument("--label", default="openbci recording")
    args = ap.parse_args()
    BoardShim.disable_board_logger()
    bridge = Bridge(args)
    threading.Thread(target=bridge.acquire, daemon=True).start()
    if bridge.cloud_enabled():
        threading.Thread(target=bridge.cloud_loop, daemon=True).start()
        print("cloud streaming enabled")
    if args.record:
        def rec():
            time.sleep(3)
            try:
                bridge.record_and_upload(args.record, args.label)
            except Exception as exc:
                print(exc)
        threading.Thread(target=rec, daemon=True).start()
    signal.signal(signal.SIGINT, lambda *_: bridge.stop.set())
    try:
        asyncio.run(bridge.serve())
    finally:
        bridge.stop.set()


if __name__ == "__main__":
    main()
