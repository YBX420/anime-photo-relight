"""无头截图验证前端渲染。
  python shoot.py <out.png> [pose_json]
pose_json 例: '{"x":1180,"y":1215,"light":[-0.6,0.5,0.6],"shadow":true}'
"""
import sys
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else "out/web_shot.png"
POSE = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "-" else None
CHAR = sys.argv[3] if len(sys.argv) > 3 else None
URL = "http://127.0.0.1:8000/" + (f"?char={CHAR}" if CHAR else "")

with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    page = browser.new_page(viewport={"width": 1500, "height": 1000}, device_scale_factor=2)
    logs = []
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))
    page.goto(URL, wait_until="load")
    try:
        page.wait_for_function("window.__ready === true", timeout=15000)
        print("READY ok")
    except Exception as e:
        print("READY TIMEOUT:", e)
    if POSE:
        page.evaluate("(o) => window.__setDemo(o)", __import__("json").loads(POSE))
    page.wait_for_timeout(1500)
    el = page.query_selector("#stage canvas")
    el.screenshot(path=OUT) if el else page.screenshot(path=OUT, full_page=True)
    print("shot ->", OUT)
    for line in logs[-30:]:
        print(" ", line)
    browser.close()
