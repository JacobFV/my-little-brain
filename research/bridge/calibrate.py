"""Guided OpenBCI calibration with spoken cues (macOS `say`). Records every phase, then reports signal quality.

    research/.venv/bin/python research/bridge/calibrate.py [--port /dev/cu.usbserial-XXXX]
"""
import argparse, json, subprocess, time
from pathlib import Path
import numpy as np
from brainflow.board_shim import BoardShim, BrainFlowInputParams, BoardIds
from scipy.signal import butter, filtfilt, iirnotch, welch

CH = ["Fp1", "Fp2", "C3", "C4", "P7", "P8", "O1", "O2"]
PHASES = [("settle", 8, "Calibration starting. Sit still, relax your face, eyes open."),
          ("eyes_open", 20, "Eyes open. Look at one spot and stay still."),
          ("eyes_closed", 20, "Now close your eyes and relax."),
          ("blinks", 15, "Open your eyes. Blink firmly, about once a second."),
          ("jaw", 8, "Clench your jaw. Hold it."),
          ("rest", 20, "Relax your jaw. Eyes closed, breathe slowly.")]

def say(t): subprocess.Popen(["say", "-r", "185", t])

ap = argparse.ArgumentParser(); ap.add_argument("--port", default="/dev/cu.usbserial-DP04W4G6"); a = ap.parse_args()
BoardShim.disable_board_logger()
p = BrainFlowInputParams(); p.serial_port = a.port; p.timeout = 15
bid = BoardIds.CYTON_BOARD.value; fs = BoardShim.get_sampling_rate(bid); chans = BoardShim.get_eeg_channels(bid)
pkg = BoardShim.get_package_num_channel(bid)
b = BoardShim(bid, p); b.prepare_session(); b.start_stream()
marks = []
for name, dur, cue in PHASES:
    say(cue); time.sleep(1.2); b.insert_marker(len(marks) + 1); marks.append(name); print(f"▸ {name} ({dur}s)", flush=True); time.sleep(dur)
say("Done. Thank you."); time.sleep(0.5)
d = b.get_board_data(); b.stop_stream(); b.release_session()
mk = d[BoardShim.get_marker_channel(bid)]; eeg = d[chans]
ts = time.strftime("%Y%m%d-%H%M%S"); out = Path("research/data/openbci"); out.mkdir(parents=True, exist_ok=True)
np.savez_compressed(out / f"calibration-{ts}.npz", eeg=eeg, markers=mk, fs=fs, channels=CH, phases=marks)

# packet loss from the 0-255 sample counter
seq = d[pkg].astype(int); gaps = np.diff(seq) % 256; lost = int((gaps - 1).clip(0).sum())
bb, aa = butter(4, [1, 45], btype="band", fs=fs); nb, na = iirnotch(60, 30, fs)
x = filtfilt(nb, na, filtfilt(bb, aa, eeg, axis=1), axis=1)
idx = np.flatnonzero(mk); bounds = list(idx) + [x.shape[1]]
seg = {marks[int(mk[i]) - 1]: x[:, i + fs // 2: bounds[k + 1]] for k, i in enumerate(idx)}
raw_line = {}
f, P = welch(eeg - eeg.mean(1, keepdims=True), fs, nperseg=fs * 2, axis=1)
line = P[:, (f > 58) & (f < 62)].sum(1) / P[:, (f > 1) & (f < 100)].sum(1)

def share(s, lo, hi):
    f, P = welch(s, fs, nperseg=fs * 2, axis=1); tot = P[:, (f >= 1) & (f < 45)].sum(1)
    return P[:, (f >= lo) & (f < hi)].sum(1) / tot

rep = {"file": f"calibration-{ts}.npz", "samples": int(x.shape[1]), "expected": int(sum(d for _, d, _ in PHASES) * fs), "packets_lost": lost}
rows = []
for i, c in enumerate(CH):
    rms = float(seg["eyes_open"][i].std()); alpha_o = float(share(seg["eyes_open"], 8, 13)[i]); alpha_c = float(share(seg["eyes_closed"], 8, 13)[i])
    jaw = float(seg["jaw"][i].std() / max(1e-9, seg["rest"][i].std()))
    blink = float(np.percentile(np.abs(seg["blinks"][i]), 99) / max(1e-9, np.percentile(np.abs(seg["eyes_open"][i]), 99)))
    ok = 3 < rms < 100 and line[i] < 0.5
    rows.append(dict(ch=c, rms_uV=round(rms, 1), line_noise=round(float(line[i]), 2), alpha_open=round(alpha_o, 3), alpha_closed=round(alpha_c, 3),
                     alpha_ratio=round(alpha_c / max(alpha_o, 1e-6), 2), blink_gain=round(blink, 2), jaw_gain=round(jaw, 2), contact="good" if ok else "CHECK"))
rep["channels"] = rows
(out / f"calibration-{ts}.json").write_text(json.dumps(rep, indent=1))
print(json.dumps(rep, indent=1))
