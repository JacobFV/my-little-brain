#!/usr/bin/env python
"""My Little Brain: v3 story video (about 2 min).

Uses the deck look (blurred warm color field, white Inter Tight type), real app screen
recordings with annotation pills, photoreal b-roll bursts (fal/Kling clips and CC photos),
three.js explainer renders (media/viz/out), a QuantumNeuroXAI paper segment with
highlighter swipes, and a CC credits card. The music is the full "1984 / Mechanical Heart"
track, used continuously from the start with a fade-out at the end.

    research/.venv/bin/python media/make_video_v3.py               # full render
    research/.venv/bin/python media/make_video_v3.py --stills 5 20  # preview frames -> media/stills/v3_*.png

Frames are rendered in parallel chunks and streamed to ffmpeg; nothing is held in RAM.
"""
import glob, json, math, os, re, subprocess, sys, wave
import multiprocessing as mp
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import make_video as mv  # reuse: real brain frames, EEG + gate-creation animations
mv.caption = lambda *a, **k: None  # no small labels in the reused animations

W, H, FPS, SR = 1920, 1080, 30, 44100
B3 = os.path.join(mv.BUILD, "v3"); os.makedirs(B3, exist_ok=True)
OUT = os.path.join(HERE, "my-little-brain-v3.mp4")
SONG = (glob.glob(os.path.expanduser("~/Downloads/1984 Mechanical Heart*.mp3")) or [None])[0]
WHITE = (255, 255, 255)

# make_video.py swaps glyphs Avenir lacks; Inter Tight has them all, so only swap for Avenir.
_SUB = mv._SUB
def _text(self, xy, text, *a, **k):
    f = k.get("font") if "font" in k else (a[1] if len(a) > 1 else None)
    if f is None or "InterTight" not in getattr(f, "path", ""): text = text.translate(_SUB)
    return mv._t0(self, xy, text, *a, **k)
def _tlen(self, text, *a, **k):
    f = k.get("font") if "font" in k else (a[0] if a else None)
    if f is None or "InterTight" not in getattr(f, "path", ""): text = text.translate(_SUB)
    return mv._l0(self, text, *a, **k)
ImageDraw.ImageDraw.text = _text; ImageDraw.ImageDraw.textlength = _tlen

# ------------------------------------------------------------------ type
FONT_PATH = os.path.join(mv.BUILD, "fonts", "InterTight.ttf")
if not os.path.exists(FONT_PATH):
    os.makedirs(os.path.dirname(FONT_PATH), exist_ok=True)
    subprocess.run(["curl", "-sL", "-o", FONT_PATH, "https://github.com/google/fonts/raw/main/ofl/intertight/InterTight%5Bwght%5D.ttf"], check=True)
_fc = {}
def IT(size, weight="Bold"):
    k = (size, weight)
    if k not in _fc:
        f = ImageFont.truetype(FONT_PATH, size); f.set_variation_by_name(weight); _fc[k] = f
    return _fc[k]

def draw_tight(d, xy, text, f, fill=WHITE, track=-0.03, shadow=False):
    """Draw with tight tracking like the deck (letter-spacing ~ -.035em). Returns width."""
    x, y = xy; sp = track * f.size
    if shadow:
        _draw_run(d, (x, y + 3), text, f, (60, 20, 70, 70) if d.im.mode == "RGBA" else (140, 100, 160), sp)
    return _draw_run(d, (x, y), text, f, fill, sp)
def _draw_run(d, xy, text, f, fill, sp):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill); x += d.textlength(ch, font=f) + sp
    return x - xy[0] - sp
def tight_len(d, text, f, track=-0.03):
    return sum(d.textlength(c, font=f) for c in text) + track * f.size * (len(text) - 1)

# ------------------------------------------------------------------ deck color field
BLOBS = [(-40, 40, 620, 820, "#ff3b2f"), (120, -120, 520, 520, "#ffcf6b"), (640, 200, 820, 760, "#b07de0"),
         (900, 520, 640, 620, "#ff6a1a"), (1180, 240, 420, 560, "#ffd36e"), (780, 640, 420, 420, "#ff4f8b"),
         (1720, -60, 520, 520, "#c78cff"), (1500, 900, 700, 460, "#6fa8ff"), (-160, 760, 520, 460, "#7fb2ff")]
