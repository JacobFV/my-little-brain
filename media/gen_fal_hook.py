#!/usr/bin/env python
"""Generate the v3 hook b-roll with fal.ai (Kling 2.5 Turbo Pro text-to-video), in parallel.
FAL_KEY is read from the repo-root .env. Output: media/fal/hook-NN-slug.mp4 (+ frames/hook-NN-slug.png).
    research/.venv/bin/python media/gen_fal_hook.py
"""
import json, os, subprocess, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(HERE)
KEY = next(l.split("=", 1)[1].strip().strip('"\'') for l in open(os.path.join(REPO, ".env")) if l.startswith("FAL_KEY="))
EP = "fal-ai/kling-video/v2.5-turbo/pro/text-to-video"
STYLE = " Photoreal cinematic footage, strong dynamic camera motion, high visual energy, shallow depth of field. No text, no logos, no watermarks, no people's faces."
SHOTS = [
    ("eye-push", "Extreme macro camera push straight into a human iris, the pupil fills the frame and reveals glowing blue and magenta neural light filaments inside, reflections of light streaks."),
    ("neural-fpv", "Fast FPV drone fly-through along glowing neural pathways inside a brain, luminous axons rushing past, the pathways gradually turn into glowing golden circuit-board traces."),
    ("city-eeg", "Night time-lapse of a city skyline from above, car light trails streak through the streets and morph into glowing rhythmic waveform lines like brainwaves."),
    ("headset-zoom", "Snap zoom from the back of a head wearing a white EEG electrode headset, diving through the skull into a glowing pink brain and down to firing neurons, continuous zoom."),
    ("fridge-spin", "A gold dilution refrigerator quantum computer chandelier spinning slowly in a dark lab, camera orbits fast around it, warm lens flares and glints on copper coils."),
    ("laser-ions", "Bright laser beams snapping on one after another through a polished vacuum chamber, a row of tiny glowing trapped ions lights up, blue and violet glow, fast camera dolly."),
    ("ink-bloom", "Ink drops falling into clear water and blooming into swirling clouds of red, orange, purple and periwinkle blue, slow motion macro, camera pushing in."),
    ("brain-wakes", "A tiny cute glowing pink brain-shaped lamp on a wooden desk lights up as if waking, pulses of soft light, camera pushes in quickly, warm bokeh."),
]

def call(url, data=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Authorization": f"Key {KEY}", "Content-Type": "application/json"},
                                 method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read())

def run(i_shot):
    i, (slug, prompt) = i_shot
    name = f"hook-{i + 1:02d}-{slug}"; out = os.path.join(HERE, "fal", name + ".mp4")
    if os.path.exists(out): return name, "exists"
    sub = call(f"https://queue.fal.run/{EP}", {"prompt": prompt + STYLE, "duration": "5", "aspect_ratio": "16:9"})
    t0 = time.time()
    while True:
        st = call(sub["status_url"])
        if st.get("status") == "COMPLETED": break
        if time.time() - t0 > 900: return name, "timeout"
        time.sleep(8)
    res = call(sub["response_url"]); vurl = res["video"]["url"]
    urllib.request.urlretrieve(vurl, out)
    os.makedirs(os.path.join(HERE, "fal", "frames"), exist_ok=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", "2.5", "-i", out, "-frames:v", "1", os.path.join(HERE, "fal", "frames", name + ".png")])
    return name, prompt + STYLE

if __name__ == "__main__":
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(run, list(enumerate(SHOTS))))
    for name, msg in res: print(name, "|", msg[:80])
    json.dump(res, open(os.path.join(HERE, "fal", "hook_prompts.json"), "w"), indent=1)
