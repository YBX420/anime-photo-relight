"""无头模拟拖动角色,验证拖拽是否生效。"""
from playwright.sync_api import sync_playwright

W, H = 2000, 1334
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
                                "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 1400, "height": 950})
    logs = []
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    pg.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))
    pg.goto("http://127.0.0.1:8000/?char=miku", wait_until="load")
    pg.wait_for_function("window.__ready === true", timeout=15000)
    box = pg.query_selector("#stage canvas").bounding_box()

    def to_css(sx, sy):
        return box["x"] + sx / W * box["width"], box["y"] + sy / H * box["height"]

    st0 = pg.evaluate("window.__getState()")
    # 点角色身体(脚上方约 300 场景px),向右拖 250 css px
    gx, gy = to_css(st0["x"], st0["y"] - 300)
    pg.mouse.move(gx, gy); pg.mouse.down()
    pg.mouse.move(gx + 250, gy + 40, steps=8); pg.mouse.up()
    st1 = pg.evaluate("window.__getState()")
    print("before:", round(st0["x"]), round(st0["y"]))
    print("after :", round(st1["x"]), round(st1["y"]))
    print("DRAG OK" if abs(st1["x"] - st0["x"]) > 30 else "DRAG FAILED (char not moving)")
    for l in logs[-10:]:
        print(" ", l)
    b.close()