def hexc(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
def field(t, frame=(1.0, 0, 0), dim=0.0):
    """frame = (zoom, dx, dy) re-frames the one field like the deck slides do."""
    s = 8; z, fx, fy = frame
    im = Image.new("RGB", (W // s, H // s), (207, 220, 251)); d = ImageDraw.Draw(im)
    for i, (x, y, w, h, c) in enumerate(BLOBS):
        ox = 40 * math.sin(t * 0.35 + i * 1.7); oy = 30 * math.cos(t * 0.28 + i * 2.3)
        cx = (x + w / 2 + ox - W / 2) * z + W / 2 + fx; cy = (y + h / 2 + oy - H / 2) * z + H / 2 + fy
        rw, rh = w * z / 2, h * z / 2
        d.ellipse([(cx - rw) / s, (cy - rh) / s, (cx + rw) / s, (cy + rh) / s], fill=hexc(c))
    # blur + upscale in float so the gradients don't band, then dither to 8 bit
    from scipy.ndimage import gaussian_filter
    small = gaussian_filter(np.asarray(im).astype(np.float32), sigma=(110 / s / 1.6, 110 / s / 1.6, 0), mode="nearest")
    if dim: small = small * (1 - dim) + np.array([40, 20, 60], np.float32) * dim
    big = np.stack([np.asarray(Image.fromarray(small[..., c], "F").resize((W, H), Image.BICUBIC)) for c in range(3)], -1)
    big += DITHER[int(t * 30) % len(DITHER)]
    return Image.fromarray(big.clip(0, 255).astype(np.uint8))
_rng = np.random.default_rng(3)
DITHER = [_rng.uniform(-2.5, 2.5, (H, W, 1)).astype(np.float32) for _ in range(4)]

# ------------------------------------------------------------------ music: beats + one 32-beat splice
SONG_WAV = os.path.join(B3, "song.wav")
if not os.path.exists(SONG_WAV):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", SONG, "-t", "200", "-ar", str(SR), "-ac", "2", SONG_WAV], check=True)
def _beats():
    cache = os.path.join(B3, "beats.npy")
    if os.path.exists(cache): return np.load(cache)
    import librosa
    y, sr = librosa.load(SONG_WAV, sr=22050)
    _, b = librosa.beat.beat_track(y=y, sr=sr, units="time", start_bpm=108)
    np.save(cache, b); return b
OB = _beats(); BEAT = float(np.median(np.diff(OB)))
BEATS = OB  # continuous song, no splice
def snap(t): return float(BEATS[np.argmin(np.abs(BEATS - t))])
DUR = round(snap(127.0), 3)  # end on a beat
NF = int(round(DUR * FPS)); DUR = NF / FPS

# ------------------------------------------------------------------ media sources (decoded to JPEG once)
def frames_of(path, fps=30, w=None, crop_top=0.0):
    name = os.path.splitext(os.path.basename(path))[0]
    d = os.path.join(B3, "frames", name)
    done = os.path.join(d, "done")
    if not os.path.exists(done) or os.path.getmtime(done) < os.path.getmtime(path):
        ok = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True)
        if ok.returncode != 0 or not ok.stdout.strip(): print("skip (unreadable / still rendering):", path); return []
        for old in glob.glob(os.path.join(d, "f*.jpg")): os.remove(old)
        os.makedirs(d, exist_ok=True)
        vf = f"fps={fps}" + (f",crop=iw:ih*{1 - crop_top:.3f}:0:ih*{crop_top:.3f},scale=1920:1080" if crop_top else "") + (f",scale={w}:-2" if w else "")
        r = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-vf", vf, "-q:v", "3", os.path.join(d, "f%04d.jpg")])
        if r.returncode != 0: print("skip (decode failed):", path); return []
        open(done, "w").write("ok")
    return sorted(glob.glob(os.path.join(d, "f*.jpg")))

APP = {os.path.basename(p)[:2]: p for p in glob.glob(os.path.join(HERE, "app-clips", "*.mp4"))}
FAL = {os.path.basename(p)[:2]: p for p in glob.glob(os.path.join(HERE, "fal", "*.mp4")) if not os.path.basename(p).startswith("hook")}
HOOK = {os.path.basename(p)[5:7]: p for p in glob.glob(os.path.join(HERE, "fal", "hook-*.mp4"))}  # new hook clips
VIZ = {os.path.splitext(os.path.basename(p))[0]: p for p in glob.glob(os.path.join(HERE, "viz", "out", "*.mp4"))}
BROLL = {os.path.basename(p)[:2]: p for p in glob.glob(os.path.join(HERE, "broll", "*.jpg"))}
SRC = {}  # key -> list of frame paths (videos) or [image path]
def prepare():
    jobs = []
    for k, p in APP.items(): jobs.append((f"app{k}", p, 30, None, 0.0))
    for k, p in FAL.items(): jobs.append((f"fal{k}", p, 24, None, 0.24 if k == "01" else 0.0))  # 01: drop garbled headband text
    for k, p in VIZ.items(): jobs.append((f"viz-{k}", p, 30, None, 0.0))
    for k, p in HOOK.items(): jobs.append((f"hook{k}", p, 24, None, 0.0))
    with mp.get_context("fork").Pool(6) as pool:
        res = pool.starmap(frames_of, [(j[1], j[2], j[3], j[4]) for j in jobs])
    for j, r in zip(jobs, res): SRC[j[0]] = r
    for k, p in BROLL.items(): SRC[f"img{k}"] = [p]

def src_frame(key, t, fps):
    fr = SRC.get(key)
    if not fr: return None
    return Image.open(fr[min(len(fr) - 1, int(t * fps))]).convert("RGB")

_cov = {}
def cover(key, t=0.0, fps=24):
    """Source as a 1.15x-oversized 16:9 RGB image (stills cached)."""
    if key.startswith("img"):
        if key not in _cov:
            if len(_cov) > 24: _cov.clear()
            _cov[key] = _fit(Image.open(SRC[key][0]).convert("RGB"))
        return _cov[key]
    im = src_frame(key, t, fps)
    return _fit(im) if im is not None else None
def _fit(im):
    tw, th = int(W * 1.15), int(H * 1.15); s = max(tw / im.size[0], th / im.size[1])
    im = im.resize((int(im.size[0] * s) + 1, int(im.size[1] * s) + 1), Image.BILINEAR)
    x, y = (im.size[0] - tw) // 2, (im.size[1] - th) // 2
    return im.crop((x, y, x + tw, y + th))

# ------------------------------------------------------------------ renderers
def ease(x): x = min(max(x, 0.0), 1.0); return 1 - (1 - x) ** 3

def title_block(im, tl, title, sub=None, x=110, y=58, size=84):
    """deck title: white Inter Tight bold, top-left, nothing else."""
    if not title: return
    d = ImageDraw.Draw(im); k = ease(tl / 0.35)
    draw_tight(d, (x, y + (1 - k) * 30), title, IT(size, "Bold"), track=-0.035)

def r_card(tl, dur, p, T):
    """deck-style text card on the color field; optional real brain."""
    im = field(T, p.get("frame", (1.0, 0, 0)))
    d = ImageDraw.Draw(im)
    lines = p["lines"]; size = p.get("size", 132); lh = int(size * 1.0)
    y0 = p.get("y", (H - lh * len(lines)) // 2 - 20)
    for i, l in enumerate(lines):
        k = ease((tl - 0.08 * i) / 0.4)
        if k <= 0: continue
        f = IT(size, "Bold"); tw = tight_len(d, l, f, -0.035)
        x = (W - tw) / 2 if p.get("align", "c") == "c" else 110
        draw_tight(d, (x, y0 + i * lh + (1 - k) * 40), l, f, track=-0.035)
    if p.get("sub") and tl > 0.25:
        f = IT(36, "Medium"); tw = tight_len(d, p["sub"], f, -0.01)
        x = (W - tw) / 2 if p.get("align", "c") == "c" else 116
        draw_tight(d, (x, y0 + len(lines) * lh + 30), p["sub"], f, track=-0.01)
    return im

def paste_brain(im, T, cx, cy, h):
    fr = mv.brain_frame(T).crop(mv.BRAIN_BOX); w = int(fr.size[0] * h / fr.size[1])
    B = fr.resize((w, int(h)), Image.BICUBIC)
    mv.comp_brain(im, B, cx - w / 2, cy - h / 2, boost=1.9, glow_k=0.0)  # no glow

def r_brand(tl, dur, p, T):
    """deck slide 1: real brain centred, "My Little Brain" as one line beneath it."""
    im = field(T, (1.05, 0, 0)); d = ImageDraw.Draw(im)
    paste_brain(im, T, W / 2, 400, 600 * (1 + 0.03 * tl / dur))
    f = IT(140, "Bold"); k = ease(tl / 0.4); t = "My Little Brain"; tw = tight_len(d, t, f, -0.035)
    draw_tight(d, ((W - tw) / 2, 760 + (1 - k) * 30), t, f, track=-0.035)
    return im

def r_photo(tl, dur, p, T):
    """photoreal burst: switch every beat, with half-beat double taps (1.8-3.6 Hz)."""
    srcs = p["srcs"]; t0 = p["_t0"]
    # cut points: beats inside the segment, plus a half-beat tap every third beat
    bl = [b - t0 for b in BEATS if t0 - 1e-3 <= b < t0 + dur]
    if not bl or bl[0] > 0.01: bl = [0.0] + bl
    cuts = []
    for i, b in enumerate(bl):
        cuts.append(b)
        if p.get("fast", True) and i % 3 == 2: cuts.append(b + BEAT / 2)
    if p.get("slow"): cuts = cuts[::2]
    ci = max(i for i, c in enumerate(cuts) if c <= tl + 1e-6); local = tl - cuts[ci]
    key = srcs[(ci + p.get("off", 0)) % len(srcs)]
    im0 = cover(key, local + (0.8 if key.startswith("fal") else 0), 24)
    if im0 is None: im0 = cover(srcs[0], local, 24) if cover(srcs[0], 0, 24) is not None else field(T)
    sw, sh = im0.size; z = 1.0 + 0.10 * min(1, local / 1.2)
    cw, ch = W * 1.0 / z * 1.0, H / z
    ox = (sw - cw) * (0.5 + 0.45 * math.sin(ci * 2.1)); oy = (sh - ch) * (0.5 + 0.45 * math.cos(ci * 1.3))
    im = im0.crop((int(ox), int(oy), int(ox + cw), int(oy + ch))).resize((W, H), Image.BILINEAR)
    if local < 0.06: im = Image.blend(im, Image.new("RGB", (W, H), WHITE), 0.45 * (1 - local / 0.06))
    if p.get("text"):
        # warm wash so the white type reads, then deck type
        a = np.asarray(im).astype(np.float32); g = np.linspace(0.15, 0.55, H)[:, None, None]
        a = a * (1 - g) + np.array([60, 25, 70], np.float32) * g
        im = Image.fromarray(a.clip(0, 255).astype(np.uint8)); d = ImageDraw.Draw(im)
        lines = p["text"]; size = p.get("size", 120); f = IT(size, "Bold")
        for i, l in enumerate(lines):
            k = ease((tl - 0.1 * i) / 0.4)
            if k <= 0: continue
            tw = tight_len(d, l, f, -0.035)
            draw_tight(d, ((W - tw) / 2, H - 170 - (len(lines) - i) * size * 1.02 + (1 - k) * 30), l, f, track=-0.035)
    return im

# ------------------------------------------------------------------ the hook (0 -> brand card)
# Every shot is a different source. Cuts build: 2 beats per shot in the quiet intro, 1 beat once the
# drums come in, then half-beats into the brand reveal. Each shot pushes forward and speed-ramps
# (fast -> slow), so motion carries across cuts instead of flashes.
def hook_shots():
    H_ = lambda k: ("hook" + k, 0.4)
    plan = {
        "slow": ["hook07", "hook01", "hook08"],                                                      # 2 beats each
        "beat": ["hook02", "hook04", "app01:eyes", "hook03", "fal03", "viz-hero-orbit", "viz-tractometry"],  # 1 beat each
        "half": ["app02:typing", "app03:tools", "viz-extraction", "hook06", "fal06", "app04:circuit",
                 "viz-qaoa", "hook05", "img33", "fal09", "img38", "fal10"],                         # half beats -> brand
    }
    return plan
APP_CROPS = {"eyes": ("app01", 7.0, (740, 480, 720)), "typing": ("app02", 3.0, (740, 790, 900)),
             "tools": ("app03", 6.5, (560, 690, 860)), "circuit": ("app04", 1.5, (1380, 670, 600))}
VIZ_START = {"viz-hero-orbit": 2.5, "viz-tractometry": 4.5, "viz-extraction": 6.0, "viz-qaoa": 8.5}
def hook_cuts(t0, t1):
    """list of (start, end, source) in video time."""
    b = [x for x in BEATS if t0 - 1e-3 <= x <= t1 + 1e-3]
    b = [t0] + [x for x in b if x > t0 + 0.05]
    if b[-1] < t1 - 0.05: b.append(t1)
    plan = hook_shots(); cuts = []; i = 0
    slow_end, beat_end = snap(6.2), snap(10.0)
    srcs = plan["slow"] + plan["beat"] + plan["half"]; si = 0
    t = t0
    while t < t1 - 0.05 and si < len(srcs):
        if t < slow_end - 0.05: step = 2 * BEAT
        elif t < beat_end - 0.05: step = BEAT
        else: step = BEAT / 2
        e = min(t1, t + step)
        if t < slow_end - 0.05 and e > slow_end: e = slow_end
        if t < beat_end - 0.05 and e > beat_end: e = beat_end
        cuts.append((t, e, srcs[si])); si += 1; t = e
    if t < t1 - 0.01: cuts[-1] = (cuts[-1][0], t1, cuts[-1][2])
    return cuts
_hook_cache = {}
_MY, _MX = np.mgrid[0:H // 8, 0:W // 8].astype(np.float32)
def blob_mask(u, seed, sd):
    """soft, wobbling blob that grows from a point to beyond the frame over the first part of a shot."""
    from scipy.ndimage import gaussian_filter
    rs = np.random.default_rng(seed); cx, cy = (0.35 + 0.3 * rs.random()) * W / 8, (0.35 + 0.3 * rs.random()) * H / 8
    grow = 0.75 if sd > 0.5 else 0.85  # fraction of the shot spent opening
    x = min(1.0, u / grow); k = x * x * (3 - 2 * x)  # smoothstep: visibly grows, field stays around it
    r = (0.07 + 0.66 * k) * W / 8
    dx, dy = _MX - cx, _MY - cy; th = np.arctan2(dy, dx); ph = rs.random() * 6.28
    rr = r * (1 + 0.16 * np.sin(3 * th + ph + 4 * u) + 0.09 * np.sin(5 * th - ph + 6 * u))
    m = np.clip((rr - np.hypot(dx, dy)) / (0.35 * r + 4) + 0.5, 0, 1)
    m = gaussian_filter(m, 2.0)
    big = np.asarray(Image.fromarray(m.astype(np.float32), "F").resize((W, H), Image.BILINEAR))
    return big[..., None]

def r_white(tl, dur, p, T):
    return Image.new("RGB", (W, H), WHITE)

def r_morph(tl, dur, p, T):
    """the deck color field distorts its way into presence: blobs bloom from nothing, ripple, settle."""
    from scipy.ndimage import gaussian_filter, map_coordinates
    s = 8; u = min(1.0, tl / dur)
    im = Image.new("RGB", (W // s, H // s), (207, 220, 251)); d = ImageDraw.Draw(im)
    for i, (x, y, w, h, c) in enumerate(BLOBS):
        k = ease((u - 0.06 * i) / 0.55)
        if k <= 0: continue
        ox = 40 * math.sin(T * 0.35 + i * 1.7); oy = 30 * math.cos(T * 0.28 + i * 2.3)
        cx, cy = x + w / 2 + ox, y + h / 2 + oy
        sc = k * (1 + 0.15 * math.sin(k * math.pi))  # bloom with a slight overshoot
        rw, rh = w * sc / 2, h * sc / 2
        d.ellipse([(cx - rw) / s, (cy - rh) / s, (cx + rw) / s, (cy + rh) / s], fill=hexc(c))
    a = np.asarray(im).astype(np.float32)
    # liquid warp: turbulence-like displacement that calms as the field settles
    amp = 9.0 * (1 - ease(u / 0.9)) + 0.5
    yy, xx = np.mgrid[0:H // s, 0:W // s].astype(np.float32)
    wx = xx + amp * (np.sin(yy / 6.0 + tl * 3.1) + 0.6 * np.sin((xx + yy) / 9.0 - tl * 2.3))
    wy = yy + amp * (np.cos(xx / 7.0 - tl * 2.7) + 0.6 * np.sin((xx - yy) / 8.0 + tl * 1.9))
    a = np.stack([map_coordinates(a[..., c], [wy, wx], order=1, mode="nearest") for c in range(3)], -1)
    sig = (110 / s / 1.6) * (1.8 - 0.8 * ease(u))  # blur eases down to the field's own softness
    a = gaussian_filter(a, sigma=(sig, sig, 0), mode="nearest")
    big = np.stack([np.asarray(Image.fromarray(a[..., c], "F").resize((W, H), Image.BICUBIC)) for c in range(3)], -1)
    wv = 1 - ease(u / 0.7)  # fade up from pure white
    big = big * (1 - wv) + 255 * wv + DITHER[int(T * 30) % len(DITHER)]
    return Image.fromarray(big.clip(0, 255).astype(np.uint8))
def r_hook(tl, dur, p, T):
    key0 = (p["_t0"], dur)
    if key0 not in _hook_cache: _hook_cache[key0] = hook_cuts(p["_t0"], p["_t0"] + dur)
    cuts = _hook_cuts = _hook_cache[key0]
    c = next((c for c in cuts if c[0] <= T < c[1]), cuts[-1])
    l, sd, src = T - c[0], c[1] - c[0], c[2]
    u = min(1.0, l / max(sd, 1e-3))
    # speed ramp: fast in, settle (integral of v(u) = 1.9 - 1.1u)
    st = sd * (1.9 * u - 0.55 * u * u)
    z = 1.0 + 0.10 * (1 - (1 - u) ** 2)  # forward push on every shot
    if ":" in src:
        k, sub = src.split(":"); clip, start, (cx, cy, cw) = APP_CROPS[sub]
        fr = src_frame(clip, start + st, 30); ch = cw * 9 / 16; cw2, ch2 = cw / z, ch / z
        cx = min(max(cx, cw2 / 2), 1600 - cw2 / 2); cy = min(max(cy, ch2 / 2), 900 - ch2 / 2)
        im = fr.crop((int(cx - cw2 / 2), int(cy - ch2 / 2), int(cx + cw2 / 2), int(cy + ch2 / 2))).resize((W, H), Image.BICUBIC)
    elif src.startswith("viz-"):
        fr = src_frame(src, VIZ_START.get(src, 2) + st * 1.5, 30)
        zz = VIZ_ZOOM * z; cw2, ch2 = W / zz, H / zz
        im = fr.resize((W, H)).crop((int((W - cw2) / 2), int((H - ch2) / 2), int((W + cw2) / 2), int((H + ch2) / 2))).resize((W, H), Image.BICUBIC)
    else:
        if src.startswith("img"): base = cover(src)
        else:
            fr = src_frame(src, 0.6 + st, 24)
            base = _fit(fr if not src == "fal01" else fr)
        sw, sh = base.size; cw2, ch2 = W / z, H / z
        im = base.crop((int((sw - cw2) / 2), int((sh - ch2) / 2), int((sw + cw2) / 2), int((sh + ch2) / 2))).resize((W, H), Image.BILINEAR)
    # push through the field: the shot appears inside a soft organic blob that grows from depth
    m = blob_mask(u, hash(src) % 997, sd)
    fa = np.asarray(field(T)).astype(np.float32)
    sa = np.asarray(im).astype(np.float32)
    im = Image.fromarray((fa * (1 - m) + sa * m).clip(0, 255).astype(np.uint8))
    # the question, one big line at a time
    line = None
    for (a, b, txt) in p.get("lines", []):
        if a <= T < b: line, la = txt, T - a
    if line:
        arr = np.asarray(im).astype(np.float32); g = np.clip((np.arange(H) - H * 0.5) / (H * 0.5), 0, 1)[:, None, None] * 0.55
        im = Image.fromarray((arr * (1 - g) + np.array([30, 15, 40], np.float32) * g).clip(0, 255).astype(np.uint8))
        d = ImageDraw.Draw(im); f = IT(130, "Bold"); tw = tight_len(d, line, f, -0.035)
        draw_tight(d, ((W - tw) / 2, H - 290 + (1 - ease(la / 0.4)) * 24), line, f, track=-0.035)
    return im

# annotated real-app recording ------------------------------------------------
# The rounded frame and the recording are ONE rigid card: the whole card pushes in slowly
# against the color field; the recording is never cropped or zoomed inside its frame.
CW0, CH0 = 1440, 810
def pill(d, im, x, y, text, k, align="r"):
    f = IT(27, "SemiBold"); tw = tight_len(d, text, f, -0.005); pw, ph = tw + 34, 46
    px = x - pw if align == "r" else x
    px = min(max(px, 24), W - 24 - pw)
    py = y - ph / 2 + (1 - k) * 12
    ov = Image.new("RGBA", (int(pw) + 8, ph + 8), (0, 0, 0, 0)); od = ImageDraw.Draw(ov)
    od.rounded_rectangle([4, 4, pw + 3, ph + 3], radius=23, fill=(52, 26, 72, int(225 * k)))
    im.paste(ov, (int(px) - 4, int(py) - 4), ov)
    draw_tight(d, (px + 17, py + 7), text, f, fill=(255, 255, 255), track=-0.005)
    return (px, py, pw, ph)

def r_app(tl, dur, p, T):
    im = field(T, p.get("frame", (1.1, -80, 40)))
    key = p["clip"]; rate = p.get("rate", 1.0); ct = p.get("start", 0.0) + tl * rate
    fr = src_frame(key, ct, 30)
    if fr is None: return r_card(tl, dur, dict(lines=[p.get("title", "")]), T)
    s = 0.93 + 0.07 * ease(tl / dur) if p.get("push", True) else 1.0
    cw, ch = int(CW0 * s), int(CH0 * s)
    cx, cy = W / 2 + p.get("dx", 0), 600
    if p.get("rise"): cy += (1 - ease(tl / 0.8)) * 700
    x0, y0 = int(cx - cw / 2), int(cy - ch / 2)
    card = fr.resize((cw, ch), Image.BICUBIC)
    mask = Image.new("L", (cw, ch), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, cw - 1, ch - 1], radius=int(28 * s), fill=255)
    im.paste(card, (x0, y0), mask)
    def to_screen(px, py): return x0 + px / 1600 * cw, y0 + py / 900 * ch
    d = ImageDraw.Draw(im)
    title_block(im, tl, p.get("title"))
    for a in p.get("pills", []):
        t0 = a["t"]; t1 = a.get("until", dur + 1)
        if not (t0 <= tl < t1): continue
        k = min(ease((tl - t0) / 0.3), min(1.0, (t1 - tl) / 0.2))
        tx, ty = to_screen(*a["at"])
        side = a.get("side", "l"); py = a.get("y", ty)
        px = x0 - 24 if side == "l" else x0 + cw + 24
        bx = pill(d, im, px, py, a["text"], k, "r" if side == "l" else "l")
        sx = bx[0] + bx[2] if side == "l" else bx[0]
        u = ease((tl - t0 - 0.1) / 0.35)
        if k > 0.2:
            d.line([(sx, py), (sx + (tx - sx) * u, py + (ty - py) * u)], fill=(255, 255, 255), width=3)
            if tl - t0 > 0.4: d.ellipse([tx - 7, ty - 7, tx + 7, ty + 7], fill=(255, 255, 255))
    if p.get("logos") and tl >= p["logos"]:
        draw_logos(im, d, tl - p["logos"], x0 + cw + 30, y0)
    if p.get("quote") and tl > 0.2:
        f = IT(30, "Medium"); q = p["quote"]; tw = tight_len(d, q, f, -0.005)
        y = y0 + ch - 80; d.rounded_rectangle([(W - tw) / 2 - 24, y, (W + tw) / 2 + 24, y + 52], radius=26, fill=(52, 26, 72))
        d.text(((W - tw) / 2, y + 8), q, font=f, fill=WHITE)
    return im

LOGO_CACHE = None
def logos():
    global LOGO_CACHE
    if LOGO_CACHE is None:
        LOGO_CACHE = []
        for key, label in [("ionq", ""), ("ibm", ""), ("qbraid", ""), ("extropic", "")]:
            c = glob.glob(os.path.join(HERE, "logos", f"{key}-white.*"))
            if not c: continue
            pth = c[0]
            if pth.endswith(".svg"):
                png = os.path.join(B3, f"logo-{key}.png"); subprocess.run(["rsvg-convert", "-h", "84", pth, "-o", png], check=True); pth = png
            L = Image.open(pth).convert("RGBA"); s = 64 / L.size[1]
            if L.size[0] * s > 250: s = 250 / L.size[0]
            LOGO_CACHE.append((L.resize((int(L.size[0] * s), int(L.size[1] * s)), Image.LANCZOS), label))
    return LOGO_CACHE
def draw_logos(im, d, tl, x, y0):
    for i, (L, label) in enumerate(logos()):
        k = ease((tl - 0.28 * i) / 0.3)
        if k <= 0: continue
        y = y0 + 40 + i * 150
        a = L.split()[3].point(lambda v: int(v * k)); im.paste(L, (int(min(x, W - L.size[0] - 20)), int(y)), a)

VIZ_ZOOM = 1.4  # crops away the renders' own small corner labels; keeps the 3D scene
INK = (42, 24, 56)
def r_viz(tl, dur, p, T):
    key = p["viz"]; fr = None
    if key in SRC:
        n = len(SRC[key]); rate = p.get("rate", max(1.0, n / 30 / dur))
        fr = src_frame(key, p.get("start", 0) + tl * rate, 30)
    if fr is None:
        im = mv.RENDER[p.get("fallback", "hist")](tl, dur, dict(cap=""), T)
    else:
        im = fr.resize((W, H)) if fr.size != (W, H) else fr
        z = VIZ_ZOOM; cw, ch = W / z, H / z; cy = p.get("cy", 540)
        im = im.crop((int((W - cw) / 2), int(cy - ch / 2), int((W + cw) / 2), int(cy + ch / 2))).resize((W, H), Image.BICUBIC)
    # a few big words, one short line at a time (deck-title style)
    words = p.get("words", [])
    if words:
        d = ImageDraw.Draw(im); i = min(len(words) - 1, int(tl / (dur / len(words)))); lt = tl - i * dur / len(words)
        f = IT(p.get("size", 120), "Bold"); tw = tight_len(d, words[i], f, -0.035)
        k = ease(lt / 0.3); y = p.get("ty", 90) + (1 - k) * 24
        col = INK if fr is not None else WHITE
        draw_tight(d, (110 if p.get("left") else (W - tw) / 2, y), words[i], f, fill=col, track=-0.035)
    return im

def r_dark(tl, dur, p, T):
    """neon inserts from v1 (EEG traces, gates popping in), with no labels."""
    return mv.RENDER[p["kind"]](tl, dur, p.get("args", {}), T)

# the agent's real circuit: OpenQASM from research/experiments/campaigns/alpha.json,
# iterations[2] (job f8fdb905db1b4f259c25, 42 physical gates), "after" side of qasm_diff.
def agent_qasm():
    d = json.load(open(os.path.join(REPO, "research/experiments/campaigns/alpha.json")))
    it = d["iterations"][2]
    assert any(j["job_id"] == "f8fdb905db1b4f259c25" and j["physical_gates"] == 42 for j in it["jobs_run"])
    body = [l[1:] for l in it["qasm_diff"].splitlines() if l.startswith("+") and not l.startswith("+++")]
    return body
QASM_BODY = agent_qasm()
QASM_SHOWN = ["OPENQASM 2.0;", "…", "qreg q[8];", "creg meas[8];"] + QASM_BODY + ["barrier q[0],…,q[7];", "…"]
_circ = {}
def circuit_png():
    if "im" not in _circ:
        path = os.path.join(B3, "agent_circuit.png")
        if not os.path.exists(path):
            from qiskit import QuantumCircuit
            import matplotlib; matplotlib.use("Agg")
            qc = QuantumCircuit.from_qasm_str('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[8];\n' + "\n".join(QASM_BODY) + "\n")
            fig = qc.draw("mpl", style="clifford", fold=-1, scale=1.25)
            fig.savefig(path, dpi=150, facecolor="white", bbox_inches="tight")
        _circ["im"] = Image.open(path).convert("RGB")
    return _circ["im"]
MONO = "/System/Library/Fonts/Menlo.ttc"
def r_qasm(tl, dur, p, T):
    im = field(T, (1.15, 140, -40)); d = ImageDraw.Draw(im)
    title_block(im, tl, "The circuit it wrote")
    # left: the OpenQASM, typed on
    px, py, pw, ph = 110, 200, 560, 800
    d.rounded_rectangle([px, py, px + pw, py + ph], radius=24, fill=(28, 20, 40))
    f = ImageFont.truetype(MONO, 27)
    nlines = len(QASM_SHOWN); shown = tl / (dur * 0.55) * nlines
    for i, line in enumerate(QASM_SHOWN):
        if i > shown: break
        txt = line if i + 1 <= shown else line[: max(0, int(len(line) * (shown - i)))]
        col = (255, 255, 255) if 4 <= i < 4 + len(QASM_BODY) else (170, 160, 190)
        d.text((px + 34, py + 30 + i * 38), txt, font=f, fill=col)
    # right: the same circuit drawn by Qiskit, gates revealed left to right as the code types
    C = circuit_png(); s = min(1080 / C.size[0], 760 / C.size[1]); C = C.resize((int(C.size[0] * s), int(C.size[1] * s)), Image.LANCZOS)
    cx, cy = 730, 200 + (800 - C.size[1]) // 2
    d.rounded_rectangle([cx - 20, cy - 20, cx + C.size[0] + 20, cy + C.size[1] + 20], radius=24, fill=WHITE)
    u = min(1.0, max(0.0, (shown - 4) / len(QASM_BODY)))
    reveal = int(C.size[0] * (0.12 + 0.88 * u))
    im.paste(C.crop((0, 0, reveal, C.size[1])), (cx, cy))
    return im

def r_stat(tl, dur, p, T):
    im = field(T, p.get("frame", (1.2, 0, 0))); d = ImageDraw.Draw(im)
    k = ease(tl / 0.3); f = IT(250, "Bold"); big = p["big"]
    if "{n}" in big: big = big.replace("{n}", str(int(round(p["n"] * min(1, tl / 0.45)))))
    tw = tight_len(d, big, f, -0.04)
    draw_tight(d, ((W - tw) / 2, 300 + (1 - k) * 40), big, f, track=-0.04)
    f2 = IT(46, "Medium"); tw2 = tight_len(d, p["small"], f2, -0.01)
    if tl > 0.12: draw_tight(d, ((W - tw2) / 2, 640), p["small"], f2, track=-0.01)
    if p.get("foot"):
        f3 = IT(24, "Medium"); tw3 = tight_len(d, p["foot"], f3, 0)
        d.text(((W - tw3) / 2, 980), p["foot"], font=f3, fill=(255, 255, 255))
    return im

# paper ------------------------------------------------------------------------
PAPER = json.load(open(os.path.join(HERE, "paper", "highlights.json")))
PAGES = sorted(glob.glob(os.path.join(HERE, "paper", "pages", "page-*.png")))
_pg = {}
def page(n, h=None):
    k = (n, h)
    if k not in _pg:
        if len(_pg) > 16: _pg.clear()
        im = Image.open(PAGES[n - 1]).convert("RGB")
        _pg[k] = im if h is None else im.resize((int(im.size[0] * h / im.size[1]), h), Image.BILINEAR)
    return _pg[k]
def persp_coeffs(src, dst):
    A = []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    return np.linalg.solve(np.array(A, float), np.array(src, float).reshape(8))

def r_cascade(tl, dur, p, T):
    im = field(T, (1.3, 200, -60), dim=0.15)
    pages = [1, 2, 3, 8, 10, 21, 29, 34, 36, 37]
    for i, n in enumerate(pages):
        k = ease((tl - 0.12 * i) / 0.6)
        if k <= 0: continue
        pg = page(n, 560); w, h = pg.size
        # each page flies in from the right, tilted in depth, then settles into a fanned stack
        cx = 300 + i * 150 + (1 - k) * 1400; cy = 560 + 30 * math.sin(i) - (1 - k) * 120
        tilt = 0.22 * (1 - 0.6 * k); sc = 0.95 + 0.05 * k
        hw, hh = w * sc / 2, h * sc / 2
        dst = [(cx - hw, cy - hh * (1 - tilt)), (cx + hw, cy - hh), (cx + hw, cy + hh), (cx - hw, cy + hh * (1 - tilt))]
        src = [(0, 0), (w, 0), (w, h), (0, h)]
        bx0, by0 = int(min(q[0] for q in dst)), int(min(q[1] for q in dst))
        bw, bh = int(max(q[0] for q in dst)) - bx0 + 1, int(max(q[1] for q in dst)) - by0 + 1
        loc = [(q[0] - bx0, q[1] - by0) for q in dst]
        co = persp_coeffs(src, loc)
        warped = pg.transform((bw, bh), Image.PERSPECTIVE, co, Image.BILINEAR)
        m = Image.new("L", pg.size, 255).transform((bw, bh), Image.PERSPECTIVE, co, Image.BILINEAR)
        shadow = m.filter(ImageFilter.GaussianBlur(18)).point(lambda v: v // 3)
        im.paste((50, 20, 60), (bx0 + 14, by0 + 22), shadow); im.paste(warped, (bx0, by0), m)
    d = ImageDraw.Draw(im)
    title_block(im, tl, "The frontier", "QuantumNeuroXAI · Gayathri et al., Scientific Reports 16, 16863 (2026)")
    return im

def r_highlight(tl, dur, p, T):
    hl = PAPER["highlights"][p["i"]]; pg = page(hl["page"])
    x0, y0, x1, y1 = hl["bbox_px"]; bw = x1 - x0
    # camera: whole page -> the highlighted phrase
    k = ease(tl / 0.7)
    zt = min(1500 / max(bw, 400), 3.2)  # target zoom so the phrase fills ~1500 px
    z0 = H / pg.size[1]
    z = z0 + (zt - z0) * k
    cx0, cy0 = pg.size[0] / 2, pg.size[1] / 2; cx1, cy1 = (x0 + x1) / 2, (y0 + y1) / 2
    cx, cy = cx0 + (cx1 - cx0) * k, cy0 + (cy1 - cy0) * k
    cw, ch = W / z, H / z
    view = Image.new("RGB", (int(cw) + 2, int(ch) + 2), (238, 236, 232))
    view.paste(pg, (int(-(cx - cw / 2)), int(-(cy - ch / 2))))
    # highlighter swipe across each line box, multiplied in page space
    hlayer = Image.new("RGB", view.size, (255, 255, 255)); hd = ImageDraw.Draw(hlayer)
    lines = hl["line_boxes_px"]; per = 0.55 / max(1, len(lines))
    for j, (a, b, c, e) in enumerate(lines):
        u = ease((tl - 0.75 - j * per) / per)
        if u <= 0: continue
        ox, oy = -(cx - cw / 2), -(cy - ch / 2)
        hd.rectangle([a + ox - 4, b + oy - 2, a + ox - 4 + (c - a + 8) * u, e + oy + 3], fill=(255, 211, 110))
    from PIL import ImageChops
    view = ImageChops.multiply(view, hlayer)
    im = view.resize((W, H), Image.BICUBIC)
    d = ImageDraw.Draw(im)
    # source tag
    if tl > 1.1:
        f2 = IT(34, "SemiBold"); t = "they: " + hl["why"].lower() if p.get("show_why") else None
        if t:
            tw2 = d.textlength(t, font=f2); d.rounded_rectangle([(W - tw2) / 2 - 28, H - 140, (W + tw2) / 2 + 28, H - 80], radius=30, fill=(40, 30, 60))
            d.text(((W - tw2) / 2, H - 132), t, font=f2, fill=WHITE)
    return im

def r_punch(tl, dur, p, T):
    im = field(T, p.get("frame", (1.15, -120, 60))); d = ImageDraw.Draw(im)
    f0 = IT(34, "SemiBold"); k = ease(tl / 0.3)
    lines = p["us"]; f = IT(104, "Bold")
    for i, l in enumerate(lines):
        kk = ease((tl - 0.12 - 0.08 * i) / 0.35)
        if kk <= 0: continue
        tw = tight_len(d, l, f, -0.035); draw_tight(d, ((W - tw) / 2, 420 + i * 112 + (1 - kk) * 30), l, f, track=-0.035)
    if p.get("foot"):
        f3 = IT(24, "Medium"); tw3 = tight_len(d, p["foot"], f3, 0); d.text(((W - tw3) / 2, 960), p["foot"], font=f3, fill=WHITE)
    return im

def r_logo(tl, dur, p, T):
    im = field(T, (1.0, 0, 0)); d = ImageDraw.Draw(im)
    paste_brain(im, T, W / 2, 400, 600 * (1 + 0.03 * tl / dur + 0.05 * math.exp(-tl * 5)))
    f = IT(150, "Bold"); k = ease(tl / 0.45); t1 = "My Little Brain"; tw = tight_len(d, t1, f, -0.035)
    draw_tight(d, ((W - tw) / 2, 700 + (1 - k) * 50), t1, f, track=-0.035)
    if tl > 0.45:
        f2 = IT(48, "Medium"); t2 = "your brain, studying itself"; tw2 = tight_len(d, t2, f2, -0.01)
        draw_tight(d, ((W - tw2) / 2, 880), t2, f2, track=-0.01)
    if tl > 1.0:
        f3 = IT(22, "Medium"); t3 = "model hypotheses, not diagnoses · not a medical device · no quantum-advantage claim"
        tw3 = d.textlength(t3, font=f3); d.text(((W - tw3) / 2, 1010), t3, font=f3, fill=WHITE)
    return im

def credits_lines():
    rows = []
    for line in open(os.path.join(HERE, "broll", "CREDITS.md")):
        c = [x.strip() for x in line.split("|")]
        if len(c) >= 6 and c[1].endswith(".jpg"):
            title = re.sub(r"_", " ", os.path.splitext(c[2].rsplit("File:", 1)[-1])[0])
            from urllib.parse import unquote
            rows.append(f"{unquote(title)[:46]}: {c[4] or 'unknown author'}, {c[3]}")
    return rows
def r_credits(tl, dur, p, T):
    im = field(T, (1.4, 0, 120), dim=0.35); d = ImageDraw.Draw(im)
    draw_tight(d, (110, 60), "Credits", IT(64, "Bold"), track=-0.03)
    f = IT(19, "Medium"); rows = credits_lines()
    head = ["Photos: Wikimedia Commons (title: author, license). Generated b-roll: Kling 2.5 Turbo via fal.ai.",
            "Paper: Gayathri et al., “QuantumNeuroXAI”, Scientific Reports 16, 16863 (2026), doi:10.1038/s41598-026-47627-y (open access).",
            "EEG: CHB-MIT Scalp EEG Database (PhysioNet). Music: “Mechanical Heart”, 1984. Logos are trademarks of their owners."]
    for i, h in enumerate(head): d.text((112, 160 + i * 30), h, font=IT(22, "SemiBold"), fill=WHITE)
    ncol = 2; per = math.ceil(len(rows) / ncol)
    for i, r in enumerate(rows):
        c, j = divmod(i, per)
        while d.textlength(r, font=f) > 820: r = r[:-2]
        d.text((112 + c * 860, 275 + j * 32), r, font=f, fill=WHITE)
    return im

RENDER = dict(white=r_white, morph=r_morph, hook=r_hook, qasm=r_qasm, card=r_card, brand=r_brand, photo=r_photo, app=r_app, viz=r_viz, dark=r_dark, stat=r_stat,
              cascade=r_cascade, highlight=r_highlight, punch=r_punch, logo=r_logo, credits=r_credits)

# ------------------------------------------------------------------ the story (end time in s; snapped to beats)
def hl_index(text_start):
    for i, h in enumerate(PAPER["highlights"]):
        if h["text"].startswith(text_start): return i
    return 0
def build_edl():
    fal = lambda *ks: [f"fal{k}" for k in ks]
    img = lambda *ks: [f"img{k}" for k in ks]
    E = [
        # hook (quiet intro, then the beat comes in)
        (0.8, "white", dict()),
        (3.4, "morph", dict()),
        (13.4, "hook", dict(lines=[(3.9, 6.7, "what if your brain"), (6.8, 9.6, "could study itself?")])),
        # what it is
        (17.9, "brand", dict()),
        (26.8, "app", dict(clip="app01", rate=1.33, title="Meet your brain", rise=True,
                           pills=[dict(t=0.3, until=2.2, text="sign in with Google", at=(800, 470), side="l", y=470),
                                  dict(t=3.0, text="a real 3D brain that blinks", at=(740, 330), side="l", y=330),
                                  dict(t=4.4, text="your experiments & jobs", at=(180, 300), side="l", y=560),
                                  dict(t=5.6, text="your spectrogram", at=(1390, 520), side="r", y=470),
                                  dict(t=6.8, text="observed vs simulated EEG", at=(1390, 760), side="r", y=760)])),
        (34.6, "app", dict(clip="app02", rate=1.25, title="It knows you",
                           quote="“Look at my EEG and run a quantum search to explain my alpha rhythm”",
                           pills=[dict(t=0.3, text="it greets you with ideas", at=(740, 720), side="l", y=420),
                                  dict(t=2.4, text="you just ask", at=(600, 835), side="l", y=640),
                                  dict(t=5.6, text="it starts thinking", at=(848, 726), side="r", y=560)])),
        # it reads you
        (38.5, "photo", dict(srcs=fal("01", "02") + img("04", "01", "02") + fal("03") + img("03"), text=["it reads your brainwaves"], size=110)),
        (40.7, "dark", dict(kind="eeg", args=dict(cap=""))),
        (51.8, "app", dict(clip="app03", rate=1.3, title="It reasons",
                           pills=[dict(t=0.4, until=2.6, text="Gemini agent, thinking", at=(450, 836), side="l", y=760),
                                  dict(t=2.8, text="looks at your spectrograms", at=(600, 655), side="l", y=420),
                                  dict(t=4.0, text="checks running jobs", at=(560, 605), side="l", y=540),
                                  dict(t=5.2, text="queues a quantum search", at=(600, 760), side="l", y=680),
                                  dict(t=8.4, text="QAOA circuit, compiled", at=(1390, 700), side="r", y=560)])),
        # how it works
        (54.0, "viz", dict(viz="viz-hero-orbit", start=1.0, rate=0.6, fallback="net", words=["How it works"], size=140, ty=H / 2 - 90)),
        (57.6, "viz", dict(viz="viz-tractometry", start=1.0, rate=1.6, fallback="net", words=["your brain activity", "traced along white matter"])),
        (61.5, "viz", dict(viz="viz-extraction", start=0.5, rate=2.4, fallback="hist", words=["4 brain parameters", "256 possible brains"], ty=H - 170, size=104, left=True)),
        (65.0, "viz", dict(viz="viz-qaoa", start=0.5, rate=2.6, fallback="hist", words=["quantum search", "finds the best fit"])),
        (66.2, "card", dict(lines=["then it writes", "the circuit"], frame=(1.2, 160, -40))),
        (71.2, "app", dict(clip="app04", rate=2.2, title="It writes the circuit",
                           pills=[dict(t=0.4, text="8 qubits = 4 params × 2 bits", at=(1215, 640), side="r", y=420),
                                  dict(t=1.6, text="transpiled for IBM heavy-hex", at=(1390, 430), side="r", y=560),
                                  dict(t=3.0, text="measured samples → best hypothesis", at=(1300, 780), side="r", y=760)])),
        (76.2, "qasm", dict()),
        (78.4, "dark", dict(kind="circuit", args=dict(pre=0.2, title="", cap=""))),
        (80.1, "photo", dict(srcs=fal("05") + img("29", "39", "31") + fal("06") + img("37", "33"))),
        (88.5, "app", dict(clip="app05", rate=1.18, title="It dispatches the job",
                           quote="“Design a better circuit and run it on IonQ's simulator”",
                           pills=[dict(t=1.8, text="it revises its own circuit", at=(150, 452), side="l", y=420),
                                  dict(t=3.0, text="IonQ cloud simulator (trapped-ion noise)", at=(160, 500), side="l", y=560)],
                           logos=3.6, dx=-110)),
        (95.0, "app", dict(clip="app06", rate=2.0, title="Results come back",
                           pills=[dict(t=0.3, until=1.6, text="the agent explains what it found", at=(700, 540), side="l", y=480),
                                  dict(t=2.0, text="all 256 hypotheses, scored", at=(1390, 540), side="r", y=420),
                                  dict(t=4.2, text="model vs your real EEG", at=(1390, 480), side="r", y=620)])),
        # results, on the energy
        (97.3, "stat", dict(big="{n} / 256", n=48, small="simulations to recover a hidden brain state")),
        (99.6, "stat", dict(big="{n} gates", n=42, small="a circuit Gemini wrote itself", frame=(1.25, 120, -40))),
        (101.8, "stat", dict(big="52 vs 454", small="gates on IonQ vs IBM, same problem", frame=(1.3, -140, 60))),
        (104.2, "stat", dict(big="τ 16 → 30–55 ms", small="seizure windows point to slower synapses",
                             foot="one CHB-MIT recording (chb01_03): an n-of-1 observation, not a validated biomarker", frame=(1.2, 60, 90))),
        # frontier, in the quiet breakdown
        (106.4, "cascade", dict()),
        (108.6, "highlight", dict(i=hl_index("the proposed framework does not rely"))),
        (110.3, "punch", dict(them="quantum-inspired math on classical hardware", us=["Real quantum hardware,", "not quantum-inspired simulation"])),
        (112.5, "highlight", dict(i=hl_index("do not necessarily reflect"))),
        (114.2, "punch", dict(them="curated public datasets, trained offline", us=["Your own EEG,", "live in the browser"], frame=(1.2, 140, -60))),
        (116.4, "highlight", dict(i=hl_index("mostly black-box"))),
        (118.1, "punch", dict(them="classify EEG with a black box", us=["From classifying EEG", "to inferring brain mechanisms"], frame=(1.1, -60, 80))),
        (DUR - 4.4, "logo", dict()),
        (DUR, "credits", dict()),
    ]
    edl, t0 = [], 0.0
    for end, kind, p in E:
        t1 = DUR if end >= DUR - 1e-6 else snap(end)
        if t1 <= t0 + 0.2: t1 = snap(t0 + BEAT * 2)
        p = dict(p); p["_t0"] = t0
        edl.append((t0, t1, kind, p)); t0 = t1
    return edl

# ------------------------------------------------------------------ frame + post
def post(im, kind, tl, T, fi):
    return np.asarray(im.convert("RGB"))

def render_frame(fi, edl):
    T = fi / FPS
    si = max(i for i, e in enumerate(edl) if e[0] <= T + 1e-6)
    t0, t1, kind, p = edl[si]; tl, dur = T - t0, t1 - t0
    im = RENDER[kind](tl, dur, p, T)
    a = post(im, kind, tl, T, fi)
    if T > DUR - 0.8: a = (a.astype(np.float32) * max(0, (DUR - T) / 0.8)).astype(np.uint8)
    return a

def worker(args):
    k, f0, f1 = args
    edl = build_edl(); path = os.path.join(B3, f"chunk{k:02d}.mp4")
    pr = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
                           "-i", "-", "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-maxrate", "14M", "-bufsize", "28M",
                           "-pix_fmt", "yuv420p", path], stdin=subprocess.PIPE)
    for fi in range(f0, f1):
        pr.stdin.write(render_frame(fi, edl).tobytes())
    pr.stdin.close(); pr.wait(); return path

def build_audio(path):
    """the song, continuous from the start; only a fade-out at the very end."""
    with wave.open(SONG_WAV) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).reshape(-1, 2).astype(np.float32) / 32768
    n = int(DUR * SR); y = x[:n].copy()
    fo = int(3.5 * SR); y[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.3
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(y, -1, 1) * 32767).astype(np.int16).tobytes())

if __name__ == "__main__":
    prepare()
    edl = build_edl()
    print(f"beat {BEAT:.3f}s ({60 / BEAT:.1f} BPM); continuous song; duration {DUR:.2f}s; viz: {sorted(VIZ)}")
    for e in edl: print(f"  {e[0]:7.2f}-{e[1]:7.2f}  {e[2]}")
    if "--stills" in sys.argv:
        sd = os.path.join(HERE, "stills"); os.makedirs(sd, exist_ok=True)
        for ts in sys.argv[sys.argv.index("--stills") + 1:]:
            Image.fromarray(render_frame(int(float(ts) * FPS), edl)).save(os.path.join(sd, f"v3_t{float(ts):06.2f}.png"))
        sys.exit(0)
    nproc = int(os.environ.get("NPROC", "6")); bounds = np.linspace(0, NF, nproc + 1).astype(int)
    with mp.get_context("fork").Pool(nproc) as pool:
        paths = pool.map(worker, [(k, bounds[k], bounds[k + 1]) for k in range(nproc)])
    lst = os.path.join(B3, "chunks.txt"); open(lst, "w").write("".join(f"file '{p}'\n" for p in paths))
    wav = os.path.join(B3, "mix.wav"); build_audio(wav)
    tmp = OUT + ".tmp.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-i", wav, "-map", "0:v", "-map", "1:a",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{DUR}", "-movflags", "+faststart", tmp], check=True)
    os.replace(tmp, OUT)
    print("wrote", OUT, f"{DUR:.2f}s")
