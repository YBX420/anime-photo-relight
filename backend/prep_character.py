"""
v0 角色预处理:抠图(rembg isnet-anime) + 古典 alpha->伪法线。
输出与前端 Lambert 着色器对接的两张图(同尺寸、同裁剪、同锚点):
  out/<name>_rgba.png    角色 RGBA 抠图(直边 alpha)
  out/<name>_normal.png  切线空间法线图(OpenGL 约定, Y 向上, RGB 编码, alpha 同 rgba)

用法:
  python prep_character.py /path/to/eva-pilot-00.jpeg [--name rei] [--no-crop]
"""
import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from rembg import remove, new_session

OUT_DIR = Path(__file__).resolve().parent.parent / "out"


def matte(in_path: str, model: str = "isnet-anime", alpha_matting: bool = False) -> np.ndarray:
    """返回 HxWx4 uint8 RGBA。model: isnet-anime / birefnet-general / isnet-general-use ...
    birefnet-general 更擅长抠内部空洞(网兜/肢体缝隙)。"""
    session = new_session(model)
    img = Image.open(in_path).convert("RGB")
    out = remove(img, session=session, post_process_mask=True,
                 alpha_matting=alpha_matting, alpha_matting_foreground_threshold=240,
                 alpha_matting_background_threshold=15, alpha_matting_erode_size=3)
    return np.array(out.convert("RGBA"))


def autocrop(rgba: np.ndarray, pad: int = 16):
    """裁到 alpha 包围盒(留边),让精灵只含角色,便于前端摆放/缩放。"""
    a = rgba[..., 3]
    ys, xs = np.where(a > 10)
    if len(xs) == 0:
        return rgba
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(rgba.shape[1], x1 + pad + 1); y1 = min(rgba.shape[0], y1 + pad + 1)
    return rgba[y0:y1, x0:x1]


def compute_ao(rgba: np.ndarray, depth: np.ndarray, radius: float = 14.0,
               strength: float = 1.8) -> np.ndarray:
    """从角色深度烘焙环境光遮蔽(AO):凹陷/被遮挡处变暗。返回 8-bit 灰度(255=不遮蔽)。"""
    a = rgba[..., 3].astype(np.float32) / 255.0
    mask = a > 0.5
    D = depth.astype(np.float32).copy()
    if mask.sum() > 0:
        lo, hi = np.percentile(D[mask], 2), np.percentile(D[mask], 98)
        D = np.clip((D - lo) / (hi - lo + 1e-6), 0, 1)
    blurD = cv2.GaussianBlur(D, (0, 0), radius)
    ao = 1.0 - np.clip((blurD - D) * strength, 0.0, 0.78)   # 比邻域更"凹"的地方变暗
    ao = cv2.GaussianBlur(ao, (0, 0), 2.0)
    ao[~mask] = 1.0
    return (np.clip(ao, 0, 1) * 255).astype(np.uint8)


def char_depth(rgba: np.ndarray) -> np.ndarray:
    """Depth-Anything-v2-small 估角色深度(0..1, 1=近)。先把角色合到中灰底,
    避免透明黑边造成的假深度悬崖。"""
    import estimate_depth as ed
    rgb = rgba[..., :3].astype(np.float32)
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    comp = (rgb * a + 128.0 * (1.0 - a)).astype(np.uint8)
    bgr = cv2.cvtColor(comp, cv2.COLOR_RGB2BGR)
    return ed.run_depth(bgr)


