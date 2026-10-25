#!/usr/bin/env python
"""90 s story cut (v2) of the My Little Brain hype video.  Reuses the scene renderers in
make_video.py, adds photoreal b-roll bursts, real app screen recordings and a brand-logo
dispatch beat.  Renders in parallel chunks, then muxes the 92 s soundtrack (first 90 s).
    research/.venv/bin/python media/make_video_90.py
"""
import glob, math, os, subprocess, sys, wave
import multiprocessing as mp
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.signal import butter, lfilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_video as mv
from make_video import W, H, FPS, SR, CYAN, MAG, SAGE, SAGE2, DARK, INK, font, ease, caption

HERE = mv.HERE; BUILD = mv.BUILD
DUR = 90.0; NF = int(DUR * FPS)
OUT = os.path.join(HERE, "my-little-brain-90s.mp4")
rng = np.random.default_rng(11)

# ------------------------------------------------------------------ soundtrack + beats
TRACK = os.path.join(BUILD, "track90.wav")
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", os.path.join(HERE, "soundtrack-1984-mechanical-heart-92s.mp3"),
                "-t", f"{DUR}", "-ar", str(SR), "-ac", "2", TRACK], check=True)
def detect():
    import librosa
    y, sr = librosa.load(TRACK, sr=22050)
    t, b = librosa.beat.beat_track(y=y, sr=sr, units="time")
    return float(np.atleast_1d(t)[0]), np.asarray(b)
TEMPO, BEATS = detect()
BEAT = float(np.median(np.diff(BEATS)))
def snap(t): return float(BEATS[np.argmin(np.abs(BEATS - t))]) if 0 < t < DUR - 0.3 else t

# ------------------------------------------------------------------ inputs (whatever exists at render time)
import shutil
SNAP = os.path.join(BUILD, "broll_snap")
if __name__ == "__main__":  # snapshot b-roll so files changing mid-render can't break it
    shutil.rmtree(SNAP, ignore_errors=True); os.makedirs(SNAP)
    for f in glob.glob(os.path.join(HERE, "broll", "*")):
        if f.lower().endswith((".jpg", ".jpeg", ".png")):
            try: Image.open(f).convert("RGB").save(os.path.join(SNAP, os.path.splitext(os.path.basename(f))[0] + ".jpg"), quality=92)
            except Exception as e: print("skip", f, e)
BROLL = sorted(glob.glob(os.path.join(SNAP, "*.jpg")))
def broll_pick(keys):
    hits = [p for p in BROLL if any(k in os.path.basename(p).lower() for k in keys)]
    rest = [p for p in BROLL if p not in hits]
    return hits + rest
CLIPS = sorted(glob.glob(os.path.join(HERE, "app-clips", "*.mp4")) + glob.glob(os.path.join(HERE, "app-clips", "*.webm")))
def clip_for(keys):
    for c in CLIPS:
        if any(k in os.path.basename(c).lower() for k in keys): return c
    return None

CLIP_BOX = (1600, 900)
def extract_clip(path):
    name = os.path.splitext(os.path.basename(path))[0]
    d = os.path.join(BUILD, "clips", name)
    if not os.path.exists(os.path.join(d, "f0001.jpg")):
        os.makedirs(d, exist_ok=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-vf",
                        f"fps=30,scale={CLIP_BOX[0]}:{CLIP_BOX[1]}:force_original_aspect_ratio=decrease",
                        "-q:v", "3", os.path.join(d, "f%04d.jpg")], check=True)
    return sorted(glob.glob(os.path.join(d, "f*.jpg")))

