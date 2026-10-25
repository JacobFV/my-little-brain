"""Bridge signal processing, fixture and playback tests (no hardware).

    research/.venv/bin/python -m pytest -q research/bridge/test_bridge.py
"""
import asyncio
import json
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture  # noqa: E402
import signals  # noqa: E402

FS = fixture.FS


def stream_detectors(x: np.ndarray, channels: list[str], chunk: int = 10):
    """Replay a recording through the same causal filter + detectors the bridge uses."""
    filt = signals.Filters(FS, x.shape[0], mains=60.0)
    fr = [i for i, c in enumerate(channels) if c.lower() in signals.FRONTAL]
    oc = [i for i, c in enumerate(channels) if c.lower() in signals.OCCIPITAL]
    blink, alpha = signals.BlinkDetector(FS), signals.AlphaDetector()
    y = np.zeros_like(x)
    blinks, states = [], []
    for start in range(0, x.shape[1], chunk):
        end = min(start + chunk, x.shape[1])
        y[:, start:end] = filt(x[:, start:end])
        t = end / FS
        w = y[:, max(0, end - int(2.5 * FS)):end]
        if blink.update(w[fr], t):
            blinks.append(t)
        if end % int(FS / 4) < chunk:                    # ~4 Hz like the bridge
            states.append((t, alpha.update(y[oc, max(0, end - int(2 * FS)):end], FS)))
    return blinks, states


def test_blink_detection_on_realistic_fixture():
    x, truth = fixture.generate(60.0, seed=3)
    detected, _ = stream_detectors(x, fixture.CHANNELS)
    true = truth["blinks"]
    assert len(true) >= 8
    hits = [any(abs(d - b) < 0.6 for d in detected) for b in true]
    false = [d for d in detected if not any(abs(d - b) < 0.6 for b in true)]
    assert sum(hits) / len(true) >= 0.9, (true, detected)
    assert len(false) <= 1, false


def test_weaker_real_world_signals():
    """Half-strength eyes-closed alpha and 100 µV blinks (thin hair, imperfect contact)."""
    x, truth = fixture.generate(60.0, seed=11, closed_alpha_uv=12.0, blink_uv=100.0)
    detected, states = stream_detectors(x, fixture.CHANNELS)
    hits = sum(any(abs(d - b) < 0.6 for d in detected) for b in truth["blinks"])
    assert hits / len(truth["blinks"]) >= 0.8
    closed = [s for t, s in states if any(a + 3 <= t <= b for a, b in truth["eyes_closed"])]
    assert np.mean([s == "eyes_closed" for s in closed]) > 0.7


def test_no_blinks_in_clean_eeg():
    rng = np.random.default_rng(0)
    n = int(30 * FS)
    x = np.vstack([10 * fixture.pink(n, rng) + 3000 for _ in fixture.CHANNELS])
    detected, _ = stream_detectors(x, fixture.CHANNELS)
    assert len(detected) <= 1


def test_eyes_closed_alpha_state_tracks_truth():
    x, truth = fixture.generate(60.0, seed=5)
    _, states = stream_detectors(x, fixture.CHANNELS)

    def closed_at(t):
        return any(a + 2.5 <= t <= b for a, b in truth["eyes_closed"])        # allow 2.5 s to settle

    def open_at(t):
        return t > 8 and all(not (a - 0.5 <= t <= b + 3.0) for a, b in truth["eyes_closed"])

    closed = [s for t, s in states if closed_at(t)]
    opened = [s for t, s in states if open_at(t)]
    assert closed and opened
    assert np.mean([s == "eyes_closed" for s in closed]) > 0.85
    assert np.mean([s == "eyes_open" for s in opened]) > 0.85


def test_alpha_unknown_without_enough_data():
    a = signals.AlphaDetector()
    assert a.update(np.zeros((2, 100)), FS) == "unknown"
    assert a.to_json()["alpha_state"] == "unknown"


def test_channel_quality_labels():
    rng = np.random.default_rng(1)
    good = 10 * rng.standard_normal(500)
    assert signals.channel_quality(good + 2000, good) == "ok"
    assert signals.channel_quality(np.full(500, 187_400.0), np.zeros(500)) == "railed"
    assert signals.channel_quality(np.zeros(500) + 5, np.zeros(500)) in ("railed", "flat")
    assert signals.channel_quality(good * 50, good * 50) == "noisy"
    assert signals.channel_quality(np.array([]), np.array([])) == "no data"


def test_line_noise_ratio_flags_mains():
    t = np.arange(int(4 * FS)) / FS
    clean = 10 * np.sin(2 * np.pi * 10 * t)
    assert signals.line_noise_ratio(clean, FS) < 0.01
    assert signals.line_noise_ratio(clean + 50 * np.sin(2 * np.pi * 60 * t), FS) > 1.0


