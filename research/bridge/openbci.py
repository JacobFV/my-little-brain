"""cortex² OpenBCI bridge: BrainFlow acquisition on your laptop → the lab.

  * ws://127.0.0.1:8765   ~20 Hz frames for the browser (lowest latency; same machine as the headset)
  * cloud (optional)      2 Hz summary frames to the deployed API using a device token from the lab
  * recordings            `--record 30` or a {"type":"record"} message from the lab uploads ≤60 s for inverse modelling

Examples
  python openbci.py --board synthetic                       # BrainFlow's synthetic board, no hardware
  python openbci.py --board playback                        # realistic Cyton demo recording (blinks + eyes-closed alpha)
  python openbci.py --board cyton                           # Cyton dongle, serial port auto-detected on macOS/Linux
  python openbci.py --board cyton --serial-port /dev/cu.usbserial-DM00XXXX
  python openbci.py --board ganglion-native                 # Ganglion over the laptop's Bluetooth
  python openbci.py --list-ports
  CORTEX_API=https://cortex2-….run.app CORTEX_INGEST_TOKEN=… python openbci.py --board cyton --cloud

Band powers, blink and eyes-closed detection are for visualisation, not clinical interpretation.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from signals import (  # noqa: E402
    FRONTAL, OCCIPITAL, AlphaDetector, BlinkDetector, Filters, average_bands, bandpowers, channel_quality,
    detect_serial_ports, explain_board_error, line_noise_ratio,
)

BOARD_NAMES = ("synthetic", "cyton", "cyton-daisy", "ganglion", "ganglion-native", "cyton-wifi", "playback")
DEFAULT_CHANNELS = {
    "cyton": "Fp1,Fp2,C3,C4,P7,P8,O1,O2",
    "cyton-wifi": "Fp1,Fp2,C3,C4,P7,P8,O1,O2",
    "cyton-daisy": "Fp1,Fp2,C3,C4,P7,P8,O1,O2,F7,F8,F3,F4,T7,T8,P3,P4",
    "ganglion": "Fp1,Fp2,O1,O2",
    "ganglion-native": "Fp1,Fp2,O1,O2",
    "synthetic": "Fp1,Fp2,C3,C4,P7,P8,O1,O2,F7,F8,F3,F4,T7,T8,P3,P4",
    "playback": "Fp1,Fp2,C3,C4,P7,P8,O1,O2",
}
SERIAL_BOARDS = ("cyton", "cyton-daisy", "ganglion")
RECORD_MAX_S = 60.0
STALL_SECONDS = 5.0


def board_id(name: str) -> int:
    from brainflow.board_shim import BoardIds

    return {
        "synthetic": BoardIds.SYNTHETIC_BOARD, "cyton": BoardIds.CYTON_BOARD, "cyton-daisy": BoardIds.CYTON_DAISY_BOARD,
        "ganglion": BoardIds.GANGLION_BOARD, "ganglion-native": BoardIds.GANGLION_NATIVE_BOARD,
        "cyton-wifi": BoardIds.CYTON_WIFI_BOARD, "playback": BoardIds.PLAYBACK_FILE_BOARD,
    }[name].value


class Ring:
    """Fixed-size (channels × N) ring buffer with chronological reads."""

    def __init__(self, channels: int, size: int):
        self.buf = np.zeros((channels, size))
        self.size, self.n, self.i = size, 0, 0
        self.lock = threading.Lock()

    def push(self, x: np.ndarray) -> None:
        with self.lock:
            m = x.shape[1]
            if m >= self.size:
                self.buf[:] = x[:, -self.size:]
                self.i, self.n = 0, self.size
                return
            end = self.i + m
            if end <= self.size:
                self.buf[:, self.i:end] = x
            else:
                k = self.size - self.i
                self.buf[:, self.i:] = x[:, :k]
                self.buf[:, :m - k] = x[:, k:]
            self.i = end % self.size
            self.n = min(self.size, self.n + m)

    def last(self, samples: int) -> np.ndarray:
        with self.lock:
            samples = min(samples, self.n)
            if samples == 0:
                return np.zeros((self.buf.shape[0], 0))
            idx = (np.arange(self.i - samples, self.i)) % self.size
            return self.buf[:, idx].copy()


class Bridge:
    def __init__(self, args):
        from brainflow.board_shim import BoardIds, BoardShim

        self.args = args
        self.board_name = args.board
        self.board_id = board_id(args.board)
        self.desc_id = BoardIds.CYTON_BOARD.value if args.board == "playback" else self.board_id
        self.fs = float(BoardShim.get_sampling_rate(self.desc_id))
        self.eeg_rows = BoardShim.get_eeg_channels(self.desc_id)
        names = [n.strip() for n in (args.channels or DEFAULT_CHANNELS.get(args.board, "")).split(",") if n.strip()]
        if args.max_channels:
            self.eeg_rows = self.eeg_rows[: args.max_channels]
        self.names = (names + [f"ch{i + 1}" for i in range(len(names), len(self.eeg_rows))])[: len(self.eeg_rows)]
        n = len(self.eeg_rows)
        self.filters = Filters(self.fs, n, args.mains)
        self.raw = Ring(n, int(self.fs * 64))
        self.filt = Ring(n, int(self.fs * 64))
        self.pending: list[np.ndarray] = []
        self.pending_lock = threading.Lock()
        self.blink = BlinkDetector(self.fs, threshold_uv=args.blink_uv)
        self.alpha = AlphaDetector()
        self.frontal = [i for i, c in enumerate(self.names) if c.lower() in FRONTAL]
        self.occipital = [i for i, c in enumerate(self.names) if c.lower() in OCCIPITAL]
        self.state = "starting"
        self.state_message = ""
        self.events: list[dict] = []            # status / recording messages for WS clients
        self.events_lock = threading.Lock()
        self.recording: dict | None = None
        self.stop = threading.Event()
        self.http = requests.Session()
        self.samples_total = 0
        self.serial_port = args.serial_port
        self.last_analysis: dict = {}
        self._alpha_t = 0.0

    # ---- status
    def set_state(self, state: str, message: str = "") -> None:
        if (state, message) != (self.state, self.state_message):
            self.state, self.state_message = state, message
            print(f"[{state}] {message}".rstrip(), flush=True)
            self.emit({"type": "status", "state": state, "message": message, "board": self.board_name,
                       "serial_port": self.serial_port or None})

    def emit(self, msg: dict) -> None:
        with self.events_lock:
            self.events.append(msg)

    # ---- acquisition (thread) with reconnect
    def _params(self):
        from brainflow.board_shim import BoardIds, BrainFlowInputParams

        p = BrainFlowInputParams()
        if self.board_name in SERIAL_BOARDS and not self.serial_port:
            ports = detect_serial_ports()
            if not ports:
                raise RuntimeError("No OpenBCI USB dongle found (looked for /dev/cu.usbserial-*). Plug in the dongle, "
                                   "or pass --serial-port.")
            self.serial_port = ports[0]
            if len(ports) > 1:
                print(f"multiple serial ports {ports}; using {self.serial_port} (override with --serial-port)")
        p.serial_port = self.serial_port or ""
        p.mac_address = self.args.mac_address
        p.ip_address = self.args.ip_address
        if self.board_name == "playback":
            from fixture import ensure_playback

            p.file = self.args.file or str(ensure_playback())
            p.master_board = BoardIds.CYTON_BOARD.value
        return p

    def _open(self):
        from brainflow.board_shim import BoardShim

        board = BoardShim(self.board_id, self._params())
        try:
            board.prepare_session()
            if self.board_name == "playback":
                board.config_board("loopback_true")
            board.start_stream(45000)
        except Exception as exc:
            try:
                board.release_session()
            except Exception:
                pass
            raise RuntimeError(explain_board_error(exc, self.board_name, self.serial_port or "")) from exc
        return board

    def acquire(self) -> None:
        backoff = 1.0
        while not self.stop.is_set():
            board = None
            try:
                self.set_state("connecting", f"{self.board_name} {self.serial_port or self.args.mac_address or ''}".strip())
                board = self._open()
                self.filters.reset()
                self.set_state("streaming", f"{self.board_name} at {self.fs:.0f} Hz · {', '.join(self.names)}")
                backoff = 1.0
                last_data = time.monotonic()
                while not self.stop.is_set():
                    time.sleep(0.04)
                    data = board.get_board_data()
                    if data.shape[1] == 0:
                        if time.monotonic() - last_data > STALL_SECONDS:
                            raise RuntimeError(f"no samples for {STALL_SECONDS:.0f} s (board off, out of range or battery low)")
                        continue
                    last_data = time.monotonic()
                    raw = np.asarray(data[self.eeg_rows], dtype=float)
                    filt = self.filters(raw)
                    self.raw.push(raw)
                    self.filt.push(filt)
                    self.samples_total += raw.shape[1]
                    with self.pending_lock:
                        self.pending.append(filt)
            except Exception as exc:
                if self.stop.is_set():
                    break
                self.set_state("reconnecting", f"{exc} — retrying in {backoff:.0f} s")
                self.stop.wait(backoff)
                backoff = min(backoff * 2, 15.0)
            finally:
                if board is not None:
                    try:
                        board.stop_stream()
                    except Exception:
                        pass
                    try:
                        board.release_session()
                    except Exception:
                        pass
        self.set_state("stopped", "")

    # ---- analysis
    def analysis(self) -> dict:
        w = self.filt.last(int(2 * self.fs))
        r = self.raw.last(int(2 * self.fs))
        per = [bandpowers(ch, self.fs) for ch in w]
        quality = [channel_quality(r[i], w[i]) for i in range(len(self.names))] if w.shape[1] else ["no data"] * len(self.names)
        line = [round(line_noise_ratio(r[i], self.fs, self.args.mains), 3) for i in range(len(self.names))] if r.shape[1] else []
        now = time.monotonic()
        blink = self.blink.update(self.filt.last(int(2.5 * self.fs))[self.frontal], now) if self.frontal else False
        if self.occipital and now - self._alpha_t >= 0.25:          # AlphaDetector assumes ~4 Hz updates
            self._alpha_t = now
            self.alpha.update(self.filt.last(int(2 * self.fs))[self.occipital], self.fs)
        self.last_analysis = {"per_channel_bands": per, "bands": average_bands(per), "quality": quality, "line_noise": line,
                "blink": blink, "blink_count": self.blink.count, **self.alpha.to_json()}
        return self.last_analysis

    def frame(self, new: np.ndarray) -> dict:
        step = max(1, int(self.fs // 125))
        return {"type": "frame", "t": time.time(), "board": self.board_name, "fs": self.fs / step,
                "channel_names": self.names, "samples": [[round(float(v), 2) for v in ch[::step]] for ch in new],
                **self.analysis(), "state": self.state,
                "recording": None if not self.recording else {k: self.recording[k] for k in ("label", "seconds", "elapsed")}}

    # ---- cloud
    def cloud_enabled(self) -> bool:
        return bool(self.args.cloud and os.environ.get("CORTEX_API") and os.environ.get("CORTEX_INGEST_TOKEN"))

    def post(self, path: str, payload: dict, timeout=15) -> dict:
        r = self.http.post(os.environ["CORTEX_API"].rstrip("/") + path, json=payload, timeout=timeout,
                           headers={"Authorization": f"Bearer {os.environ['CORTEX_INGEST_TOKEN']}"})
        if r.status_code in (401, 403):
            raise RuntimeError(f"cloud rejected the device token ({r.status_code}): create a new one in the lab sidebar")
        if r.status_code >= 400:
            raise RuntimeError(f"{path} → {r.status_code}: {r.text[:200]}")
        return r.json()

    def cloud_loop(self) -> None:
        failures = 0
        while not self.stop.is_set():
            self.stop.wait(0.5)
            if self.state != "streaming":
                continue
            w = self.filt.last(int(self.fs))
            if w.shape[1] < self.fs * 0.5:
                continue
            step = max(1, int(self.fs // 125))
            a = self.last_analysis
            if not a:
                continue
            try:
                self.post("/v1/eeg/ingest", {"board": self.board_name, "fs": self.fs / step, "channel_names": self.names,
                                             "samples": [[round(float(v), 2) for v in ch[::step]][-256:] for ch in w],
                                             "bands": a["bands"], "per_channel_bands": a["per_channel_bands"],
                                             "blink": a["blink"], "quality": ",".join(a["quality"])[:60]}, timeout=5)
                failures = 0
            except Exception as exc:
                failures += 1
                if failures in (1, 10) or failures % 60 == 0:
                    print(f"cloud ingest failed ({failures}×): {exc}")

    def record(self, seconds: float, label: str) -> str | None:
        """Blocking: capture `seconds` of filtered EEG, save locally, upload if cloud is configured."""
        seconds = float(min(max(seconds, 4.0), RECORD_MAX_S))
        if self.state != "streaming":
            raise RuntimeError(f"cannot record while {self.state}")
        start = self.samples_total
        self.recording = {"label": label, "seconds": seconds, "elapsed": 0.0}
        self.emit({"type": "recording_progress", "label": label, "seconds": seconds, "elapsed": 0.0})
        print(f"recording '{label}' for {seconds:.0f} s …")
        t0 = time.monotonic()
        while (self.samples_total - start) < seconds * self.fs:
            if self.stop.is_set():
                self.recording = None
                raise RuntimeError("bridge stopped")
            if time.monotonic() - t0 > seconds + 10:
                self.recording = None
                raise RuntimeError("stream stalled during recording")
            time.sleep(1.0)
            self.recording["elapsed"] = round(min(seconds, (self.samples_total - start) / self.fs), 1)
            self.emit({"type": "recording_progress", "label": label, "seconds": seconds, "elapsed": self.recording["elapsed"]})
        self.recording = None
        w = self.filt.last(int(seconds * self.fs))
        step = max(1, int(np.ceil(self.fs / 250)))
        chans = list(range(min(8, len(self.names))))
        payload = {"label": label, "fs": self.fs / step, "channel_names": [self.names[i] for i in chans],
                   "data": [[round(float(v), 3) for v in w[i, ::step]] for i in chans]}
        out_dir = Path(self.args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        local = out_dir / f"recording-{time.strftime('%Y%m%d-%H%M%S')}.json"
        local.write_text(json.dumps(payload))
        if not self.cloud_enabled():
            msg = f"saved {local} (cloud upload needs --cloud, CORTEX_API and CORTEX_INGEST_TOKEN)"
            print(msg)
            self.emit({"type": "recording", "recording_id": None, "path": str(local), "message": msg})
            return None
        rid = self.post("/v1/eeg/recordings", payload, timeout=60)["recording_id"]
        print(f"uploaded recording {rid} (local copy {local})")
        self.emit({"type": "recording", "recording_id": rid, "path": str(local), "message": f"uploaded as {rid}"})
        return rid

    # ---- websocket
    async def ws_handler(self, ws):
        self.clients.add(ws)
        try:
            await ws.send(json.dumps({"type": "hello", "board": self.board_name, "fs": self.fs, "channel_names": self.names,
                                      "cloud": self.cloud_enabled(), "state": self.state, "message": self.state_message,
                                      "serial_port": self.serial_port or None, "protocol": 2}))
            async for msg in ws:
                try:
                    m = json.loads(msg)
                except ValueError:
                    continue
                if m.get("type") == "record":
                    if self.recording:
                        await ws.send(json.dumps({"type": "error", "message": "a recording is already in progress"}))
                        continue
                    loop = asyncio.get_running_loop()

                    async def run(m=m):
                        try:
                            await loop.run_in_executor(None, self.record, float(m.get("seconds", 30)),
                                                       str(m.get("label", "lab recording"))[:120])
                        except Exception as exc:
                            self.emit({"type": "error", "message": f"recording failed: {exc}"})
                    asyncio.create_task(run())
                elif m.get("type") == "ping":
                    await ws.send(json.dumps({"type": "pong", "t": time.time()}))
        finally:
            self.clients.discard(ws)

    async def broadcast(self) -> None:
        while not self.stop.is_set():
            await asyncio.sleep(0.05)
            with self.events_lock:
                events, self.events = self.events, []
            with self.pending_lock:
                chunks, self.pending = self.pending, []
            msgs = [json.dumps(e) for e in events]
            if chunks:                                   # detectors run even with no browser attached
                frame = self.frame(np.hstack(chunks))
                if self.clients:
                    msgs.append(json.dumps(frame))
            for ws in list(self.clients):
                for msg in msgs:
                    try:
                        await ws.send(msg)
                    except Exception:
                        self.clients.discard(ws)
                        break

    async def serve(self) -> None:
        import websockets

        self.clients: set = set()
        allowed = [o for o in self.args.allow_origin.split(",") if o] or None
        try:
            server = await websockets.serve(self.ws_handler, "127.0.0.1", self.args.ws_port, origins=allowed, max_size=2 ** 20)
        except OSError as exc:
            raise SystemExit(f"port {self.args.ws_port} is in use (another bridge running?): {exc}") from exc
        print(f"lab websocket on ws://127.0.0.1:{self.args.ws_port}", flush=True)
        try:
            await self.broadcast()
        finally:
            server.close()
            await server.wait_closed()


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", choices=BOARD_NAMES, default="synthetic")
    ap.add_argument("--serial-port", default="", help="Cyton/Ganglion dongle; auto-detected if omitted")
    ap.add_argument("--mac-address", default="", help="Ganglion BLE address (optional)")
    ap.add_argument("--ip-address", default="", help="Cyton WiFi shield address")
    ap.add_argument("--file", default="", help="BrainFlow CSV for --board playback (default: generated demo fixture)")
    ap.add_argument("--channels", default="", help="comma-separated electrode names in channel order")
    ap.add_argument("--max-channels", type=int, default=0, help="only use the first N EEG channels")
    ap.add_argument("--mains", type=float, default=60.0, help="notch frequency (50 in EU/Asia, 0 to disable)")
    ap.add_argument("--blink-uv", type=float, default=40.0, help="frontal blink floor after 1–45 Hz filtering (µV); adaptive 5×MAD also applies")
    ap.add_argument("--ws-port", type=int, default=8765)
    ap.add_argument("--allow-origin", default="", help="restrict browser origins (comma-separated); default any")
    ap.add_argument("--cloud", action="store_true", help="also stream summaries to CORTEX_API with CORTEX_INGEST_TOKEN")
    ap.add_argument("--record", type=float, default=0, help="record N seconds (≤60) after a 3 s settle, then keep streaming")
    ap.add_argument("--label", default="openbci recording")
    ap.add_argument("--out-dir", default=str(Path(__file__).resolve().parent / "recordings"))
    ap.add_argument("--list-ports", action="store_true", help="print candidate serial ports and exit")
    return ap


def main(argv=None) -> None:
    args = parser().parse_args(argv)
    if args.list_ports:
        ports = detect_serial_ports()
        print("\n".join(ports) if ports else "no OpenBCI dongle ports found")
        return
    from brainflow.board_shim import BoardShim

    BoardShim.disable_board_logger()
    bridge = Bridge(args)
    threading.Thread(target=bridge.acquire, daemon=True, name="acquire").start()
    if bridge.cloud_enabled():
        threading.Thread(target=bridge.cloud_loop, daemon=True, name="cloud").start()
        print("cloud streaming enabled")
    elif args.cloud:
        print("--cloud ignored: set CORTEX_API and CORTEX_INGEST_TOKEN")
    if args.record:
        def rec():
            while bridge.state != "streaming" and not bridge.stop.is_set():
                time.sleep(0.2)
            time.sleep(3)
            try:
                bridge.record(args.record, args.label)
            except Exception as exc:
                print(f"recording failed: {exc}")
        threading.Thread(target=rec, daemon=True, name="record").start()

    def shutdown(*_):
        if bridge.stop.is_set():
            os._exit(1)                         # second Ctrl+C: force quit
        print("\nstopping …")
        bridge.stop.set()
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    try:
        asyncio.run(bridge.serve())
    finally:
        bridge.stop.set()
        time.sleep(0.3)


if __name__ == "__main__":
    main()