def logo_imgs():
    out = []
    for key in ["google-gemini", "openbci", "ionq", "ibm", "qbraid", "extropic"]:
        cands = glob.glob(os.path.join(HERE, "logos", f"{key}-white.*"))
        if not cands: continue
        p = cands[0]
        if p.endswith(".svg"):
            png = os.path.join(BUILD, f"logo-{key}.png")
            subprocess.run(["rsvg-convert", "-h", "150", p, "-o", png], check=True); p = png
        im = Image.open(p).convert("RGBA"); s = 150 / im.size[1]
        if im.size[0] * s > 460: s = 460 / im.size[0]
        out.append((key, im.resize((max(1, int(im.size[0] * s)), max(1, int(im.size[1] * s))), Image.LANCZOS)))
    return out

# ------------------------------------------------------------------ new scene renderers
_img_cache = {}
def cover(path):
    if path not in _img_cache:
        if len(_img_cache) > 30: _img_cache.clear()
        im = Image.open(path).convert("RGB"); tw, th = int(W * 1.18), int(H * 1.18)
        s = max(tw / im.size[0], th / im.size[1])
        im = im.resize((int(im.size[0] * s) + 1, int(im.size[1] * s) + 1), Image.BICUBIC)
        x, y = (im.size[0] - tw) // 2, (im.size[1] - th) // 2
        _img_cache[path] = im.crop((x, y, x + tw, y + th))
    return _img_cache[path]

def big_text(im, lines, y=None, size=120, accent=CYAN):
    d = ImageDraw.Draw(im); f = font(size, "heavy"); lh = int(size * 1.12)
    y0 = y if y is not None else (H - lh * len(lines)) // 2
    for i, l in enumerate(lines):
        parts = l.split("*"); tw = sum(d.textlength(p, font=f) for p in parts); x = (W - tw) / 2
        for j, p in enumerate(parts):
            for dx, dy in ((5, 5), (0, 0)):
                d.text((x + dx, y0 + i * lh + dy), p, font=f, fill=(0, 0, 0) if dx else (accent if j % 2 else (255, 255, 255)))
            x += d.textlength(p, font=f)

def r_broll(tl, dur, p, T, seg_t0):
    imgs = p.get("imgs") or []
    if not imgs:  # nothing delivered: fall back to the real spectrogram / brain eyes
        im = (mv.r_spec(tl, dur, dict(cap=p.get("cap", "")), T) if int(tl / BEAT) % 2 == 0
              else mv.r_brain(tl, dur, dict(mode="eyes", z=(1.2, 1.6), bg="blur", tint=MAG), T))
        if p.get("text"):
            im = Image.blend(im, Image.new("RGB", (W, H), (0, 0, 0)), 0.4); big_text(im, p["text"], size=p.get("size", 120), accent=p.get("accent", CYAN))
        return im
    # switch every beat, with a half-beat double-tap every 3rd change -> 1.8-3.6 Hz flashes
    k = int((tl + 1e-3) / BEAT); sub = (tl % BEAT) / BEAT
    idx = k * 2 + (1 if (k % 3 == 2 and sub >= 0.5) else 0)
    local = (tl % BEAT) if not (k % 3 == 2 and sub >= 0.5) else (tl % (BEAT / 2))
    path = imgs[(idx + p.get("off", 0)) % len(imgs)]
    src = cover(path); z = 1.0 + 0.10 * local / BEAT
    cw, ch = W * 1.18 / z / 1.18 * 1.0, H / z
    cw = W / z * 1.0; ox = (src.size[0] - cw) * (0.5 + 0.4 * math.sin(idx * 2.1)); oy = (src.size[1] - ch) * (0.5 + 0.4 * math.cos(idx * 1.3))
    im = src.crop((int(ox), int(oy), int(ox + cw), int(oy + ch))).resize((W, H), Image.BILINEAR)
    tint = [None, CYAN, None, MAG][idx % 4]
    if tint:
        a = np.asarray(im).astype(np.float32); g = a.mean(2, keepdims=True) / 255
        duo = np.array(DARK, np.float32) * (1 - g) + np.array(tint, np.float32) * g
        im = Image.fromarray((a * 0.55 + duo * 0.45).astype(np.uint8))
    if local < 0.05:
        im = Image.blend(im, Image.new("RGB", (W, H), (255, 255, 255)), 0.5)
    if p.get("text"):
        dim = Image.new("RGB", (W, H), (0, 0, 0)); im = Image.blend(im, dim, 0.35)
        big_text(im, p["text"], size=p.get("size", 120), accent=p.get("accent", CYAN))
    if p.get("cap"): caption(im, p["cap"], p.get("capcol", CYAN))
    return im

