"""
v1 场景光照自动估计(古典 OpenCV,零模型)。
从背景照片估计主光方向 L、环境光、强度、光色/环境色,写出 light.json。
输出基:屏幕空间 x 右 / y 上 / z 朝观者;L 为指向光源的单位向量(与法线图、着色器一致)。
"""
import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def estimate(scene_bgr: np.ndarray, elevation_deg: float = 55.0) -> dict:
    img = scene_bgr.astype(np.float32) / 255.0
    H, W = img.shape[:2]
    lab = cv2.cvtColor(scene_bgr, cv2.COLOR_BGR2LAB)
    Lch = lab[:, :, 0].astype(np.float32)

    # 排除天空(上半部 + 蓝色占优)
    rgb_img = img[:, :, ::-1]                                   # BGR->RGB float
    yy = (np.arange(H)[:, None] / H) * np.ones((1, W), np.float32)
    sky = (yy < 0.5) & (rgb_img[:, :, 2] > rgb_img[:, :, 0] + 0.04)
    ground = ~sky

    # 1) 方位角:地面受光区(最亮 20% 地面像素)的水平质心偏向太阳侧;辅以天空最亮带
    gl = np.where(ground, Lch, -1.0)
    if ground.any():
        thr = np.percentile(gl[ground], 80)
        xs = np.where(gl >= thr)[1]
        sun_x_g = float(xs.mean()) / max(W - 1, 1) if xs.size else 0.5
    else:
        sun_x_g = 0.5
    sky_band = cv2.GaussianBlur(Lch[: H // 3, :].mean(axis=0).reshape(1, -1), (0, 0), W * 0.02).ravel()
    sun_x_s = float(np.argmax(sky_band)) / max(W - 1, 1)
    sun_x = 0.6 * sun_x_g + 0.4 * sun_x_s                       # 0=左 1=右
    az = math.asin(float(np.clip((sun_x - 0.5) * 2.0, -1, 1)))

    # 仅在地面区域用 Otsu 分受光/阴影
    _, mask = cv2.threshold(Lch.astype(np.uint8), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    lit_m = ((mask > 0) & ground).reshape(-1)
    sh_m = ((mask == 0) & ground).reshape(-1)
    flat = rgb_img.reshape(-1, 3)
    lit = flat[lit_m]
    shadow = flat[sh_m]
    lit_lum = float(lit.mean()) if len(lit) else 0.7
    sh_lum = float(shadow.mean()) if len(shadow) else 0.3

    ambient = float(np.clip(sh_lum / max(lit_lum, 1e-3), 0.18, 0.55))
    intensity = float(np.clip(lit_lum - sh_lum, 0.3, 1.0))

    # 3) 光色 = 受光面均色(暖白);环境色 = 阴影均色(偏蓝)。各自归一到最大通道=1 作为色调。
    def tint(px, fallback):
        if len(px) == 0:
            return fallback
        c = px.mean(axis=0)
        return (c / max(c.max(), 1e-3)).tolist()

    light_color = tint(lit, [1.0, 0.95, 0.85])
    ambient_color = tint(shadow, [0.60, 0.70, 0.85])

    # 4) 仰角先验 -> 组装 L(屏幕空间 y 上)
    e = math.radians(elevation_deg)
    Lx = math.cos(e) * math.sin(az)
    Ly = math.sin(e)
    Lz = math.cos(e) * math.cos(az)
    v = np.array([Lx, Ly, Lz], np.float32)
    v /= np.linalg.norm(v) + 1e-8

    return {
        "dir": [float(x) for x in v],
        "ambient": round(ambient, 3),
        "diffuse": 0.85,
        "intensity": round(intensity, 3),
        "color": [round(c, 3) for c in light_color],
        "ambientColor": [round(c, 3) for c in ambient_color],
        "azimuth_deg": round(math.degrees(az), 1),
        "elevation_deg": elevation_deg,
        "convention": "screen x-right y-up z-toward-viewer; normal map OpenGL Y-up",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default=str(ROOT / "inputs" / "scene_7eleven.jpg"))
    ap.add_argument("--elevation", type=float, default=55.0)
    ap.add_argument("--out", default=str(OUT / "light.json"))
    args = ap.parse_args()

    scene = cv2.imread(args.scene)
    light = estimate(scene, args.elevation)
    Path(args.out).write_text(json.dumps(light, indent=2))
    print(json.dumps(light, indent=2, ensure_ascii=False))
    print(f"[done] {args.out}")


if __name__ == "__main__":
    main()
