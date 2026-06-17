"""
溶图 · 轻量重打光 v1 — FastAPI 后端(纯 CPU)。
- 静态托管 web/public 前端
- POST /api/character : 上传角色图 -> 抠图 + 法线 -> 存为 <name>_rgba.png / <name>_normal.png
- POST /api/scene     : 上传场景图 -> 光照估计 + 深度 -> 存为 scene.jpg / scene_depth.png / light.json
前端用 ?char=<name> 加载对应角色。

启动:  uvicorn app:app --host 127.0.0.1 --port 8000   (在 backend/ 目录下)
"""
import io
import json
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

import prep_character as pc
import estimate_light as el
import estimate_depth as ed
import imgio

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "web" / "public"
PUB.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="溶图 relight v1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def no_cache(request, call_next):
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


def _read_bgr(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


@app.post("/api/character")
async def process_character(file: UploadFile = File(...), name: str = Form("upload"),
                            strength: float = Form(4.0), detail: float = Form(0.4),
                            blur: float = Form(5.0)):
    """抠图 + 古典法线。返回前端可用的 char 名。"""
    pil = Image.open(io.BytesIO(await file.read()))
    arr = np.array(pil.convert("RGBA"))
    if pil.mode in ("RGBA", "LA", "PA") and arr[..., 3].min() < 245:
        rgba = arr                                    # 已有透明背景:直接用,不再重新抠
    else:
        sess = pc.new_session("isnet-anime")
        rgba = np.array(pc.remove(pil.convert("RGB"), session=sess, post_process_mask=True).convert("RGBA"))
    rgba = pc.autocrop(rgba)
    depth = pc.char_depth(rgba)                       # Depth-Anything 角色深度
    nrm = pc.alpha_to_normal(rgba, blur=blur, strength=strength, depth=depth, depth_w=0.6)
    imgio.publish_char_rgba(name, rgba)               # rgba -> webp(压缩)
    imgio.publish_png(f"{name}_normal.png", cv2.cvtColor(nrm[..., :3], cv2.COLOR_RGB2BGR))
    imgio.publish_png(f"{name}_ao.png", pc.compute_ao(rgba, depth))
    return {"char": name, "w": int(rgba.shape[1]), "h": int(rgba.shape[0])}


@app.post("/api/scene")
async def process_scene(file: UploadFile = File(...), elevation: float = Form(55.0)):
    """光照估计 + 深度。写 scene.jpg / scene_depth.png / light.json。"""
    data = await file.read()
    scene = _read_bgr(data)
    light = el.estimate(scene, elevation)
    (PUB / "light.json").write_text(json.dumps(light, indent=2))
    depth = ed.run_depth(scene)
    W, H = imgio.publish_scene(scene, depth)          # 下采样+压缩, scene 与 depth 同尺寸
    return JSONResponse({"scene": "scene.jpg", "depth": "scene_depth.png", "w": W, "h": H, "light": light})


@app.get("/api/chars")
async def chars():
    names = sorted({p.name[:-len("_rgba.webp")] for p in PUB.glob("*_rgba.webp")})
    return {"chars": names}


@app.get("/api/health")
async def health():
    have = {p.name for p in PUB.glob("*")}
    return {"ok": True, "assets": sorted(have)}


# 静态前端(放在 API 路由之后,作为兜底)
app.mount("/", StaticFiles(directory=str(PUB), html=True), name="static")
