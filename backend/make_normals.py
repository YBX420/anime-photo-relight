"""从已有 RGBA 角色图生成深度法线(Depth-Anything hybrid),不重新抠图。
用法(relight 环境): python make_normals.py --name mikus
"""
import argparse
from pathlib import Path
import cv2
import prep_character as pc

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
PUB = ROOT / "web" / "public"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--strength", type=float, default=4.2)
    ap.add_argument("--depth-w", type=float, default=0.6)
    args = ap.parse_args()

    rgba = cv2.cvtColor(cv2.imread(str(OUT / f"{args.name}_rgba.png"), cv2.IMREAD_UNCHANGED),
                        cv2.COLOR_BGRA2RGBA)
    depth = pc.char_depth(rgba)
    nrm = pc.alpha_to_normal(rgba, blur=4, strength=args.strength, depth=depth, depth_w=args.depth_w)
    cv2.imwrite(str(OUT / f"{args.name}_normal.png"), cv2.cvtColor(nrm[..., :3], cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(OUT / f"{args.name}_ao.png"), pc.compute_ao(rgba, depth))
    import imgio
    imgio.publish_char(args.name)   # rgba->webp, normal/ao->png(压缩)发布到 web/public
    print(f"[done] {args.name}: rgba.webp + normal/ao.png -> ?char={args.name}")


if __name__ == "__main__":
    main()
