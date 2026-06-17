"""
v0 静态预览:把角色 RGBA + 法线图按硬编码光向做 Lambert 重打光,合成进场景。
这是网页交互版之前的快速验证。前端着色器用完全相同的公式。

  relit = albedo * (ambient*ambientColor + diffuse*max(0,N·L)*lightColor)

法线图与 L 都在屏幕空间基:x 右, y 上, z 朝观者。
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

# --- v0 硬编码光照(对应 7-Eleven 晴天,见调研 5 节) ---
L = np.array([-0.35, 0.80, 0.50], np.float32)          # 指向光源, 屏幕空间 y 上
L = L / np.linalg.norm(L)
LIGHT_COLOR = np.array([1.00, 0.95, 0.85], np.float32)  # 暖白主光 ~5500K
AMBIENT_COLOR = np.array([0.60, 0.70, 0.85], np.float32)  # 冷天空蓝环境
AMBIENT = 0.35
DIFFUSE = 0.85


def relight(rgba: np.ndarray, nmap: np.ndarray) -> np.ndarray:
    """对角色做 Lambert 重打光,返回 RGBA float[0,1]。"""
    albedo = rgba[..., :3].astype(np.float32) / 255.0
    alpha = rgba[..., 3:4].astype(np.float32) / 255.0
    n = nmap[..., :3].astype(np.float32) / 255.0 * 2.0 - 1.0
    n /= (np.linalg.norm(n, axis=2, keepdims=True) + 1e-8)
    ndotl = np.clip((n * L).sum(axis=2, keepdims=True), 0.0, 1.0)
    shade = AMBIENT * AMBIENT_COLOR + DIFFUSE * ndotl * LIGHT_COLOR
    relit = np.clip(albedo * shade, 0.0, 1.0)
    return np.dstack([relit, alpha[..., 0]])


def alpha_over(dst: np.ndarray, src_rgb: np.ndarray, src_a: np.ndarray, x: int, y: int):
    """把 src(RGB float, alpha) 贴到 dst(BGR uint8) 的 (x,y) 左上角。"""
    h, w = src_rgb.shape[:2]
    H, W = dst.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    sx0, sy0 = x0 - x, y0 - y
    s_rgb = src_rgb[sy0:sy0 + (y1 - y0), sx0:sx0 + (x1 - x0)]
    s_a = src_a[sy0:sy0 + (y1 - y0), sx0:sx0 + (x1 - x0)][..., None]
    roi = dst[y0:y1, x0:x1].astype(np.float32) / 255.0
    s_bgr = s_rgb[..., ::-1]  # RGB->BGR
    out = s_bgr * s_a + roi * (1.0 - s_a)
    dst[y0:y1, x0:x1] = np.clip(out * 255.0, 0, 255).astype(np.uint8)


def fake_shadow(scene: np.ndarray, cx: int, by: int, char_w: int):
    """廉价假接触阴影:朝光反方向(右下)偏移的模糊深椭圆, multiply 混合。"""
    ew = int(char_w * 0.8)
    eh = int(ew * 0.22)
    ox, oy = int(char_w * 0.10), int(eh * 0.25)   # 朝右下偏移
    layer = np.ones_like(scene, np.float32)
    cv2.ellipse(layer, (cx + ox, by + oy), (ew // 2, eh // 2), 0, 0, 360,
                (0.13, 0.10, 0.08), -1)            # BGR 冷中性深灰
    layer = cv2.GaussianBlur(layer, (0, 0), 18)
    scene[:] = np.clip(scene.astype(np.float32) / 255.0 * layer, 0, 1) * 255
    scene[:] = scene.astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default=str(ROOT / "inputs" / "scene_7eleven.jpg"))
    ap.add_argument("--name", default="rei")
    ap.add_argument("--cx", type=int, default=1150, help="角色水平中心")
    ap.add_argument("--bottom", type=int, default=1334, help="角色底边 y(贴画框底缘藏腿)")
    ap.add_argument("--height", type=int, default=820, help="角色显示高度")
    ap.add_argument("--shadow", action="store_true", help="加假接触阴影")
    ap.add_argument("--out", default=str(OUT / "preview_v0.png"))
    args = ap.parse_args()

    scene = cv2.imread(args.scene)
    rgba = cv2.cvtColor(cv2.imread(str(OUT / f"{args.name}_rgba.png"), cv2.IMREAD_UNCHANGED), cv2.COLOR_BGRA2RGBA)
    nmap = cv2.cvtColor(cv2.imread(str(OUT / f"{args.name}_normal.png"), cv2.IMREAD_UNCHANGED), cv2.COLOR_BGRA2RGBA)

    # 缩放到目标高度
    h0, w0 = rgba.shape[:2]
    scale = args.height / h0
    nw, nh = int(w0 * scale), int(h0 * scale)
    rgba = cv2.resize(rgba, (nw, nh), interpolation=cv2.INTER_AREA)
    nmap = cv2.resize(nmap, (nw, nh), interpolation=cv2.INTER_AREA)

    relit = relight(rgba, nmap)
    x = args.cx - nw // 2
    y = args.bottom - nh

    if args.shadow:
        fake_shadow(scene, args.cx, args.bottom, nw)
    alpha_over(scene, relit[..., :3], relit[..., 3], x, y)

    cv2.imwrite(args.out, scene)
    print(f"[done] {args.out}  (char {nw}x{nh} @ x={x},y={y}, L={L.round(2)})")

    # 同时写出 v0 的 light.json 供前端使用
    light = {
        "dir": [float(v) for v in L], "ambient": AMBIENT, "diffuse": DIFFUSE,
        "color": [float(v) for v in LIGHT_COLOR], "ambientColor": [float(v) for v in AMBIENT_COLOR],
        "convention": "screen x-right y-up z-toward-viewer; normal map OpenGL Y-up",
    }
    (OUT / "light.json").write_text(json.dumps(light, indent=2))
    print(f"[done] {OUT / 'light.json'}")


if __name__ == "__main__":
    main()