def r_clip(tl, dur, p, T, seg_t0):
    frames = p["frames"]
    im = mv.BG_BLUR.copy() if p.get("bg") != "sage" else mv.BG_SAGE.copy()
    rate = min(3.0, max(1.0, len(frames) / (dur * FPS)))
    fi = min(len(frames) - 1, int(tl * FPS * rate) + p.get("skip", 0))
    if p.get("still"):
        sd = dur / len(frames); fi = min(len(frames) - 1, int(tl / sd)); tl, dur = tl - fi * sd, sd
    fr = Image.open(frames[fi]).convert("RGB")
    s = min(1500 / fr.size[0], 820 / fr.size[1]) * (1.0 + (0.10 if p.get("still") else 0.03) * tl / dur)
    fr = fr.resize((int(fr.size[0] * s), int(fr.size[1] * s)), Image.BICUBIC)
    x, y = (W - fr.size[0]) // 2, (H - fr.size[1]) // 2 - 40
    mask = Image.new("L", fr.size, 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, fr.size[0] - 1, fr.size[1] - 1], radius=36, fill=255)
    sh = Image.new("L", (fr.size[0] + 160, fr.size[1] + 160), 0); ImageDraw.Draw(sh).rounded_rectangle([80, 100, fr.size[0] + 80, fr.size[1] + 100], radius=40, fill=200)
    sh = sh.filter(ImageFilter.GaussianBlur(30)); im.paste((0, 0, 0), (x - 80, y - 80), sh)
    ImageDraw.Draw(im).rounded_rectangle([x - 4, y - 4, x + fr.size[0] + 3, y + fr.size[1] + 3], radius=40, fill=p.get("ring", CYAN))
    im.paste(fr, (x, y), mask)
    d = ImageDraw.Draw(im)
    d.text((x + 10, y - 52), ("REAL APP · screenshot" if p.get("still") else "REAL APP · screen recording"), font=font(34, "cond"), fill=(255, 255, 255))
    caps = p["caps"]; ci = min(len(caps) - 1, int(tl / dur * len(caps)))
    f = font(64, "bold"); t = caps[ci]; tw = d.textlength(t, font=f)
    cy = y + fr.size[1] + 22
    d.rounded_rectangle([(W - tw) / 2 - 36, cy, (W + tw) / 2 + 36, cy + 96], radius=48, fill=(12, 14, 13))
    d.text(((W - tw) / 2, cy + 10), t, font=f, fill=(255, 255, 255))
    return im

