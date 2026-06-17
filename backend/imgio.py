"""资产压缩/发布:控制前端加载体积。
- 场景:长边下采样到 SCENE_MAX + JPEG q82;深度图缩放到与场景同尺寸。
- 角色 RGBA:存 WebP(带 alpha,体积约为 PNG 的 1/5~1/8)。
- 法线/AO:PNG(法线需精度;AO 小),最高压缩级。
"""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "web" / "public"
SCENE_MAX = 1600          # 场景长边上限(像素)
RGBA_WEBP_Q = 88


def downscale_bgr(img: np.ndarray, max_side: int = SCENE_MAX) -> np.ndarray:
    h, w = img.shape[:2]
    s = max_side / max(h, w)
    if s < 1.0:
        img = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
    return img


def publish_scene(scene_bgr: np.ndarray, depth01: np.ndarray):
    """下采样 + 压缩;保证 scene.jpg 与 scene_depth.png 同尺寸。返回 (W,H)。"""
    PUB.mkdir(parents=True, exist_ok=True)
    scene = downscale_bgr(scene_bgr)
    H, W = scene.shape[:2]
    cv2.imwrite(str(PUB / "scene.jpg"), scene, [cv2.IMWRITE_JPEG_QUALITY, 82])
    d = cv2.resize((np.clip(depth01, 0, 1) * 255).astype(np.uint8), (W, H), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(PUB / "scene_depth.png"), d, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    return W, H


def publish_char_rgba(name: str, rgba: np.ndarray):
    """RGBA(HxWx4, RGB 顺序)-> web/public/<name>_rgba.webp。
    无损压缩 + 透明区清零 RGB:避免有损伪影在去预乘重打光时被放大成花屏。"""
    PUB.mkdir(parents=True, exist_ok=True)
    rgba = np.ascontiguousarray(rgba).copy()
    rgba[rgba[..., 3] == 0, :3] = 0                 # 全透明处清零 RGB
    Image.fromarray(rgba, "RGBA").save(PUB / f"{name}_rgba.webp", lossless=True, quality=80, method=4)


def publish_png(name_file: str, arr_bgr_or_gray: np.ndarray):
    """法线(BGR)/AO(gray)-> web/public/<name_file>,最高 PNG 压缩。"""
    PUB.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(PUB / name_file), arr_bgr_or_gray, [cv2.IMWRITE_PNG_COMPRESSION, 9])


def publish_char(name: str):
    """把 out/<name>_{rgba,normal,ao}.png 压缩发布到 web/public(rgba->webp)。"""
    out = ROOT / "out"
    rgba = cv2.cvtColor(cv2.imread(str(out / f"{name}_rgba.png"), cv2.IMREAD_UNCHANGED), cv2.COLOR_BGRA2RGBA)
    publish_char_rgba(name, rgba)
    for suff in ("normal", "ao"):
        p = out / f"{name}_{suff}.png"
        if p.exists():
            publish_png(f"{name}_{suff}.png", cv2.imread(str(p), cv2.IMREAD_UNCHANGED))
