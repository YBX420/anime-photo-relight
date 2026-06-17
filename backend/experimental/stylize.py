"""
第四步:角色半写实化(SD1.5 img2img 低重绘)。
对已抠图的角色做低强度 img2img,只重绘"质感"(去平涂、加体积/材质),
复用原 alpha 轮廓避免造型漂移;再走深度法线,产出 <name>s_rgba.png / <name>s_normal.png。

用法: python stylize.py --name miku --strength 0.42
依赖 env: relightgen (torch cu128 + diffusers)
"""
import argparse
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from diffusers import StableDiffusionImg2ImgPipeline

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
PUB = ROOT / "web" / "public"

PROMPT = ("semi-realistic anime girl, soft volumetric studio lighting, detailed skin and fabric, "
          "subsurface shading, painterly realism, cinematic, highly detailed, masterpiece")
NEG = ("flat color, cel shading, hard lineart, sketch, lowres, blurry, bad anatomy, extra limbs, "
       "deformed hands, watermark, text, jpeg artifacts")


def to_mult8(w, h, longest=768):
    s = longest / max(w, h)
    return (int(round(w * s / 8) * 8), int(round(h * s / 8) * 8))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--src", default=None, help="默认 out/<name>_rgba.png")
    ap.add_argument("--model", default="Lykon/dreamshaper-8")
    ap.add_argument("--strength", type=float, default=0.42)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--guidance", type=float, default=6.5)
    ap.add_argument("--size", type=int, default=768)
    ap.add_argument("--seed", type=int, default=12345)
    args = ap.parse_args()

    src = args.src or str(OUT / f"{args.name}_rgba.png")
    rgba = cv2.cvtColor(cv2.imread(src, cv2.IMREAD_UNCHANGED), cv2.COLOR_BGRA2RGBA)
    H, W = rgba.shape[:2]
    alpha = rgba[..., 3]
    rgb = rgba[..., :3].astype(np.float32)
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    comp = (rgb * a + 255.0 * (1.0 - a)).astype(np.uint8)        # 白底,便于保边

    w8, h8 = to_mult8(W, H, args.size)
    pil = Image.fromarray(comp).resize((w8, h8), Image.LANCZOS)

    print(f"[load] {args.model} (fp16, cuda)")
    pipe = StableDiffusionImg2ImgPipeline.from_pretrained(
        args.model, torch_dtype=torch.float16, safety_checker=None, requires_safety_checker=False)
    pipe = pipe.to("cuda")
    pipe.set_progress_bar_config(disable=True)
    gen = torch.Generator("cuda").manual_seed(args.seed)

    print(f"[img2img] strength={args.strength} steps={args.steps} size={w8}x{h8}")
    out = pipe(prompt=PROMPT, negative_prompt=NEG, image=pil, strength=args.strength,
               num_inference_steps=args.steps, guidance_scale=args.guidance, generator=gen).images[0]

    styl = cv2.cvtColor(np.array(out.resize((W, H), Image.LANCZOS)), cv2.COLOR_RGB2BGR)
    styl_rgba = np.dstack([cv2.cvtColor(styl, cv2.COLOR_BGR2RGBA)[..., :3], alpha])  # 复用原 alpha

    name = f"{args.name}s"
    rgba_path = OUT / f"{name}_rgba.png"
    cv2.imwrite(str(rgba_path), cv2.cvtColor(styl_rgba, cv2.COLOR_RGBA2BGRA))
    (PUB / f"{name}_rgba.png").write_bytes(rgba_path.read_bytes())
    print(f"[done] 半写实 RGBA -> {rgba_path}")
    print(f"[next] 在 relight 环境跑法线: backend/make_normals.py --name {name}")


if __name__ == "__main__":
    main()
