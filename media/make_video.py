#!/usr/bin/env python
"""45 s hype mashup for My Little Brain. Renders frames with PIL/numpy over the
supplied synthwave soundtrack (cuts on librosa-detected beats), muxes with ffmpeg.  Run from anywhere:
    research/.venv/bin/python media/make_video.py
"""
import json, os, subprocess, sys, wave, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy.signal import lfilter, butter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BUILD = os.path.join(HERE, "build"); os.makedirs(BUILD, exist_ok=True)
OUT = os.path.join(HERE, "my-little-brain-45s.mp4")
W, H, FPS, DUR = 1920, 1080, 30, 45.0
NF = int(FPS * DUR)
SR = 44100
rng = np.random.default_rng(7)

# palette
SAGE = (226, 235, 218); SAGE2 = (137, 151, 125); CYAN = (62, 240, 255); MAG = (255, 79, 216)
DARK = (10, 14, 12); INK = (24, 34, 28); PINK = (217, 145, 168)

def font(sz, face="heavy"):
    f = {"heavy": ("/System/Library/Fonts/Avenir Next.ttc", 8),
         "bold": ("/System/Library/Fonts/Avenir Next.ttc", 0),
         "cond": ("/System/Library/Fonts/Avenir Next Condensed.ttc", 8),
         "condm": ("/System/Library/Fonts/Avenir Next Condensed.ttc", 2),
         "med": ("/System/Library/Fonts/Avenir Next.ttc", 5)}[face]
    return ImageFont.truetype(f[0], sz, index=f[1])

# ------------------------------------------------------------------ assets
def rsvg(svg_text, size, name):
    p_svg = os.path.join(BUILD, name + ".svg"); p_png = os.path.join(BUILD, name + ".png")
    open(p_svg, "w").write(svg_text)
    subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), p_svg, "-o", p_png], check=True)
    return Image.open(p_png).convert("RGBA")

FAV_SVG = open(os.path.join(REPO, "apps/web/public/favicon.svg")).read()
FAVICON = rsvg(FAV_SVG, 900, "favicon")
BEAT = 0.5572  # overwritten by detected beat grid below

# real three.js brain footage (VP9 + alpha) -> RGBA PNG frames
BRAIN_DIR = os.path.join(BUILD, "brainframes")
if not os.path.exists(os.path.join(BRAIN_DIR, "f001.png")):
    os.makedirs(BRAIN_DIR, exist_ok=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-c:v", "libvpx-vp9", "-i", os.path.join(HERE, "brain/real-brain.webm"),
                    "-vf", "fps=30", os.path.join(BRAIN_DIR, "f%03d.png")], check=True)
BRAIN_N = len([f for f in os.listdir(BRAIN_DIR) if f.endswith(".png")])
BRAIN_BOX = (290, 170, 820, 910)      # alpha bbox (~316,186,797,897) + margin
EYES_C = (565, 625)                   # midpoint between the eyeballs in source pixels
_bcache = {}
def brain_frame(t):
    i = int(t * 30) % BRAIN_N + 1
    if i not in _bcache:
        if len(_bcache) > 40: _bcache.clear()
        _bcache[i] = Image.open(os.path.join(BRAIN_DIR, f"f{i:03d}.png")).convert("RGBA")
    return _bcache[i]

SPEC = Image.open(os.path.join(REPO, "research/experiments/triage/chbmit_chb01_03_spectrograms.png")).convert("RGB")

def make_fig():
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "Avenir Next", "font.size": 22})
    fig, ax = plt.subplots(figsize=(19.2, 10.8), dpi=100)
    fig.patch.set_facecolor("#0a0e0c"); ax.set_facecolor("#0a0e0c")
    cols = {"alpha": "#3ef0ff", "theta": "#ff4fd8", "ictal": "#e2ebda"}
    for n in ["alpha", "theta", "ictal"]:
        d = json.load(open(os.path.join(REPO, f"research/experiments/campaigns/{n}.json")))
        xs = [it["forward_simulations_after"] for it in d["iterations"]]
        ys = [it["experiment_best_rank"] for it in d["iterations"]]
        ax.step([0] + xs, [ys[0]] + ys, where="post", lw={"alpha": 6, "theta": 14, "ictal": 8}[n], zorder={"alpha": 4, "theta": 2, "ictal": 3}[n], color=cols[n], label=n + ("  (CHB-MIT seizure)" if n == "ictal" else "  (hidden truth)"))
        ax.scatter(xs, ys, s=260, color=cols[n], zorder=5, edgecolor="#0a0e0c", lw=3)
    ax.set_ylim(11, 0); ax.set_yticks([1, 2, 5, 10]); ax.set_yticklabels(["#1 = truth", "#2", "#5", "#10"])
    ax.set_xlabel("forward simulations used (of 256)", color="#e2ebda", fontsize=30, labelpad=14)
    ax.set_ylabel("rank of agent's best hypothesis", color="#e2ebda", fontsize=30, labelpad=14)
    ax.tick_params(colors="#89977d", labelsize=24)
    for s in ax.spines.values(): s.set_color("#89977d")
    ax.grid(color="#89977d", alpha=0.2)
    ax.legend(facecolor="#0a0e0c", edgecolor="#89977d", labelcolor="#e2ebda", fontsize=26, loc="lower right")
    ax.set_title("real campaigns: truth found (rank 1) by iteration 2–3", color="#e2ebda", fontsize=36, pad=20, weight="bold")
    fig.tight_layout(pad=2.0)
    p = os.path.join(BUILD, "campaign_fig.png"); fig.savefig(p, facecolor=fig.get_facecolor()); plt.close(fig)
    return Image.open(p).convert("RGB").resize((W, H))
