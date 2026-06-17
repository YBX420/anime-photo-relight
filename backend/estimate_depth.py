"""
v1 场景深度估计(Depth-Anything-v2-small, ONNX, CPU)。
输出 out/scene_depth.png(8-bit 灰度, 越亮=越近),供前端做:
  - 遮挡:场景中比角色落点更"近"的像素盖在角色前面
  - 按落点深度自动缩放角色
"""
import argparse
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
MODEL = ROOT / "backend" / "models" / "da2s" / "onnx" / "model.onnx"

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def run_depth(scene_bgr: np.ndarray, size: int = 518) -> np.ndarray:
    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    iname = sess.get_inputs()[0].name
    H, W = scene_bgr.shape[:2]

    rgb = cv2.cvtColor(scene_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    x = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_CUBIC)
    x = (x - MEAN) / STD
    x = np.transpose(x, (2, 0, 1))[None].astype(np.float32)

    out = sess.run(None, {iname: x})[0]            # [1,H,W] or [1,1,H,W]
    depth = np.squeeze(out)
    depth = cv2.resize(depth, (W, H), interpolation=cv2.INTER_CUBIC)
    # Depth-Anything 输出 disparity 式:值大=近。归一到 0..1
    d = depth.astype(np.float32)
    d = (d - d.min()) / (d.max() - d.min() + 1e-8)
    return d                                         # 1=最近, 0=最远


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default=str(ROOT / "inputs" / "scene_7eleven.jpg"))
    ap.add_argument("--out", default=str(OUT / "scene_depth.png"))
    args = ap.parse_args()

    scene = cv2.imread(args.scene)
    d = run_depth(scene)
    cv2.imwrite(args.out, (d * 255).astype(np.uint8))
    print(f"[done] {args.out}  shape={d.shape} near={d.max():.3f} far={d.min():.3f}")


if __name__ == "__main__":
    main()
