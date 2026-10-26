"""Record clean clips of the app inside a Playwright-controlled Chrome (never the desktop).

Frames come from CDP Page.startScreencast and are streamed straight into a system ffmpeg
(no frame buffering in RAM). One browser, closed at the end. Stills are 2x PNGs via CDP
Page.captureScreenshot(clip.scale=2), so the video can stay at DSF 1 on low-memory machines.

    research/.venv/bin/python media/record_app.py          # record session + cut clips
    research/.venv/bin/python media/record_app.py --cut    # re-cut from the last raw session
"""
import base64, json, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).parent
RAW = ROOT / "app-clips" / "raw"
OUT = ROOT / "app-clips"
SHOTS = ROOT / "app-shots"
for d in (RAW, OUT, SHOTS):
    d.mkdir(parents=True, exist_ok=True)
URL = "http://127.0.0.1:5173/"
W, H, DSF = 1600, 900, 1
RAW_PATH = RAW / "session.mp4"
MARKS = RAW / "marks.json"
Q1 = "Look at my EEG and run a quantum search to explain my alpha rhythm"
Q2 = "Design a better circuit and run it on IonQ's simulator"
T0 = None
marks = {}


def mark(name):
    marks[name] = round(time.time() - T0, 2)
    print(f"[{marks[name]:7.2f}s] {name}", flush=True)
    MARKS.write_text(json.dumps(marks, indent=1))