FIG = make_fig()

# ------------------------------------------------------------------ helpers
def ease(x): x = min(max(x, 0.0), 1.0); return 1 - (1 - x) ** 3
def bg(color=DARK, grid=True, gcol=None):
    im = Image.new("RGB", (W, H), color)
    if grid:
        d = ImageDraw.Draw(im); gc = gcol or tuple(int(c * 0.6 + g * 0.4) for c, g in zip(color, (40, 60, 50)))
        for x in range(0, W, 80): d.line([(x, 0), (x, H)], fill=gc, width=1)
        for y in range(0, H, 80): d.line([(0, y), (W, y)], fill=gc, width=1)
    return im
BG_DARK = bg(); BG_SAGE = bg(SAGE, gcol=(212, 224, 203)); BG_MAG = bg((40, 6, 34), gcol=(62, 16, 54))
yy, xx = np.mgrid[0:H, 0:W]
VIGN = (1 - 0.55 * (((xx - W / 2) / (W / 1.6)) ** 2 + ((yy - H / 2) / (H / 1.3)) ** 2)).clip(0.25, 1)[..., None].astype(np.float32)
SCAN = np.where((yy % 4) < 2, 1.0, 0.86)[..., None].astype(np.float32)
GRAIN = [rng.normal(0, 7, (H, W, 1)).astype(np.float32) for _ in range(6)]
del yy, xx

def caption(im, text, col=CYAN, pos="bl"):
    d = ImageDraw.Draw(im); f = font(44, "cond")
    tw = d.textlength(text, font=f); x = 70 if pos == "bl" else W - 70 - tw; y = H - 120
    d.rectangle([x - 22, y - 10, x + tw + 22, y + 62], fill=(8, 10, 9))
    d.rectangle([x - 22, y - 10, x - 14, y + 62], fill=col)
    d.text((x, y - 2), text, font=f, fill=col)

def tag(im, t):
    d = ImageDraw.Draw(im); f = font(26, "condm")
    d.text((W - 330, 44), "MY LITTLE BRAIN", font=f, fill=SAGE2)
    d.ellipse([W - 360, 52, W - 344, 68], fill=MAG if int(t / BEAT * 2) % 2 else CYAN)
    d.text((60, 44), f"REC  {t:05.2f}s   108 BPM", font=f, fill=SAGE2)

# ------------------------------------------------------------------ text cards
TEXT_CACHE = {}
def text_layer(lines, style):
    key = (tuple(lines), style)
    if key in TEXT_CACHE: return TEXT_CACHE[key]
    fg = {"dark": SAGE, "neon": CYAN, "sage": INK, "mag": SAGE, "glitch": (255, 255, 255)}[style]
    acc = {"dark": CYAN, "neon": MAG, "sage": MAG, "mag": CYAN, "glitch": MAG}[style]
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(layer)
    # auto-size: biggest font so the widest line fits 1640 px and block fits 780 px tall
    n = len(lines); sz = 260
    while sz > 40:
        f = font(sz, "heavy")
        widths = [d.textlength(l.replace("*", ""), font=f) for l in lines]
        if max(widths) <= 1640 and n * sz * 1.08 <= 760: break
        sz -= 6
    f = font(sz, "heavy"); lh = int(sz * 1.1); y0 = (H - lh * n) // 2 - int(sz * 0.12)
    for i, l in enumerate(lines):
        # segments wrapped in * are accent-coloured
        parts = l.split("*"); total = sum(d.textlength(p, font=f) for p in parts)
        x = (W - total) / 2
        for j, p in enumerate(parts):
            d.text((x, y0 + i * lh), p, font=f, fill=acc if j % 2 else fg)
            x += d.textlength(p, font=f)
    TEXT_CACHE[key] = layer
    return layer

def r_text(tl, dur, p):
    style = p.get("style", "dark")
    base = {"dark": BG_DARK, "neon": BG_DARK, "sage": BG_SAGE, "mag": BG_MAG, "glitch": BG_DARK}[style].copy()
    layer = text_layer(p["lines"], style)
    k = ease(tl / 0.18)
    s = 1.25 - 0.25 * k + 0.04 * tl / max(dur, 0.1)
    dx = {"l": -1, "r": 1}.get(p.get("slide", ""), 0) * (1 - k) * 260
    lw, lh = int(W * s), int(H * s)
    L = layer.resize((lw, lh), Image.BILINEAR)
    base.paste(L, (int((W - lw) / 2 + dx), int((H - lh) / 2)), L)
    if p.get("sub"):
        d = ImageDraw.Draw(base); f = font(46, "condm")
        tw = d.textlength(p["sub"], font=f)
        col = SAGE2 if style != "sage" else (90, 105, 80)
        d.text(((W - tw) / 2, H - 200), p["sub"], font=f, fill=col)
    return base

