"""高质量软 alpha 抠图(torch/GPU)。默认 ToonOut —— BiRefNet 针对二次元微调,
发丝/半透明/道具远好于硬遮罩(MIT)。可选通用 BiRefNet-matting。

用法(relightgen 环境):
  python backend/matte_birefnet.py inputs/char_miku.jpg --name miku
之后在 relight 环境跑:
  python backend/make_normals.py --name miku
"""
import argparse
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
PUB = ROOT / "web" / "public"
_MODEL = None


def load_model(variant: str = "toonout"):
    """toonout: BiRefNet 基座 + ToonOut 动漫微调权重;matting: 通用 BiRefNet-matting。"""
    global _MODEL
    if _MODEL is None:
        if variant == "toonout":
            from huggingface_hub import hf_hub_download
            m = AutoModelForImageSegmentation.from_pretrained("ZhengPeng7/BiRefNet", trust_remote_code=True)
            sd = torch.load(hf_hub_download("joelseytre/toonout", "birefnet_finetuned_toonout.pth"),
                            map_location="cpu")
            if isinstance(sd, dict) and "model" in sd:
                sd = sd["model"]
            sd = {k.replace("module._orig_mod.", ""): v for k, v in sd.items()}  # 去 compile/DDP 前缀
            m.load_state_dict(sd, strict=False)
            _MODEL = m.to("cuda").half().eval()
        else:
            _MODEL = AutoModelForImageSegmentation.from_pretrained(
                "ZhengPeng7/BiRefNet-matting", trust_remote_code=True).to("cuda").half().eval()
    return _MODEL


def matte(in_path: str, variant: str = "toonout", size: int = 1024) -> np.ndarray:
    pil = Image.open(in_path)
    arr = np.array(pil.convert("RGBA"))
    if pil.mode in ("RGBA", "LA", "PA") and arr[..., 3].min() < 245:
        return arr                                   # 已有透明背景:直接用 alpha,不再抠
    m = load_model(variant)
    img = pil.convert("RGB"); W, H = img.size
    tf = transforms.Compose([transforms.Resize((size, size)), transforms.ToTensor(),
                             transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    x = tf(img).unsqueeze(0).to("cuda").half()
    with torch.no_grad():
        p = m(x)[-1].sigmoid().cpu().float()[0, 0].numpy()
    alpha = cv2.resize((p * 255).astype(np.uint8), (W, H), interpolation=cv2.INTER_LINEAR)
    return np.dstack([np.array(img), alpha])


def autocrop(rgba, pad=12):
    a = rgba[..., 3]; ys, xs = np.where(a > 8)
    if not len(xs):
        return rgba
    y0, y1 = max(0, ys.min() - pad), min(rgba.shape[0], ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(rgba.shape[1], xs.max() + pad + 1)
    return rgba[y0:y1, x0:x1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--name", required=True)
    ap.add_argument("--model", choices=["toonout", "matting"], default="toonout")
    ap.add_argument("--size", type=int, default=1280, help="推理分辨率(源图更大时可调高到 1536/2048)")
    ap.add_argument("--no-crop", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    rgba = matte(args.input, variant=args.model, size=args.size)
    if not args.no_crop:
        rgba = autocrop(rgba)
    p = OUT / f"{args.name}_rgba.png"
    cv2.imwrite(str(p), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
    import imgio
    imgio.publish_char_rgba(args.name, rgba)   # webp 预览(法线/AO 由 make_normals 发布)
    print(f"[done] {args.name} ({args.model}) {rgba.shape[1]}x{rgba.shape[0]} -> make_normals.py --name {args.name}")


if __name__ == "__main__":
    main()