def record():
    from playwright.sync_api import sync_playwright

    def signed_in(page):
        modal = page.get_by_role("dialog", name="Meet your brain")
        if modal.count() and modal.first.is_visible():
            print("modal visible -> continue as dev", flush=True)
            page.get_by_role("button", name="Continue as dev (local only)").click(timeout=15000)
            page.wait_for_timeout(2500)
            return False
        return True

    def shot(cdp, name):
        r = cdp.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False,
                                                "clip": {"x": 0, "y": 0, "width": W, "height": H, "scale": 2}})
        out = SHOTS / f"v2-{name}.png"
        out.write_bytes(base64.b64decode(r["data"]))
        # headful Chrome on a Retina display may hand back 4x; normalise to 2x (3200x1800)
        subprocess.run(["sips", "-z", str(H * 2), str(W * 2), str(out)], capture_output=True)
        print("shot", name, flush=True)

    def brain_count(page):
        return page.locator(".cx-bubble.brain:not(.cx-typing)").count()

    def wait_reply(page, n_before, timeout=180, on_tick=None):
        end = time.time() + timeout
        while time.time() < end:
            signed_in(page)
            if on_tick: on_tick()
            if brain_count(page) > n_before and page.locator(".cx-typing").count() == 0:
                return True
            page.wait_for_timeout(500)
        return False

    def ask(page, text, delay):
        signed_in(page)
        box = page.get_by_label("Message your brain")
        box.click()
        n = brain_count(page)
        box.press_sequentially(text, delay=delay)
        page.wait_for_timeout(600)
        box.press("Enter")
        return n

    def tab(page, name):
        try:
            page.get_by_role("tablist", name="Analysis views").get_by_role("tab", name=name).first.click(timeout=3000)
        except Exception as e:
            print("tab miss", name, e, flush=True)

    def smooth_to(page, sel, block="center"):
        loc = page.locator(sel).first
        if not loc.count():
            print("no", sel, flush=True); return False
        loc.evaluate(f"e => e.scrollIntoView({{behavior: 'smooth', block: '{block}'}})")
        return True

    def cards(page):
        return page.locator(".cx-chat-row.brain").last.locator(".cx-chat-event.focusable button")

    with sync_playwright() as p:
        b = p.chromium.launch(headless=False, channel="chrome",
                              args=["--use-angle=metal", "--enable-gpu", f"--window-size={W},{H + 120}"])
        ctx = b.new_context(viewport={"width": W, "height": H}, device_scale_factor=DSF)
        page = ctx.new_page()
        enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-use_wallclock_as_timestamps", "1",
                                "-c:v", "mjpeg", "-i", "-", "-vf", f"fps=30,scale={W}:{H}:flags=lanczos", "-c:v", "libx264",
                                "-preset", "veryfast", "-pix_fmt", "yuv420p", "-crf", "16", str(RAW_PATH)], stdin=subprocess.PIPE)
        cdp = ctx.new_cdp_session(page)

        def on_frame(ev):
            if "_frame0" not in marks:  # video t=0 is the first frame, not T0
                marks["_frame0"] = round(time.time() - T0, 2)
            try:
                enc.stdin.write(base64.b64decode(ev["data"])); enc.stdin.flush()
            except Exception:
                pass
            try:
                cdp.send("Page.screencastFrameAck", {"sessionId": ev["sessionId"]})
            except Exception:
                pass
        cdp.on("Page.screencastFrame", on_frame)
        page.goto("about:blank")
        global T0
        T0 = time.time()
        cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": W * DSF, "maxHeight": H * DSF})
        try:
            # 01 sign in -> brain appears
            page.goto(URL)
            page.get_by_role("button", name="Continue as dev (local only)").wait_for(timeout=20000)
            page.wait_for_timeout(1500)
            mark("s01")
            page.wait_for_timeout(1500)
            page.get_by_role("button", name="Continue as dev (local only)").click()
            mark("signed_in")
            page.wait_for_timeout(5000)
            shot(cdp, "01-brain")
            page.wait_for_timeout(3500)
            mark("s01_end")
            # clean conversation, laboratory pane + analysis pane open
            try:
                page.get_by_role("button", name="New conversation").click(timeout=3000)
            except Exception as e:
                print("reset miss", e)
            if page.get_by_role("button", name="Open laboratory pane").count():
                page.get_by_role("button", name="Open laboratory pane").click()
            if page.get_by_role("button", name="Open analysis").count():
                page.get_by_role("button", name="Open analysis").click()
            page.wait_for_timeout(2500)

            # 02 ask
            mark("s02")
            n = ask(page, Q1, delay=85)
            mark("q1_sent")
            # 03 reasoning
            ok = wait_reply(page, n)
            mark("q1_reply" if ok else "q1_timeout")
            page.wait_for_timeout(2500)
            thumb = page.locator(".cx-chat-thumb").last
            if thumb.count():
                thumb.scroll_into_view_if_needed(); thumb.hover()
            page.wait_for_timeout(2000)
            shot(cdp, "02-reply")
            page.wait_for_timeout(2500)
            mark("s03_end")

            # 04 circuit
            c = cards(page)
            print("cards:", c.count(), [c.nth(i).inner_text()[:60] for i in range(c.count())], flush=True)
            pick = None
            for i in range(c.count()):
                if any(k in c.nth(i).inner_text().lower() for k in ("quantum", "job", "sampl", "circuit", "search")):
                    pick = c.nth(i)
            if pick is None and c.count():
                pick = c.last
            mark("s04")
            if pick is not None:
                pick.click()
            page.wait_for_timeout(2500)
            tab(page, "Job")
            page.wait_for_timeout(2000)
            smooth_to(page, ".cx-circuit", "start")
            page.wait_for_timeout(2000)
            phys = page.locator(".cx-circuit").get_by_role("tab", name="physical")
            if phys.count() and phys.first.is_enabled():
                phys.first.click()
            page.wait_for_timeout(1500)
            svg = page.locator(".cx-circuit svg").first
            if svg.count():
                bb = svg.bounding_box()
                if bb:
                    page.mouse.move(bb["x"] + bb["width"] * 0.3, bb["y"] + bb["height"] * 0.3, steps=20)
            page.wait_for_timeout(1500)
            shot(cdp, "03-circuit")
            page.wait_for_timeout(2500)
            mark("s04_end")

            # 05 dispatch to IonQ simulator
            jobs0 = page.locator(".cx-job-list li").count()
            mark("s05")
            n = ask(page, Q2, delay=45)
            mark("q2_sent")
            seen = {"job": False}

            def tick():
                if not seen["job"] and page.locator(".cx-job-list li").count() > jobs0:
                    seen["job"] = True
                    mark("q2_job")
                    page.wait_for_timeout(1500)
                    shot(cdp, "04-dispatch")
            ok = wait_reply(page, n, timeout=240, on_tick=tick)
            mark("q2_reply" if ok else "q2_timeout")
            page.wait_for_timeout(3000)

            # 06 results
            mark("s06")
            job = page.locator(".cx-job-list .cx-job", has_text="IonQ")
            if not job.count():
                job = page.locator(".cx-job-list .cx-job")
            if job.count():
                job.first.click()
            page.wait_for_timeout(1500)
            tab(page, "Job")
            page.wait_for_timeout(1500)
            if smooth_to(page, '[aria-label="Measured bitstring frequencies"]'):
                page.wait_for_timeout(2500); shot(cdp, "05-histogram")
            tab(page, "Experiment")
            page.wait_for_timeout(1500)
            if smooth_to(page, '[aria-label^="Hypothesis landscape"]'):
                page.wait_for_timeout(3000); shot(cdp, "06-landscape")
            if smooth_to(page, '[aria-label="Observed versus simulated EEG"]'):
                page.wait_for_timeout(3000); shot(cdp, "07-wave-compare")
            if smooth_to(page, '[aria-label="Cross-channel hypothesis comparison"]'):
                page.wait_for_timeout(2500)
            mark("s06_end")

            # 07 about me
            signed_in(page)
            mark("s07")
            page.get_by_role("button", name="About me").first.click()
            page.wait_for_timeout(3500)
            shot(cdp, "08-about-me")
            drawer = page.locator(".cx-drawer")
            if drawer.count():
                drawer.evaluate("e => { const s = [e, ...e.querySelectorAll('*')].find(x => x.scrollHeight > x.clientHeight + 40); if (s) s.scrollTo({top: s.scrollHeight, behavior: 'smooth'}); }")
            page.wait_for_timeout(4500)
            mark("s07_end")
            page.wait_for_timeout(1000)
        finally:
            try: cdp.send("Page.stopScreencast")
            except Exception: pass
            ctx.close(); b.close()
            enc.stdin.close(); enc.wait()
            MARKS.write_text(json.dumps(marks, indent=1))