LOGOS = None
def r_logos(tl, dur, p, T, seg_t0):
    global LOGOS
    if LOGOS is None: LOGOS = [l for l in logo_imgs() if l[0] in ("ionq", "ibm", "qbraid", "extropic")]
    im = mv.BG_DARK.copy(); d = ImageDraw.Draw(im)
    big_text(im, ["dispatched to *real quantum hardware*"], y=90, size=78)
    hub = (W // 2, 330)
    d.rounded_rectangle([hub[0] - 230, hub[1] - 50, hub[0] + 230, hub[1] + 50], radius=50, outline=CYAN, width=5)
    d.text((hub[0] - 185, hub[1] - 34), "QAOA · 8 qubits", font=font(56, "cond"), fill=CYAN)
    n = max(1, len(LOGOS)); slots = [(W * (i + 0.5) / n, 760) for i in range(n)]
    shown = int(tl / (BEAT / 2)) + 1
    for i, ((key, L), (sx, sy)) in enumerate(zip(LOGOS, slots)):
        if i >= shown: break
        age = tl - i * BEAT / 2
        d.line([hub, (sx, sy - 110)], fill=MAG, width=4)
        ph = (age * 1.6) % 1  # packet along the wire
        px, py = hub[0] + (sx - hub[0]) * ph, hub[1] + (sy - 110 - hub[1]) * ph
        d.ellipse([px - 12, py - 12, px + 12, py + 12], fill=CYAN)
        s = 1 + 0.4 * max(0, 1 - age / 0.2)
        Ls = L.resize((int(L.size[0] * s), int(L.size[1] * s)))
        im.paste(Ls, (int(sx - Ls.size[0] / 2), int(sy - Ls.size[1] / 2)), Ls)
        d.text((sx - 80, sy + 100), ["trapped ion", "superconducting", "multi-vendor", "thermodynamic"][i % 4] if n == 4 else "", font=font(36, "cond"), fill=SAGE2)
    caption(im, "IonQ Forte · IBM heavy-hex · qBraid (Rigetti · IQM · AQT · QuEra) · Extropic THRML", MAG)
    return im

def wrap(f): return lambda tl, dur, p, T, t0: f(tl, dur, p, T)
RENDER = {k: wrap(v) for k, v in mv.RENDER.items()}
RENDER.update(broll=r_broll, clip=r_clip, logos=r_logos)

# ------------------------------------------------------------------ the story (end times in seconds, snapped to beats)
def T_(*lines, **kw): return ("text", dict(lines=list(lines), **kw))
HEAD = ["eeg", "headset", "openbci", "electrode", "cap", "brain", "scalp", "neuro"]
QUANT = ["quantum", "ion", "ibm", "qubit", "cryo", "chip", "lab", "dilution"]
HOSP = ["hospital", "patient", "epilep", "mri", "clinic", "doctor", "seizure", "icu", "scan"]

def build_edl():
    hook = broll_pick(HEAD + ["mri"]); head = broll_pick(["eeg", "headset", "openbci", "electrode"]); hosp = broll_pick(HOSP); qnt = broll_pick(QUANT)
    def clip_or(keys, caps, fallback, ring=CYAN):
        c = clip_for(keys)
        if c:
            fr = extract_clip(c)
            if fr: return ("clip", dict(frames=fr, caps=caps, ring=ring))
        shots = [f for f in sorted(glob.glob(os.path.join(HERE, "app-shots", "*.png")))
                 if any(k in os.path.basename(f).lower() for k in keys)]
        snaps = []
        for sh_ in shots[:3]:
            snap_ = os.path.join(BUILD, "shot_" + os.path.basename(sh_))
            try: Image.open(sh_).convert("RGB").save(snap_); snaps.append(snap_)
            except Exception as e: print("bad shot", sh_, e)
        if snaps: return ("clip", dict(frames=snaps, caps=caps, ring=ring, still=True))
        print("missing clip", keys, "-> fallback"); return fallback
    E = [
        (4.0, "broll", dict(imgs=hook, text=["what if your brain"], size=130)),
        (8.0, "broll", dict(imgs=hook, off=7, text=["could *study itself?*"], size=140, accent=MAG)),
        (10.2, "brain", dict(say="hi. I'm your brain.", s=(0.8, 0.92))),
        (12.4, *T_("My Little Brain:", "a personal AI", "that *knows you*", style="sage")),
        (20.0, *clip_or(["chat", "01"], ["you ask your brain a question", "it knows your context & history"],
                        ("brain", dict(mode="eyes", z=(1.0, 1.8), bg="blur", cap="you ask your brain a question")))),
        (23.4, "broll", dict(imgs=head, off=2, cap="OpenBCI headset · 8-channel EEG", text=["a real *EEG headset*"], size=110)),
        (25.6, "eeg", dict()),
        (27.2, *T_("it reads your", "*brainwaves*", style="neon")),
        (35.0, *clip_or(["eeg", "vision", "triage", "gemini"], ["Gemini looks at your EEG", "it picks the channels that matter"],
                        ("spec", dict(cap="Gemini looks at your EEG · CHB-MIT spectrograms")))),
        (44.0, *clip_or(["reason", "02", "agent", "think"], ["it reasons about the hypothesis space", "256 Wilson–Cowan brains, which one is yours?"],
                        ("hist", dict(cap="it reasons about the hypothesis space")), ring=MAG)),
        (45.6, *T_("then it *writes", "the circuit*", style="dark")),
        (50.0, "circuit", dict(cap="it writes the quantum circuit · gate by gate")),
        (54.0, *clip_or(["circuit", "03", "qasm", "gate"], ["it writes the quantum circuit", "custom QAOA, agent-authored"],
                        ("circuit", dict(pre=1.0, title="agent-written QAOA · 42 gates", cap="QASM → transpile → hardware")))),
        (57.8, "logos", dict()),
        (62.0, *clip_or(["result", "05", "dispatch", "04", "analysis"], ["results come back → new hypothesis", "the agent analyses and iterates"],
                        ("fig", dict(cap="results come back → new hypothesis")), ring=MAG)),
        (64.2, "stat", dict(big="{n}/256", n=48, small="simulations to find the hidden brain", col=MAG)),
        (65.9, "broll", dict(imgs=qnt, cap="trapped ions · superconducting · thermodynamic")),
        (68.1, "stat", dict(big="{n} gates", n=42, small="a custom circuit the agent wrote itself", style="sage", col=MAG)),
        (69.2, "broll", dict(imgs=hosp, off=1)),
        (71.4, "stat", dict(bars=[("IonQ", 52, CYAN), ("IBM", 454, MAG)])),
        (72.5, "broll", dict(imgs=hosp, off=4)),
        (74.7, "stat", dict(big="τ 16→55 ms", small="every seizure window points to slower synapses", col=CYAN)),
        (77.5, "broll", dict(imgs=hosp, off=6, text=["toward *epilepsy research*"], size=120, cap="CHB-MIT pediatric seizure recordings")),
        (80.0, "fig", dict()),
        (81.2, "brain", dict(mode="eyes", z=(1.0, 1.6), glow=MAG, tint=MAG, bg="blur", rgb=True)),
        (DUR, "logo", dict()),
    ]
    edl, t0 = [], 0.0
    for end, kind, p in E:
        t1 = DUR if end >= DUR else snap(end)
        edl.append((t0, t1, kind, p)); t0 = t1
    return edl

# ------------------------------------------------------------------ frame + post
def post2(arr, kind, p, tl, fi, since, si):
    if kind in ("clip",):
        a = arr.astype(np.float32)
        if tl < 0.08: a = a * (1 - (1 - tl / 0.08) * 0.5) + 255 * (1 - tl / 0.08) * 0.5
        sp = int(14 * max(0, 1 - tl / 0.15))
        if sp: a[..., 0] = np.roll(a[..., 0], sp, 1); a[..., 2] = np.roll(a[..., 2], -sp, 1)
        return a.clip(0, 255).astype(np.uint8)
    if kind == "broll":
        a = arr.astype(np.float32); sp = int(8 * math.exp(-since * 14))
        if sp: a[..., 0] = np.roll(a[..., 0], sp, 1); a[..., 2] = np.roll(a[..., 2], -sp, 1)
        return (a * mv.VIGN + mv.GRAIN[fi % 6] * 0.6).clip(0, 255).astype(np.uint8)
    return mv.post(arr, kind, p, tl, fi, since, si)

def render_frame(fi, edl):
    T = fi / FPS
    si = max(i for i, e in enumerate(edl) if e[0] <= T + 1e-6)
    t0, t1, kind, p = edl[si]; tl = T - t0; dur = t1 - t0
    im = RENDER[kind](tl, dur, p, T, t0)
    if kind in ("eeg", "water", "spec", "brain", "circuit", "hist", "net", "fig"): mv.tag(im, T)
    prev = BEATS[BEATS <= T]; since = T - prev[-1] if len(prev) else 1.0
    out = post2(np.asarray(im.convert("RGB")), kind, p, tl, fi, since, si)
    if kind == "logo" and tl > dur - 0.6:
        out = (out.astype(np.float32) * max(0, (dur - tl) / 0.6)).astype(np.uint8)
    return out

def worker(args):
    k, f0, f1 = args
    edl = build_edl(); path = os.path.join(BUILD, f"chunk{k:02d}.mp4")
    pr = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
                           "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-maxrate", "16M", "-bufsize", "32M",
                           "-pix_fmt", "yuv420p", path], stdin=subprocess.PIPE)
    for fi in range(f0, f1): pr.stdin.write(render_frame(fi, edl).tobytes())
    pr.stdin.close(); pr.wait(); return path

