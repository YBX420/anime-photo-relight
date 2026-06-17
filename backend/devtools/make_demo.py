"""生成 demo 物料(需后端在 127.0.0.1:8000 运行):
  demo/hero.png                  — 全效果合成
  demo/compare_naive_vs_relit.png— 裸贴 2D vs 写实重打光 对比
  demo/light_sweep.gif           — 光照环绕一圈,实时重打光/投影
用法(relight 环境): python backend/devtools/make_demo.py
"""
import io
import math
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent.parent
DEMO = ROOT / "demo"
URL = "http://127.0.0.1:8000/?char=miku"
POSE = {"x": 1150, "y": 1205, "scale": 1.0, "light": [0.5, 0.55, 0.55]}
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


def shot(page):
    png = page.query_selector("#stage canvas").screenshot()
    return Image.open(io.BytesIO(png)).convert("RGB")


def load(page):
    page.goto(URL, wait_until="load")
    page.wait_for_function("window.__ready === true", timeout=15000)


def main():
    DEMO.mkdir(exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(args=ARGS)
        page = b.new_page(viewport={"width": 1180, "height": 860}, device_scale_factor=2)
        load(page)
        page.evaluate("(o)=>window.__setDemo(o)", POSE); page.wait_for_timeout(800)
        hero = shot(page); hero.save(DEMO / "hero.png")
        print("hero.png")

        # 裸贴(关闭所有写实)
        page.evaluate("(o)=>window.__setDemo(o)", {"shadow": False, "dof": False, "glow": False})
        page.evaluate("()=>{const a=window.__app;['ao','rim','edgeSoft'].forEach(k=>a.setParam(k,0));"
                      "a.setParam('diffuse',0);a.setParam('ambient',1.0);a.setLightXY(0,0);}")
        page.wait_for_timeout(500); naive = shot(page)
        # 写实(默认重载)
        load(page); page.evaluate("(o)=>window.__setDemo(o)", POSE); page.wait_for_timeout(700)
        relit = shot(page)
        gap = 18
        cmp = Image.new("RGB", (naive.width + relit.width + gap, max(naive.height, relit.height)), (244, 247, 251))
        cmp.paste(naive, (0, 0)); cmp.paste(relit, (naive.width + gap, 0))
        cmp.save(DEMO / "compare_naive_vs_relit.png")
        print("compare_naive_vs_relit.png  (左=裸贴 右=重打光)")

        # 光照环绕 GIF
        frames, N = [], 16
        for i in range(N):
            a = 2 * math.pi * i / N
            page.evaluate("(o)=>window.__app.setLightXY(o[0],o[1])", [math.cos(a) * 0.85, 0.25 + math.sin(a) * 0.55])
            page.wait_for_timeout(110)
            f = shot(page)
            frames.append(f.resize((760, round(760 * f.height / f.width))))
        frames[0].save(DEMO / "light_sweep.gif", save_all=True, append_images=frames[1:],
                       duration=110, loop=0, optimize=True)
        print(f"light_sweep.gif  ({N} frames)")
        b.close()


if __name__ == "__main__":
    main()
