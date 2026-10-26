#!/usr/bin/env python
"""Deterministic three.js clip renderer.

    research/.venv/bin/python media/viz/render.py tractometry extraction qaoa hero-orbit
    research/.venv/bin/python media/viz/render.py qaoa --still 9.5     # one PNG only

Serves the repo root over HTTP (pages fetch the real anatomy meshes), drives
window.render(t) per frame in headless Chrome and streams PNG screenshots into
ffmpeg (image2pipe) -> H.264 CRF 18, 1920x1080@30.
"""
import argparse, functools, http.server, os, subprocess, threading, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
FPS, W, H = 30, 1920, 1080
STILL_AT = {"tractometry": 5.0, "extraction": 9.6, "qaoa": 11.8, "hero-orbit": 4.0}


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=REPO))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+")
    ap.add_argument("--still", type=float, default=None, help="only write a still at this time")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    port = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        for clip in a.clips:
            page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
            page.on("console", lambda m: print("  [console]", m.text) if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda e: print("  [pageerror]", e))
            page.goto(f"http://127.0.0.1:{port}/media/viz/{clip}.html")
            page.wait_for_function("window.ready === true", timeout=120000)
            dur = page.evaluate("window.DURATION")
            st = a.still if a.still is not None else STILL_AT.get(clip, dur / 2)
            page.evaluate(f"window.render({st})")
            png = os.path.join(OUT, f"{clip}.png")
            page.screenshot(path=png, type="png")
            print(f"{clip}: still @ {st}s -> {png}")
            if a.still is not None:
                page.close()
                continue
            mp4 = os.path.join(OUT, f"{clip}.mp4")
            ff = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "png", "-i", "-",
                                   "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4],
                                  stdin=subprocess.PIPE)
            n = int(round(dur * FPS))
            t0 = time.time()
            for i in range(n):
                page.evaluate(f"window.render({i / FPS})")
                ff.stdin.write(page.screenshot(type="png"))
                if i % 60 == 0:
                    print(f"  {clip} {i}/{n}  {time.time() - t0:.0f}s", flush=True)
            ff.stdin.close()
            ff.wait()
            print(f"{clip}: {n} frames -> {mp4} ({time.time() - t0:.0f}s)")
            page.close()
        browser.close()


if __name__ == "__main__":
    main()
