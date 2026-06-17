"""整页截图(含控制面板),检查 UI。"""
import sys
from playwright.sync_api import sync_playwright

CHAR = sys.argv[1] if len(sys.argv) > 1 else "miku"
OUT = sys.argv[2] if len(sys.argv) > 2 else "out/ui.png"
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
                                "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 1280, "height": 820}, device_scale_factor=1)
    logs = []
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    pg.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))
    pg.goto(f"http://127.0.0.1:8000/?char={CHAR}", wait_until="load")
    try:
        pg.wait_for_function("window.__ready === true", timeout=15000)
    except Exception as e:
        print("READY TIMEOUT", e)
    pg.wait_for_timeout(1200)
    nsliders = pg.eval_on_selector_all("input[type=range]", "els => els.length")
    ntoggles = pg.eval_on_selector_all(".tg", "els => els.length")
    print("sliders:", nsliders, "toggles:", ntoggles)
    pg.screenshot(path=OUT)
    print("shot ->", OUT)
    for l in logs[-12:]:
        print(" ", l)
    b.close()