def build_audio(path, t_logo):
    with wave.open(TRACK) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).reshape(-1, 2).astype(np.float32) / 32768
    n = int(SR * DUR); mix = np.zeros((n, 2), np.float32); mix[:min(n, len(x))] = x[:n]
    b, a = butter(2, 2000 / (SR / 2), "high")
    def put(sig, t0, g):
        i = int(t0 * SR); j = min(n, i + len(sig)); mix[i:j] += (sig[: j - i] * g)[:, None]
    tw = np.arange(int(0.6 * SR)) / SR
    put(lfilter(b, a, rng.normal(0, 1, tw.size)) * (tw / tw[-1]) ** 3, t_logo - 0.6, 0.12)
    th = np.arange(int(2.5 * SR)) / SR
    put(np.sin(2 * np.pi * np.cumsum(32 + 70 * np.exp(-th * 9)) / SR) * np.exp(-th * 2) * 0.45
        + lfilter(b, a, rng.normal(0, 1, th.size)) * np.exp(-th * 2.5) * 0.08, t_logo, 1.0)
    fo = int(2.0 * SR); mix[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5
    pk = np.abs(mix).max(); mix *= 0.98 / pk if pk > 0.98 else 1
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mix * 32767).astype(np.int16).tobytes())

if __name__ == "__main__":
    edl = build_edl()
    print(f"tempo {TEMPO:.1f}, {len(BROLL)} b-roll, clips: {[os.path.basename(c) for c in CLIPS]}")
    for e in edl: print(f"  {e[0]:6.2f}-{e[1]:6.2f} {e[2]}")
    if "--stills" in sys.argv:
        sd = os.path.join(HERE, "stills"); os.makedirs(sd, exist_ok=True)
        for ts in sys.argv[sys.argv.index("--stills") + 1:]:
            Image.fromarray(render_frame(int(float(ts) * FPS), edl)).save(os.path.join(sd, f"v2_t{float(ts):05.2f}.png"))
        sys.exit(0)
    nproc = 7; bounds = np.linspace(0, NF, nproc + 1).astype(int)
    with mp.get_context("fork").Pool(nproc) as pool:
        paths = pool.map(worker, [(k, bounds[k], bounds[k + 1]) for k in range(nproc)])
    lst = os.path.join(BUILD, "chunks.txt"); open(lst, "w").write("".join(f"file '{p}'\n" for p in paths))
    wav = os.path.join(BUILD, "mix90.wav"); build_audio(wav, edl[-1][0])
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-i", wav, "-map", "0:v", "-map", "1:a",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{DUR}", "-movflags", "+faststart", OUT + ".tmp.mp4"], check=True); os.replace(OUT + ".tmp.mp4", OUT)
    print("wrote", OUT)