def alpha_to_normal(rgba: np.ndarray, blur: float = 6.0, strength: float = 3.0,
                    detail: float = 0.25, depth: np.ndarray = None,
                    depth_w: float = 0.0) -> np.ndarray:
    """alpha 距离变换"充气剪影"当底,可混入 Depth-Anything 深度补内部体积,
    再梯度求法线。输出 OpenGL 约定法线(green=+Y 上),mask 外为平面法线。
    """
    a = rgba[..., 3].astype(np.float32) / 255.0
    mask = (a > 0.5).astype(np.uint8)

    # 1) 距离变换 = "充气剪影" 伪高度(保证干净的边缘转向)
    h = cv2.distanceTransform(mask, cv2.DIST_L2, 5).astype(np.float32)
    if h.max() > 0:
        h /= h.max()
    h = cv2.GaussianBlur(h, (0, 0), blur)

    # 2) 混入角色深度补内部结构(脸/胸/衣褶),按 mask 内做稳健归一
    if depth is not None and depth_w > 0:
        D = depth.astype(np.float32).copy()
        m = mask > 0
        if m.sum() > 0:
            lo, hi = np.percentile(D[m], 2), np.percentile(D[m], 98)
            D = np.clip((D - lo) / (hi - lo + 1e-6), 0, 1)
        D = cv2.GaussianBlur(D, (0, 0), 2.0)
        h = (1.0 - depth_w) * h + depth_w * D
    elif detail > 0:
        lum = cv2.cvtColor(rgba[..., :3], cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
        lum = cv2.GaussianBlur(lum, (0, 0), 1.2)
        h = (1.0 - detail) * h + detail * lum

    # 3) 梯度 -> 法线。图像 y 轴向下,OpenGL green 向上需对 y 取反。
    gy, gx = np.gradient(h)
    nx = -gx * strength
    ny = gy * strength          # 注意:不再额外取反 -> 屏幕上方法线偏绿(OpenGL Y-up)
    nz = np.ones_like(h)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-8
    nx, ny, nz = nx / norm, ny / norm, nz / norm

    rgb = np.stack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5], axis=-1)
    nmap = (np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    nmap[mask == 0] = np.array([128, 128, 255], np.uint8)  # 平面法线

    return np.dstack([nmap, rgba[..., 3]])  # 带与 rgba 一致的 alpha


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--name", default=None, help="输出文件名前缀")
    ap.add_argument("--no-crop", action="store_true")
    ap.add_argument("--blur", type=float, default=6.0)
    ap.add_argument("--strength", type=float, default=3.0)
    ap.add_argument("--detail", type=float, default=0.25)
    ap.add_argument("--normals", choices=["classic", "depth", "hybrid"], default="hybrid")
    ap.add_argument("--depth-w", type=float, default=None, help="深度权重(默认 hybrid 0.6 / depth 0.85)")
    ap.add_argument("--matte-model", default="isnet-anime", help="isnet-anime / birefnet-general ...")
    ap.add_argument("--alpha-matting", action="store_true")
    args = ap.parse_args()

    name = args.name or Path(args.input).stem
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[matte] {args.input} (model={args.matte_model})")
    rgba = matte(args.input, model=args.matte_model, alpha_matting=args.alpha_matting)
    if not args.no_crop:
        rgba = autocrop(rgba)
    print(f"[matte] -> {rgba.shape[1]}x{rgba.shape[0]} RGBA")

    depth = None
    if args.normals in ("depth", "hybrid"):
        print(f"[depth] Depth-Anything 角色深度…")
        depth = char_depth(rgba)
        cv2.imwrite(str(OUT_DIR / f"{name}_cdepth.png"), (depth * 255).astype(np.uint8))
    dw = args.depth_w if args.depth_w is not None else (0.85 if args.normals == "depth" else 0.6)
    if args.normals == "classic":
        dw = 0.0
    print(f"[normal] mode={args.normals} depth_w={dw} strength={args.strength}")
    nrm = alpha_to_normal(rgba, blur=args.blur, strength=args.strength,
                          detail=args.detail, depth=depth, depth_w=dw)

    rgba_path = OUT_DIR / f"{name}_rgba.png"
    nrm_path = OUT_DIR / f"{name}_normal.png"
    # cv2 写 BGRA;我们的数组是 RGBA -> 转通道
    cv2.imwrite(str(rgba_path), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
    # 法线图存为不透明 RGB(不带 alpha):避免前端预乘 alpha 污染法线向量
    cv2.imwrite(str(nrm_path), cv2.cvtColor(nrm[..., :3], cv2.COLOR_RGB2BGR))
    print(f"[done] {rgba_path}")
    print(f"[done] {nrm_path}")
    if depth is not None:
        cv2.imwrite(str(OUT_DIR / f"{name}_ao.png"), compute_ao(rgba, depth))
        print(f"[done] {OUT_DIR / f'{name}_ao.png'}")
    import imgio
    imgio.publish_char(name)   # 压缩发布到 web/public(rgba->webp)
    print(f"[done] published -> ?char={name}")


if __name__ == "__main__":
    main()
