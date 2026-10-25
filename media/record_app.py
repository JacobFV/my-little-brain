"""Record real clips of the app in Playwright Chromium, then cut with ffmpeg."""
import base64, json, subprocess, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
RAW = ROOT / "app-clips" / "raw"
OUT = ROOT / "app-clips"
RAW.mkdir(parents=True, exist_ok=True)
URL = "http://127.0.0.1:5173/"
T0 = None
marks = {}

def mark(name):
    marks[name] = round(time.time() - T0, 2)
    print(f"[{marks[name]:7.2f}s] {name}", flush=True)

def wait_reply(page, n_before, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        n = page.locator(".cx-bubble.brain:not(.cx-typing)").count()
        if n > n_before and page.locator(".cx-typing").count() == 0:
            return True
        page.wait_for_timeout(500)
    return False

def click_tab(page, name):
    try:
        page.get_by_role("tab", name=name).first.click(timeout=3000)
    except Exception:
        try: page.get_by_text(name, exact=True).first.click(timeout=2000)
        except Exception as e: print("tab miss", name, e)

def ask(page, text, tag):
    box = page.get_by_label("Message your brain")
    box.click()
    mark(f"{tag}_type")
    n = page.locator(".cx-bubble.brain:not(.cx-typing)").count()
    box.press_sequentially(text, delay=35)
    box.press("Enter")
    mark(f"{tag}_sent")
    ok = wait_reply(page, n)
    mark(f"{tag}_reply" if ok else f"{tag}_timeout")
    page.wait_for_timeout(2500)
    cards = page.locator(".cx-chat-row.brain").last.locator(".cx-chat-events > *")
    print("cards:", cards.count())
    if cards.count():
        cards.first.click(); mark(f"{tag}_card")
        page.wait_for_timeout(8000)
        for t in ("Job", "Agent"):
            click_tab(page, t); mark(f"{tag}_tab_{t}"); page.wait_for_timeout(5000)
        if cards.count() > 1:
            cards.nth(1).click(); mark(f"{tag}_card2"); page.wait_for_timeout(5000)

with sync_playwright() as p:
    b = p.chromium.launch(headless=False, channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
    ctx = b.new_context(viewport={"width": 1600, "height": 900}, device_scale_factor=1)
    page = ctx.new_page()
    # Playwright's bundled video ffmpeg isn't installed: record via CDP screencast -> system ffmpeg.
    raw_path = RAW / "session.mp4"
    enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-use_wallclock_as_timestamps", "1",
                            "-c:v", "mjpeg", "-i", "-", "-vf", "fps=30,scale=1600:900", "-c:v", "libx264", "-preset", "veryfast",
                            "-pix_fmt", "yuv420p", "-crf", "18", str(raw_path)], stdin=subprocess.PIPE)
    cdp = ctx.new_cdp_session(page)
    def on_frame(ev):
        try:
            enc.stdin.write(base64.b64decode(ev["data"])); enc.stdin.flush()
        except Exception: pass
        cdp.send("Page.screencastFrameAck", {"sessionId": ev["sessionId"]})
    cdp.on("Page.screencastFrame", on_frame)
    page.goto("about:blank")
    cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 88, "maxWidth": 1600, "maxHeight": 900, "everyNthFrame": 1})
    T0 = time.time()
    page.goto(URL)
    try:
        page.get_by_role("button", name="Continue as dev (local only)").click(timeout=15000)
    except Exception as e:
        print("signin skip", e)
    mark("signed_in")
    page.wait_for_timeout(8000)  # live EEG settles
    mark("eeg")
    ask(page, "Look at my EEG and run a quantum search to explain my alpha rhythm", "q1")
    ask(page, "Design a better circuit and run it on IonQ's simulator, then tell me what you found", "q2")
    page.wait_for_timeout(3000); mark("end")
    cdp.send("Page.stopScreencast")
    ctx.close(); b.close()
    enc.stdin.close(); enc.wait()

raw = raw_path
(RAW / "marks.json").write_text(json.dumps(marks, indent=1))
print("raw:", raw, marks)

def cut(name, start, dur):
    start = max(0, start)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start}", "-i", str(raw), "-t", f"{dur}",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-an", str(OUT / name)], check=True)
    print("clip", name, start, dur)

m = marks
if "q1_type" in m: cut("01-chat.mp4", m["q1_type"], 10)
if "q1_sent" in m: cut("02-reasoning.mp4", max(m["q1_sent"], m.get("q1_reply", m["q1_sent"] + 10) - 8), 10)
if "q1_card" in m: cut("03-circuit.mp4", m["q1_card"], 12)
if "q2_sent" in m: cut("04-dispatch.mp4", m.get("q2_reply", m["q2_sent"] + 8) - 3, 10)
if "q2_card" in m: cut("05-results.mp4", m["q2_card"], 12)
# highlight loop: chat typing (5s) + card focus/analysis (10s)
parts = []
if "q1_type" in m: parts.append((m["q1_type"], 5))
src = m.get("q1_card", m.get("q1_reply", m.get("q1_sent", 0)))
parts.append((src, 10))
flt = "".join(f"[0:v]trim={s}:{s+d},setpts=PTS-STARTPTS[v{i}];" for i, (s, d) in enumerate(parts))
flt += "".join(f"[v{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=1:a=0,scale=1600:900[o]"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-filter_complex", flt, "-map", "[o]",
                "-c:v", "libvpx-vp9", "-b:v", "2M", "-deadline", "good", "-cpu-used", "4", "-an",
                str(OUT / "demo-loop.webm")], check=True)
print("done")