def test_filter_is_streaming_consistent():
    rng = np.random.default_rng(2)
    x = rng.standard_normal((3, 1000)) * 10 + 500
    a = signals.Filters(FS, 3)(x)
    f = signals.Filters(FS, 3)
    b = np.hstack([f(x[:, i:i + 37]) for i in range(0, 1000, 37)])
    np.testing.assert_allclose(a, b, atol=1e-8)
    assert abs(a[:, 500:].mean()) < 5                     # DC removed


def test_bandpowers_and_average():
    t = np.arange(int(2 * FS)) / FS
    bp = signals.bandpowers(20 * np.sin(2 * np.pi * 10 * t), FS)
    assert bp["alpha"] > 90 and bp["rms_uv"] == pytest.approx(14.14, abs=0.2)
    assert signals.bandpowers(np.zeros(10), FS) == {}
    avg = signals.average_bands([bp, {}])
    assert avg["alpha"] == bp["alpha"]


def test_error_explanations():
    msg = signals.explain_board_error(RuntimeError("UNABLE_TO_OPEN_PORT_ERROR:2"), "cyton", "/dev/cu.usbserial-X")
    assert "OpenBCI GUI" in msg and "/dev/cu.usbserial-X" in msg
    assert "Turn the board on" in signals.explain_board_error(RuntimeError("BOARD_NOT_READY_ERROR:7"), "cyton", "p")
    assert "Bluetooth" in signals.explain_board_error(RuntimeError("BLE failure"), "ganglion-native", "")


def test_ring_buffer_wraps_in_order():
    sys.modules.pop("openbci", None)
    import openbci

    r = openbci.Ring(1, 10)
    for k in range(0, 25, 4):
        r.push(np.arange(k, k + 4, dtype=float)[None])
    np.testing.assert_array_equal(r.last(10)[0], np.arange(18, 28))
    np.testing.assert_array_equal(r.last(3)[0], [25, 26, 27])
    r.push(np.arange(100, 130, dtype=float)[None])
    np.testing.assert_array_equal(r.last(5)[0], np.arange(125, 130))


def test_playback_fixture_roundtrip(tmp_path):
    pytest.importorskip("brainflow")
    from brainflow.board_shim import BoardIds, BoardShim
    from brainflow.data_filter import DataFilter

    path = fixture.write_playback(tmp_path / "demo.csv", seconds=6)
    data = DataFilter.read_file(str(path))
    rows = BoardShim.get_eeg_channels(BoardIds.CYTON_BOARD.value)
    assert data.shape[0] == BoardShim.get_num_rows(BoardIds.CYTON_BOARD.value)
    assert data.shape[1] == int(6 * FS)
    assert np.abs(data[rows]).max() < 10_000


def test_bridge_end_to_end_playback(tmp_path):
    """Run the real bridge on the playback board and read frames over the WebSocket."""
    pytest.importorskip("brainflow")
    websockets = pytest.importorskip("websockets")
    sys.modules.pop("openbci", None)
    import openbci

    csv = fixture.write_playback(tmp_path / "demo.csv", seconds=20)
    port = 8811
    args = openbci.parser().parse_args(["--board", "playback", "--file", str(csv), "--ws-port", str(port),
                                        "--out-dir", str(tmp_path / "rec")])
    from brainflow.board_shim import BoardShim

    BoardShim.disable_board_logger()
    bridge = openbci.Bridge(args)
    threading.Thread(target=bridge.acquire, daemon=True).start()
    loop_thread = threading.Thread(target=lambda: asyncio.run(bridge.serve()), daemon=True)
    loop_thread.start()

    async def client():
        for _ in range(50):
            try:
                ws = await websockets.connect(f"ws://127.0.0.1:{port}")
                break
            except OSError:
                await asyncio.sleep(0.1)
        hello = json.loads(await ws.recv())
        assert hello["type"] == "hello" and hello["channel_names"][:2] == ["Fp1", "Fp2"] and hello["protocol"] == 2
        await ws.send(json.dumps({"type": "record", "seconds": 4, "label": "test"}))
        frames, progress, recording = [], [], None
        deadline = time.time() + 25
        while time.time() < deadline and recording is None:
            m = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if m["type"] == "frame":
                frames.append(m)
            elif m["type"] == "recording_progress":
                progress.append(m)
            elif m["type"] == "recording":
                recording = m
            elif m["type"] == "error":
                raise AssertionError(m)
        await ws.close()
        return frames, progress, recording

    try:
        frames, progress, recording = asyncio.run(client())
    finally:
        bridge.stop.set()
    assert len(frames) > 20
    f = frames[-1]
    assert f["state"] == "streaming" and len(f["samples"]) == 8 and len(f["quality"]) == 8
    assert {"alpha_state", "alpha_fraction", "blink_count", "line_noise"} <= set(f)
    assert all(q in ("ok", "noisy", "flat", "railed", "no data") for q in f["quality"])
    assert progress and progress[-1]["elapsed"] >= 3
    assert recording and recording["recording_id"] is None and Path(recording["path"]).exists()
    saved = json.loads(Path(recording["path"]).read_text())
    assert saved["channel_names"][:2] == ["Fp1", "Fp2"] and len(saved["data"][0]) >= 4 * 250 * 0.95