# ------------------------------------------------------------------ procedural scenes
EEG_FS = 250; EEG_T = np.arange(0, 60, 1 / EEG_FS)
EEG = []
for ch in range(8):
    sig = (np.sin(2 * np.pi * (9.5 + ch * 0.2) * EEG_T + ch) * (1 + 0.5 * np.sin(2 * np.pi * 0.3 * EEG_T + ch))
           + 0.5 * np.sin(2 * np.pi * 21 * EEG_T + 2 * ch) + 0.6 * np.cumsum(rng.normal(0, 0.08, EEG_T.size)) % 1.5
           + rng.normal(0, 0.35, EEG_T.size))
    burst = (EEG_T % 12 > 8) * 2.5 * np.sin(2 * np.pi * 3 * EEG_T) if ch in (2, 4) else 0
    sig = sig + burst
    EEG.append(sig - lfilter([1], [1, -0.999], sig) * 0.001)
CHN = ["Fp1", "Fp2", "C3", "C4", "T7", "P7", "O1", "O2"]

def r_eeg(tl, dur, p, T):
    im = BG_DARK.copy(); d = ImageDraw.Draw(im)
    tint = p.get("tint", "cyan")
    cols = [CYAN, SAGE, MAG, SAGE2] if tint == "cyan" else [MAG, (255, 160, 230), CYAN, SAGE]
    win = 2.2; n = int(win * EEG_FS); i0 = int(((T * 1.6 + 3) % 50) * EEG_FS)
    xs = np.linspace(170, W - 60, n)
    f = font(36, "cond")
    for ch in range(8):
        yc = 150 + ch * 105
        seg = EEG[ch][i0:i0 + n]; seg = (seg - seg.mean()) * 24
        pts = list(zip(xs, yc + seg))
        d.line(pts, fill=cols[ch % 4], width=4)
        d.text((60, yc - 22), CHN[ch], font=f, fill=SAGE2)
    # sweep head
    xh = 170 + ((T * 0.9) % 1) * (W - 230)
    d.rectangle([xh, 90, xh + 6, H - 150], fill=(255, 255, 255))
    caption(im, p.get("cap", "LIVE EEG · OPENBCI · 8 CH · 250 Hz"), cols[0])
    return im

def cmap(v):
    v = np.clip(v, 0, 1)[..., None]
    stops = np.array([[10, 14, 12], [40, 70, 60], [137, 151, 125], [62, 240, 255], [255, 79, 216], [255, 255, 255]], np.float32)
    pos = v * (len(stops) - 1); i = np.clip(pos.astype(int), 0, len(stops) - 2); fr = pos - i
    return (stops[i[..., 0]] * (1 - fr) + stops[i[..., 0] + 1] * fr).astype(np.uint8)
# waterfall: time x freq power, seizure-like bursts
WT, WF = 1600, 160
fgrid = np.linspace(0, 1, WF)[:, None]; tgrid = np.arange(WT)[None, :]
P = (0.35 * np.exp(-((fgrid - 0.22) ** 2) / 0.002) * (1 + 0.4 * np.sin(tgrid / 23))
     + 0.25 * np.exp(-fgrid * 4) + 0.08 * rng.random((WF, WT)))
burst = ((tgrid % 400) > 260) * np.exp(-((fgrid - (0.08 + 0.1 * ((tgrid % 400) - 260) / 140)) ** 2) / 0.003) * 0.9
WATER = cmap((P + burst) / 1.1)[::-1]  # low freq at bottom