def cut():
    m = json.loads(MARKS.read_text())
    off = m.pop("_frame0", 0)
    m = {k: v - off for k, v in m.items()}
    dur_total = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                      str(RAW_PATH)], capture_output=True, text=True).stdout)

    def c(name, start, dur):
        start = max(0, min(start, dur_total - 1))
        dur = min(dur, dur_total - start)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start:.2f}", "-i", str(RAW_PATH), "-t", f"{dur:.2f}",
                        "-c:v", "libx264", "-preset", "slow", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart",
                        "-an", str(OUT / name)], check=True)
        print(f"clip {name} @{start:.1f}s {dur:.1f}s")

    def span(a, b, lo=6, hi=12):
        return min(max(m[b] - m[a], lo), hi)
    if "s01" in m: c("01-signin-brain.mp4", m["s01"], span("s01", "s01_end"))
    if "s02" in m: c("02-ask.mp4", m["s02"] - 0.5, 10)
    r = m.get("q1_reply")
    if r: c("03-reasoning.mp4", r - 4, max(10, m.get("s03_end", r + 6) - r + 4))
    if "s04" in m: c("04-circuit.mp4", m["s04"], span("s04", "s04_end"))
    if "q2_sent" in m:
        j = m.get("q2_job", m.get("q2_reply", m["q2_sent"] + 8))
        c("05-dispatch.mp4", max(m["s05"], j - 5), 10)
    if "s06" in m: c("06-results.mp4", m["s06"], span("s06", "s06_end", 8, 16))
    if "s07" in m: c("07-about-me.mp4", m["s07"] - 0.3, span("s07", "s07_end", 6, 10))


if __name__ == "__main__":
    if "--cut" not in sys.argv:
        record()
    cut()
