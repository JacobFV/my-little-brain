"""Pre-flight checklist before a live demo: dependencies, dongle, signal quality, ports, backend, cloud token.

    python research/bridge/preflight.py --board cyton            # real headset (port auto-detected)
    python research/bridge/preflight.py --board playback         # no hardware
    CORTEX_API=https://… CORTEX_INGEST_TOKEN=… python research/bridge/preflight.py --board cyton

Exit code 0 when every required check passes.
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

OK, WARN, FAIL = "✓", "!", "✗"
results: list[tuple[str, str, str]] = []


def report(status: str, name: str, detail: str = "") -> None:
    results.append((status, name, detail))
    print(f"  {status} {name}" + (f" — {detail}" if detail else ""), flush=True)


def check_imports() -> bool:
    missing = []
    for mod in ("brainflow", "numpy", "scipy", "websockets", "requests"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        report(FAIL, "python packages", f"missing {', '.join(missing)}: pip install -r research/bridge/requirements.txt")
        return False
    report(OK, "python packages")
    return True


def check_port_free(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        busy = s.connect_ex(("127.0.0.1", port)) == 0
    report(WARN if busy else OK, f"websocket port {port}",
           "in use — a bridge may already be running (fine if intended)" if busy else "free")


def check_board(args) -> None:
    import openbci
    from signals import FRONTAL, OCCIPITAL, channel_quality, detect_serial_ports, line_noise_ratio

    if args.board in openbci.SERIAL_BOARDS:
        ports = detect_serial_ports()
        if args.serial_port:
            report(OK if os.path.exists(args.serial_port) else FAIL, "serial port", args.serial_port)
        elif ports:
            report(OK, "serial port", ", ".join(ports) + ("  (using the first; pass --serial-port to choose)" if len(ports) > 1 else ""))
        else:
            report(FAIL, "serial port", "no /dev/cu.usbserial-* found: plug in the OpenBCI dongle")
            return
    bridge_args = openbci.parser().parse_args(
        ["--board", args.board] + (["--serial-port", args.serial_port] if args.serial_port else [])
        + (["--mac-address", args.mac_address] if args.mac_address else []) + (["--channels", args.channels] if args.channels else [])
        + ["--mains", str(args.mains)])
    from brainflow.board_shim import BoardShim

    BoardShim.disable_board_logger()
    bridge = openbci.Bridge(bridge_args)
    try:
        board = bridge._open()
    except Exception as exc:
        report(FAIL, "board connection", str(exc))
        return
    try:
        time.sleep(args.seconds)
        data = board.get_board_data()
    finally:
        try:
            board.stop_stream()
        finally:
            board.release_session()
    n = data.shape[1]
    rate = n / args.seconds
    report(OK if rate > 0.8 * bridge.fs else FAIL, "sample rate", f"{rate:.0f} Hz of {bridge.fs:.0f} Hz expected")
    if n < bridge.fs:
        report(FAIL, "signal", "less than 1 s of data received")
        return
    raw = np.asarray(data[bridge.eeg_rows], dtype=float)
    filt = bridge.filters(raw)
    skip = int(bridge.fs)                       # filter settling
    bad = []
    for i, name in enumerate(bridge.names):
        q = channel_quality(raw[i, skip:], filt[i, skip:])
        ln = line_noise_ratio(raw[i, skip:], bridge.fs, args.mains)
        sd = float(np.std(filt[i, skip:]))
        status = OK if q == "ok" and ln < 1.0 else WARN if q in ("ok", "noisy") else FAIL
        if status != OK:
            bad.append(name)
        hint = {"railed": "electrode not touching skin / reference (SRB) or bias not connected",
                "flat": "channel off or shorted", "noisy": "loose electrode or movement"}.get(q, "")
        if q == "ok" and ln >= 1.0:
            hint = f"strong {args.mains:.0f} Hz pickup ({ln:.1f}× EEG power): check ear-clip reference/bias, move away from chargers"
        report(status, f"  channel {name}", f"{q}, {sd:.1f} µV rms" + (f" — {hint}" if hint else ""))
    names_l = [c.lower() for c in bridge.names]
    report(OK if any(c in FRONTAL for c in names_l) else WARN, "blink channels", "Fp1/Fp2 present" if any(c in FRONTAL for c in names_l)
           else "no frontal channel named Fp1/Fp2 — blinks won't be detected (use --channels)")
    report(OK if any(c in OCCIPITAL for c in names_l) else WARN, "alpha channels", "O1/O2 present" if any(c in OCCIPITAL for c in names_l)
           else "no occipital channel named O1/O2 — eyes-closed alpha won't be detected (use --channels)")
    if bad:
        report(WARN, "signal quality", f"fix {', '.join(bad)} before the demo (the demo still runs)")


def check_backend(url: str, name: str, required: bool) -> None:
    import requests

    try:
        r = requests.get(url.rstrip("/") + "/health", timeout=5)
        ok = r.status_code == 200
        report(OK if ok else (FAIL if required else WARN), name, f"{url} → {r.status_code} {r.text[:60]}")
        if ok:
            cfg = requests.get(url.rstrip("/") + "/v1/config", timeout=5).json()
            provs = [p["id"] for p in cfg.get("providers", []) if p.get("available")]
            report(OK if cfg.get("agent_configured") else WARN, f"{name} agent", f"model {cfg.get('model')}, backends {', '.join(provs)}")
            if not cfg.get("auth", {}).get("google_client_id") and not cfg.get("auth", {}).get("dev_auth"):
                report(WARN, f"{name} sign-in", "GOOGLE_OAUTH_CLIENT_ID not set and dev auth off — nobody can sign in")
    except Exception as exc:
        report(FAIL if required else WARN, name, f"{url} unreachable: {exc}")


def check_cloud_token() -> None:
    import requests

    api, token = os.environ.get("CORTEX_API"), os.environ.get("CORTEX_INGEST_TOKEN")
    if not api:
        report(WARN, "cloud streaming", "CORTEX_API not set (only needed for cloud streaming/recording uploads)")
        return
    check_backend(api, "cloud API", required=True)
    if not token:
        report(WARN, "device token", "CORTEX_INGEST_TOKEN not set: create one in the lab sidebar (OpenBCI → device token)")
        return
    frame = {"board": "preflight", "fs": 125, "channel_names": ["Fp1"], "samples": [[0.0] * 32], "bands": {}, "blink": False,
             "quality": "preflight"}
    try:
        r = requests.post(api.rstrip("/") + "/v1/eeg/ingest", json=frame, headers={"Authorization": f"Bearer {token}"}, timeout=8)
        msg = {200: "accepted", 401: "missing", 403: "invalid or expired — create a new one in the lab"}.get(r.status_code, r.text[:80])
        report(OK if r.status_code == 200 else FAIL, "device token", f"{r.status_code} {msg}")
    except Exception as exc:
        report(FAIL, "device token", f"ingest unreachable: {exc}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", default="cyton")
    ap.add_argument("--serial-port", default="")
    ap.add_argument("--mac-address", default="")
    ap.add_argument("--channels", default="")
    ap.add_argument("--mains", type=float, default=60.0)
    ap.add_argument("--seconds", type=float, default=6.0, help="how long to sample the board")
    ap.add_argument("--ws-port", type=int, default=8765)
    ap.add_argument("--local-api", default="http://127.0.0.1:8080")
    ap.add_argument("--skip-board", action="store_true")
    args = ap.parse_args(argv)
    print("cortex² pre-flight")
    if not check_imports():
        return 1
    check_port_free(args.ws_port)
    if not args.skip_board:
        check_board(args)
    check_backend(args.local_api, "local API", required=False)
    check_cloud_token()
    fails = [r for r in results if r[0] == FAIL]
    warns = [r for r in results if r[0] == WARN]
    print(f"\n{'READY' if not fails else 'NOT READY'}: {len(fails)} failed, {len(warns)} warnings")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