def r_water(tl, dur, p, T):
    off = int(T * 60) % (WT - 400)
    crop = WATER[:, off:off + 400]
    im = Image.fromarray(crop).resize((W, H), Image.BILINEAR)
    if p.get("mag"):
        a = np.asarray(im).astype(np.float32); a = a[..., [0, 2, 1]] * np.array([1.0, 0.6, 1.0]); im = Image.fromarray(a.clip(0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im); f = font(32, "condm")
    for i, hz in enumerate([40, 30, 20, 10, 0]):
        y = int(60 + i * (H - 120) / 4); d.text((40, y), f"{hz} Hz", font=f, fill=SAGE)
    caption(im, p.get("cap", "SPECTROGRAM WATERFALL · SEIZURE BAND 3–8 Hz"), MAG)
    return im

def r_spec(tl, dur, p, T):
    k = tl / max(dur, 0.1); sw, sh = SPEC.size
    z0, z1, y0, y1 = p.get("kb", (1.0, 1.25, 0.15, 0.55))
    z = z0 + (z1 - z0) * k
    cw = sw / z; ch = cw * 9 / 16
    cy = (y0 + (y1 - y0) * k) * (sh - ch); cx = (sw - cw) / 2 + 30 * math.sin(T)
    im = SPEC.crop((int(cx), int(cy), int(cx + cw), int(cy + ch))).resize((W, H), Image.BICUBIC)
    a = np.asarray(im).astype(np.float32)
    # dark-mode the white figure: invert lightness and tint to palette
    lum = a.mean(axis=2, keepdims=True)
    a = np.where(lum > 235, np.array(DARK, np.float32), a * 0.95)
    im = Image.fromarray(a.clip(0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    # gemini vision scan box
    bx = 300 + 900 * ((tl * 0.9) % 1); by = 260 + 120 * math.sin(tl * 4)
    for (x0, y0b, sx, sy) in [(bx, by, 1, 1), (bx + 520, by, -1, 1), (bx, by + 360, 1, -1), (bx + 520, by + 360, -1, -1)]:
        d.line([(x0, y0b), (x0 + 70 * sx, y0b)], fill=CYAN, width=8); d.line([(x0, y0b), (x0, y0b + 70 * sy)], fill=CYAN, width=8)
    d.text((bx + 10, by - 56), "GEMINI VISION > ch T7-P7", font=font(40, "cond"), fill=CYAN)
    caption(im, p.get("cap", "REAL DATA · CHB-MIT chb01_03 · TRIAGE"), CYAN)
    return im

def r_fav(tl, dur, p, T):
    im = BG_SAGE.copy() if p.get("light") else BG_DARK.copy()
    s = 0.62 + 0.12 * tl / max(dur, .1) + 0.03 * math.exp(-((T / BEAT) % 1) * 6)
    sz = int(900 * s); L = FAVICON.resize((sz, sz), Image.BICUBIC).rotate(4 * math.sin(T * 3), resample=Image.BICUBIC)
    glow = Image.new("RGBA", (sz, sz), CYAN + (0,)); g = L.split()[3].filter(ImageFilter.GaussianBlur(40))
    glow.putalpha(g)
    im.paste(glow, ((W - sz) // 2, (H - sz) // 2), glow)
    im.paste(L, ((W - sz) // 2, (H - sz) // 2), L)
    caption(im, p.get("cap", "apps/web · favicon.svg"), MAG)
    return im

# ------------------------------------------------------------------ real 3D brain compositing
def _blur_bg():
    s = Image.new("RGB", (W // 8, H // 8), DARK); d = ImageDraw.Draw(s)
    for (x, y, r, c) in [(40, 30, 50, CYAN), (200, 100, 60, MAG), (130, 60, 35, SAGE2), (220, 20, 30, CYAN), (30, 120, 40, MAG)]:
        d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(int(v * 0.55) for v in c))
    return s.filter(ImageFilter.GaussianBlur(22)).resize((W, H), Image.BICUBIC)
BG_BLUR = _blur_bg()

def comp_brain(base, B, x, y, glow=CYAN, tint=None, boost=1.7, glow_k=0.8):
    """paste RGBA brain image B at (x, y) on RGB base with neon glow."""
    r, g, b, a = B.split()
    a = a.point(lambda v: 0 if v < 24 else min(255, int(v * boost)))
    if tint is not None:
        rgb = Image.merge("RGB", (r, g, b)); rgb = Image.blend(rgb, Image.new("RGB", rgb.size, tint), 0.35); r, g, b = rgb.split()
    pad = 160; pa = Image.new("L", (a.size[0] + 2 * pad, a.size[1] + 2 * pad), 0); pa.paste(a, (pad, pad))
    small = pa.resize((pa.size[0] // 6, pa.size[1] // 6)).filter(ImageFilter.GaussianBlur(8)).resize(pa.size)
    small = small.point(lambda v: int(v * glow_k))
    base.paste(Image.new("RGB", pa.size, glow), (int(x) - pad, int(y) - pad), small)
    base.paste(Image.merge("RGB", (r, g, b)), (int(x), int(y)), a)
    return base

def brain_bg(name):
    return {"dark": BG_DARK, "sage": BG_SAGE, "blur": BG_BLUR, "mag": BG_MAG}[name].copy()

def r_brain(tl, dur, p, T):
    im = brain_bg(p.get("bg", "dark")); k = tl / max(dur, .1)
    fr = brain_frame(T + p.get("off", 0.0))
    glow = p.get("glow", CYAN); tint = p.get("tint")
    if p.get("mode") == "eyes":
        z0, z1 = p.get("z", (1.0, 1.45))
        z = z0 + (z1 - z0) * ease(k * 1.2)
        cw = 820 / z; ch = cw * 9 / 16
        cx, cy = EYES_C[0] + 10 * math.sin(T * 2), EYES_C[1] - 30
        crop = fr.crop((int(cx - cw / 2), int(cy - ch / 2), int(cx + cw / 2), int(cy + ch / 2))).resize((W, H), Image.BICUBIC)
        comp_brain(im, crop, 0, 0, glow, tint, boost=2.2)
    else:
        s0, s1 = p.get("s", (0.86, 0.98))
        s = s0 + (s1 - s0) * k
        box = fr.crop(BRAIN_BOX); hh = int(H * s); ww = int(box.size[0] * hh / box.size[1])
        Bm = box.resize((ww, hh), Image.BICUBIC)
        comp_brain(im, Bm, (W - ww) / 2 + p.get("dx", 0), (H - hh) / 2 + 20, glow, tint)
    if p.get("cap"): caption(im, p["cap"], p.get("capcol", MAG))
    if p.get("say"):
        d = ImageDraw.Draw(im); f = font(64, "bold"); tw = d.textlength(p["say"], font=f)
        x, y = W / 2 + 330, 190
        d.rounded_rectangle([x - 30, y - 20, x + tw + 30, y + 90], radius=40, fill=(255, 255, 255))
        d.polygon([(x + 10, y + 80), (x + 60, y + 88), (x - 40, y + 150)], fill=(255, 255, 255))
        d.text((x, y), p["say"], font=f, fill=INK)
    return im

def r_logo(tl, dur, p, T):
    im = BG_SAGE.copy(); k = ease(tl / 0.5)
    fr = brain_frame(T); box = fr.crop(BRAIN_BOX)
    hh = int(560 * (1.0 + 0.04 * tl / dur + 0.06 * math.exp(-tl * 6))); ww = int(box.size[0] * hh / box.size[1])
    comp_brain(im, box.resize((ww, hh), Image.BICUBIC), (W - ww) / 2, 70, MAG, None, boost=1.9, glow_k=0.45)
    d = ImageDraw.Draw(im)
    f = font(170, "heavy"); t1 = "My Little Brain"; tw = d.textlength(t1, font=f)
    y = 650 + (1 - k) * 80
    d.text(((W - tw) / 2 + 6, y + 6), t1, font=f, fill=MAG)
    d.text(((W - tw) / 2, y), t1, font=f, fill=INK)
    k2 = ease((tl - 0.4) / 0.5)
    if k2 > 0:
        f2 = font(64, "med"); t2 = "your brain, studying itself"; tw2 = d.textlength(t2, font=f2)
        col = tuple(int(SAGE[i] + ((70, 85, 62)[i] - SAGE[i]) * k2) for i in range(3))
        d.text(((W - tw2) / 2, 900), t2, font=f2, fill=col)
    return im

GATES = []
for col in range(14):
    for q in range(8):
        r = rng.random()
        if col == 0: GATES.append((col, q, "H"))
        elif col == 13: GATES.append((col, q, "M"))
        elif col % 3 == 2 and q < 7 and r < 0.35: GATES.append((col, q, "ZZ"))
        elif col % 3 == 0 and r < 0.8: GATES.append((col, q, "RX"))
        elif r < 0.25: GATES.append((col, q, "RZ"))

def r_circuit(tl, dur, p, T):
    im = BG_DARK.copy(); d = ImageDraw.Draw(im)
    f = font(34, "cond"); fg = font(30, "bold")
    top, gap, x0, x1 = 170, 92, 200, W - 120
    for q in range(8):
        y = top + q * gap; d.line([(x0, y), (x1, y)], fill=SAGE2, width=3); d.text((80, y - 22), f"q{q}", font=f, fill=SAGE)
    shown = int(len(GATES) * min(1, (tl + p.get("pre", 0.3)) / (dur * 0.8)))
    cw = (x1 - x0 - 60) / 14
    for i, (c, q, g) in enumerate(GATES[:shown]):
        x = x0 + 40 + c * cw; y = top + q * gap
        pop = 1 + 0.5 * max(0, 1 - (shown - i) / 6)
        col = {"H": SAGE, "RX": CYAN, "RZ": SAGE2, "ZZ": MAG, "M": (255, 255, 255)}[g]
        if g == "ZZ":
            d.line([(x + 30, y), (x + 30, y + gap)], fill=MAG, width=6)
            for yy_ in (y, y + gap): d.ellipse([x + 30 - 13 * pop, yy_ - 13 * pop, x + 30 + 13 * pop, yy_ + 13 * pop], fill=MAG)
        else:
            s = 30 * pop
            d.rounded_rectangle([x + 30 - s, y - s, x + 30 + s, y + s], radius=8, fill=DARK, outline=col, width=5)
            tw = d.textlength(g, font=fg); d.text((x + 30 - tw / 2, y - 20), g, font=fg, fill=col)
    d.text((x0, 70), p.get("title", "QAOA · 8 qubits · 2⁸ = 256 Wilson–Cowan hypotheses"), font=font(48, "cond"), fill=SAGE)
    caption(im, p.get("cap", "IonQ · IBM heavy-hex · qBraid · Extropic THRML"), CYAN)
    return im

TRUTH = int("10101011", 2)
def r_hist(tl, dur, p, T):
    im = BG_DARK.copy(); d = ImageDraw.Draw(im)
    k = ease(tl / (dur * 0.85))
    base = 0.25 + 0.15 * np.abs(np.sin(np.arange(256) * 1.7 + T * 6))
    idx = np.arange(256); peak = np.exp(-((idx - TRUTH) ** 2) / 2.0) + 0.35 * np.exp(-((idx - 43) ** 2) / 1.5)
    v = (1 - k) * base + k * peak * 1.0 + 0.02
    x0, x1, yb, hmax = 90, W - 90, H - 200, 700
    bw = (x1 - x0) / 256
    for i in range(256):
        c = MAG if (i == TRUTH and k > 0.6) else (CYAN if v[i] > 0.5 else SAGE2)
        d.rectangle([x0 + i * bw, yb - v[i] * hmax, x0 + (i + 1) * bw - 1, yb], fill=c)
    d.line([(x0, yb), (x1, yb)], fill=SAGE, width=3)
    d.text((x0, 70), "256 hypotheses → 1", font=font(64, "heavy"), fill=SAGE)
    if k > 0.6:
        x = x0 + TRUTH * bw; d.text((x - 170, yb - hmax - 80), "10101011 ✓", font=font(58, "heavy"), fill=MAG)
    caption(im, p.get("cap", "drive P · inhibition c2 · excitation c1 · synaptic τ"), CYAN)
    return im

NN = 140
NP0 = rng.random((NN, 2)) * [W, H]; NV = rng.normal(0, 40, (NN, 2))
def r_net(tl, dur, p, T):
    im = BG_DARK.copy(); d = ImageDraw.Draw(im)
    pos = (NP0 + NV * T) % [W, H]
    D = np.hypot(*(pos[:, None, :] - pos[None, :, :]).transpose(2, 0, 1))
    ii, jj = np.where((D < 190) & (np.triu(np.ones_like(D), 1) > 0))
    for a, b in zip(ii, jj):
        al = 1 - D[a, b] / 190; c = tuple(int(DARK[k] + (CYAN if (a + b) % 3 else MAG)[k] * al * 0.8) for k in range(3))
        d.line([tuple(pos[a]), tuple(pos[b])], fill=c, width=2)
    fire = (np.sin(np.arange(NN) * 3.3 + T * 9) > 0.93)
    for n_ in range(NN):
        r = 13 if fire[n_] else 6; c = MAG if fire[n_] else SAGE
        d.ellipse([pos[n_, 0] - r, pos[n_, 1] - r, pos[n_, 0] + r, pos[n_, 1] + r], fill=c)
    caption(im, p.get("cap", "neural mass · Wilson–Cowan dynamics"), SAGE)
    return im

def r_stat(tl, dur, p, T):
    style = p.get("style", "dark")
    im = (BG_SAGE if style == "sage" else BG_DARK).copy(); d = ImageDraw.Draw(im)
    fg = INK if style == "sage" else SAGE
    k = ease(tl / 0.35)
    if p.get("bars"):  # IonQ 52 vs IBM 454
        f = font(70, "heavy"); fb = font(120, "heavy")
        d.text((120, 120), "same full problem, gate count", font=font(60, "cond"), fill=SAGE2)
        for i, (name, val, col) in enumerate(p["bars"]):
            y = 330 + i * 300; L = (W - 760) * val / 454 * k
            d.text((120, y + 10), name, font=f, fill=fg)
            d.rectangle([520, y, 520 + max(L, 8), y + 150], fill=col)
            d.text((560 + max(L, 8), y + 5), str(int(val * k)), font=fb, fill=col)
        caption(im, "trapped ions: all-to-all connectivity", CYAN)
        return im
    big = p["big"]; f = font(330, "heavy")
    if "{n}" in big: big = big.replace("{n}", str(int(round(p["n"] * k))))
    tw = d.textlength(big, font=f)
    while tw > 1700: f = font(f.size - 20, "heavy"); tw = d.textlength(big, font=f)
    s = 1.15 - 0.15 * k
    d.text(((W - tw) / 2, 240), big, font=f, fill=p.get("col", CYAN))
    f2 = font(70, "bold"); tw2 = d.textlength(p["small"], font=f2)
    d.text(((W - tw2) / 2, 680), p["small"], font=f2, fill=fg)
    return im

def r_fig(tl, dur, p, T):
    k = tl / max(dur, .1); z = 1.0 + 0.12 * k
    cw, ch = W / z, H / z; cx = (W - cw) * (0.3 + 0.4 * k); cy = (H - ch) * 0.4
    im = FIG.crop((int(cx), int(cy), int(cx + cw), int(cy + ch))).resize((W, H), Image.BICUBIC)
    caption(im, p.get("cap", "research/experiments/campaigns · REAL RUNS"), MAG, "br")
    return im

RENDER = {"text": lambda tl, dur, p, T: r_text(tl, dur, p), "eeg": r_eeg, "water": r_water, "spec": r_spec, "fav": r_fav,
          "brain": r_brain, "circuit": r_circuit, "hist": r_hist, "net": r_net, "stat": r_stat, "fig": r_fig, "logo": r_logo}

# ------------------------------------------------------------------ soundtrack + beat grid
TRACK_MP3 = os.path.join(HERE, "soundtrack-1984-mechanical-heart-60s.mp3")
TRACK45 = os.path.join(BUILD, "track45.wav")
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", TRACK_MP3, "-t", f"{DUR}", "-ar", str(SR), "-ac", "2", TRACK45], check=True)
def detect_beats():
    import librosa
    y, sr = librosa.load(TRACK45, sr=22050)
    tempo, b = librosa.beat.beat_track(y=y, sr=sr, units="time")
    return float(np.atleast_1d(tempo)[0]), np.asarray(b)
TEMPO, BEATS = detect_beats()
BEAT = float(np.median(np.diff(BEATS)))
CUTS = np.concatenate([[0.0], BEATS[1:]])  # boundary k = beat k (first segment starts at 0)
def beat_idx(t): return int(np.argmin(np.abs(CUTS - t)))
DROP1, DROP2, LOGO = beat_idx(17.88), beat_idx(35.11), beat_idx(41.77)  # energy jumps found from RMS per beat
print(f"tempo {TEMPO:.1f} BPM, beat {BEAT:.3f}s, {len(BEATS)} beats; drop1 #{DROP1} {CUTS[DROP1]:.2f}s, drop2 #{DROP2} {CUTS[DROP2]:.2f}s, logo #{LOGO} {CUTS[LOGO]:.2f}s")

# ------------------------------------------------------------------ edit decision list (lengths in beats)
T_ = lambda *lines, **kw: ("text", dict(lines=list(lines), **kw))
INTRO = [  # quiet intro, 0 -> kick-in
    (2, "brain", dict(say="hi. I'm your brain.", s=(0.8, 0.9))),
    (2, *T_("a personal", "*assistant*", style="dark")),
    (2, *T_("who *understands*", "you", style="sage", slide="l")),
    (2, "brain", dict(mode="eyes", z=(1.0, 1.6), bg="blur", cap="it blinks. it watches. it learns.")),
    (1, "fav", dict()),
    (1, *T_("it knows *you.*", style="neon", slide="r")),
    (1, *T_("it reads your mind.", style="dark")),
]
BUILDUP = [  # kick-in -> drop 1
    (1, *T_("*literally.*", style="glitch")),
    (2, "eeg", dict()),
    (1, "brain", dict(mode="eyes", tint=CYAN, glow=CYAN, z=(1.5, 1.9), cap="LIVE · your EEG, read in real time", capcol=CYAN)),
    (2, "water", dict()),
    (2, *T_("*Gemini* sees", "your brainwaves", style="sage", sub="multimodal vision on your EEG spectrograms")),
    (2, "spec", dict()),
    (1, *T_("picks channels.", "*forms hypotheses.*", style="dark", slide="l")),
    (1, "brain", dict(bg="blur", s=(0.95, 1.05), cap="smart. brainy. a little nosy.")),
    (1, "eeg", dict(tint="mag", cap="alpha · theta · ictal")),
    (2, *T_("innovating the frontier", style="mag")),
    (2, *T_("of *neuroscience*", "technology", style="dark")),
    (1, "net", dict()),
    (1, "brain", dict(mode="eyes", tint=MAG, glow=MAG, bg="mag", z=(1.2, 1.5))),
    (2, "brain", dict(s=(0.7, 0.95), glow=MAG, cap="...", capcol=CYAN)),
]
DROP_1 = [  # drop 1 -> drop 2
    (1, *T_("harnessing", "the *power*", style="sage")),
    (2, *T_("of *quantum*", "computing", style="neon")),
    (2, "circuit", dict()),
    (1, *T_("*8* qubits.", style="dark")),
    (1, *T_("*256* hypotheses.", style="sage")),
    (1, *T_("one brain:", "*yours.*", style="glitch")),
    (2, "hist", dict()),
    (1, *T_("trapped *ions*", style="neon", slide="l")),
    (1, *T_("super*conducting*", style="dark", slide="r")),
    (1, *T_("*thermo*dynamic", style="mag", slide="l")),
    (2, "stat", dict(bars=[("IonQ", 52, CYAN), ("IBM", 454, MAG)])),
    (1, "brain", dict(mode="eyes", z=(1.8, 2.3), tint=CYAN, bg="dark")),
    (1, "spec", dict(kb=(1.4, 1.7, 0.7, 0.9), cap="vision triage → channel pick")),
    (1, *T_("Wilson–Cowan", "*× 256*", style="sage")),
    (2, "fig", dict()),
    (2, "stat", dict(big="{n}/256", n=48, small="simulations to find the hidden brain", col=MAG)),
    (1, "brain", dict(bg="blur", s=(1.0, 1.12), cap="iteration 2 → truth found")),
    (1, *T_("seizure science,", style="dark", slide="l")),
    (2, *T_("at *quantum* speed", style="neon", sub="CHB-MIT epilepsy recordings")),
    (1, "water", dict(mag=True, cap="ICTAL WINDOW · chb01_03")),
    (2, "stat", dict(big="{n} gates", n=42, small="a custom circuit the agent wrote itself", style="sage", col=MAG)),
    (2, *T_("every seizure window:", "*slower synapses*", style="sage", sub="all point to longer synaptic τ")),
]
DROP_2 = [  # drop 2 -> logo
    (1, "brain", dict(mode="eyes", z=(1.0, 1.7), glow=MAG, tint=MAG, bg="blur", rgb=True)),
    (1, "eeg", dict(cap="T7-P7 · seizure onset")),
    (1, *T_("*IonQ*", style="dark")),
    (1, *T_("*IBM*", style="sage")),
    (1, *T_("Rigetti · IQM", "AQT · *QuEra*", style="neon")),
    (1, *T_("Extropic", "*THRML*", style="mag")),
    (1, "hist", dict(cap="posterior mass → slow τ")),
    (1, "circuit", dict(pre=2.0, cap="qBraid · Rigetti · IQM · AQT · QuEra")),
    (1, *T_("your brain", style="neon")),
    (1, *T_("*studying*", style="mag")),
    (1, *T_("itself", style="glitch")),
    (1, "brain", dict(s=(1.05, 1.25), bg="blur", glow=MAG)),
]
EDL = INTRO + BUILDUP + DROP_1 + DROP_2
for name, sec, target in (("intro", INTRO, beat_idx(6.2)), ("buildup", INTRO + BUILDUP, DROP1),
                          ("drop1", INTRO + BUILDUP + DROP_1, DROP2), ("drop2", EDL, LOGO)):
    got = sum(e[0] for e in sec)
    if got != target: print(f"WARNING {name}: ends at beat {got}, wanted {target}")
EDL.append((None, "logo", dict()))

# glitch-y kinds get extra effects
def post(arr, kind, p, tl, fi, since_beat, seg_idx):
    a = arr.astype(np.float32)
    if tl < 0.1:  # flash on cut
        fl = (1 - tl / 0.1) * (0.7 if seg_idx % 3 == 0 else 0.35)
        colr = np.array([(255, 255, 255), CYAN, MAG][seg_idx % 3], np.float32)
        a = a * (1 - fl) + colr * fl
    glitchy = p.get("style") == "glitch" or kind in ("eeg", "water", "net") or p.get("rgb") or p.get("tint") is not None and kind == "brain"
    sp = int(28 * max(0, 1 - tl / 0.2)) + (6 if glitchy else 0) + int(10 * math.exp(-since_beat * 14))
    if kind in ("fig", "stat"): sp = sp // 3
    if kind == "logo": sp = int(30 * max(0, 1 - tl / 0.3))
    if sp > 0:
        a[..., 0] = np.roll(a[..., 0], sp, axis=1); a[..., 2] = np.roll(a[..., 2], -sp, axis=1)
    if (glitchy and fi % 7 in (0, 1)) or tl < 0.07:  # slice glitch
        for _ in range(5):
            y0 = rng.integers(0, H - 60); hh = rng.integers(8, 60)
            a[y0:y0 + hh] = np.roll(a[y0:y0 + hh], rng.integers(-120, 120), axis=1)
    if kind != "logo" and p.get("style") != "sage" and p.get("bg") != "sage":
        a = a * SCAN * VIGN
    a = a + GRAIN[fi % len(GRAIN)]
    return a.clip(0, 255).astype(np.uint8)

def seg_frames():
    starts = []; b = 0
    for e in EDL[:-1]: starts.append(b); b += e[0]
    starts.append(b)
    return [int(round(CUTS[s] * FPS)) for s in starts] + [NF]

def render_frame(fi, sf):
    si = max(i for i in range(len(EDL)) if sf[i] <= fi)
    _, kind, p = EDL[si]
    T = fi / FPS; tl = (fi - sf[si]) / FPS; dur = (sf[si + 1] - sf[si]) / FPS
    im = RENDER[kind](tl, dur, p, T)
    if kind not in ("logo", "text", "stat"): tag(im, T)
    prev = BEATS[BEATS <= T]; since = T - prev[-1] if len(prev) else 1.0
    out = post(np.asarray(im.convert("RGB")), kind, p, tl, fi, since, si)
    if kind == "logo" and tl > dur - 0.4:
        out = (out.astype(np.float32) * max(0, (dur - tl) / 0.4)).astype(np.uint8)
    return out

def render_video(audio_path):
    sf = seg_frames()
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
           "-i", "-", "-i", audio_path, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-maxrate", "16M", "-bufsize", "32M",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", f"{DUR}", "-movflags", "+faststart", OUT]
    pr = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for fi in range(NF):
        pr.stdin.write(render_frame(fi, sf).tobytes())
        if fi % 150 == 0: print(f"frame {fi}/{NF}", flush=True)
    pr.stdin.close(); pr.wait()

# ------------------------------------------------------------------ audio: soundtrack + subtle hit on the logo
def build_audio(path):
    with wave.open(TRACK45) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).reshape(-1, 2).astype(np.float32) / 32768
    n = int(SR * DUR); mix = np.zeros((n, 2), np.float32); mix[:min(n, len(x))] = x[:n]
    t_logo = CUTS[LOGO]
    def put(sig, t0, g):
        i = int(t0 * SR); j = min(n, i + len(sig)); mix[i:j] += (sig[: j - i] * g)[:, None]
    # reverse whoosh into the logo + low boom + soft crash
    tw = np.arange(int(0.6 * SR)) / SR; xw = tw / tw[-1]
    b, a = butter(2, 2000 / (SR / 2), "high")
    put(lfilter(b, a, rng.normal(0, 1, tw.size)) * xw ** 3, t_logo - 0.6, 0.12)
    th = np.arange(int(2.5 * SR)) / SR
    boom = np.sin(2 * np.pi * np.cumsum(32 + 70 * np.exp(-th * 9)) / SR) * np.exp(-th * 2.0)
    crash = lfilter(b, a, rng.normal(0, 1, th.size)) * np.exp(-th * 2.5)
    put(boom * 0.45 + crash * 0.08, t_logo, 1.0)
    fo = int(1.5 * SR); mix[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5
    peak = np.abs(mix).max()
    if peak > 0.98: mix *= 0.98 / peak
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mix * 32767).astype(np.int16).tobytes())

if __name__ == "__main__":
    if "--stills" in sys.argv:  # preview chosen times (s) to media/stills/
        sd = os.path.join(HERE, "stills"); os.makedirs(sd, exist_ok=True); sf = seg_frames()
        for ts in sys.argv[sys.argv.index("--stills") + 1:]:
            Image.fromarray(render_frame(int(float(ts) * FPS), sf)).save(os.path.join(sd, f"t{float(ts):05.2f}.png"))
        sys.exit(0)
    wav = os.path.join(BUILD, "mix.wav")
    build_audio(wav); print("audio ok")
    render_video(wav)
    print("wrote", OUT)
