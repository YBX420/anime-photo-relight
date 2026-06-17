# 溶图 · 轻量动漫角色重打光合成

**简体中文** | [English](./README.en.md)

把二次元角色合成进真实照片:**保留原始 2D 画风,只让光影写实**。纯 CPU 后端一次性预处理 + 浏览器(PixiJS)实时重打光,可拖拽、Apple 风格控制面板。

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg) ![后端纯CPU](https://img.shields.io/badge/backend-CPU--only-green.svg) ![WebGL](https://img.shields.io/badge/frontend-WebGL%20%2F%20PixiJS%20v8-orange.svg)

![711](demo/711_demo.jpg)

| | |
|---|---|
| ![beach](demo/beach_amia_demo.jpg) | ![street](demo/street_demo.jpg) |

---

## 功能

- **抠图** — ToonOut(BiRefNet 二次元微调,软 alpha);已透明的图直接用其通道。
- **重打光(实时)** — Lambert 漫反射 + 受光侧高光 + 反向压暗 + 曝光/色调调色。
- **AO 自阴影**、**边缘补光 rim**、**环境色渗入**(角色边缘吸收背景局部色)。
- **剪影地面阴影** — 按光向压扁错切;**可拖拽**,并可调长度 / 角度 / 浓度 / 接地点 / 开关。
- **深度景深(DOF)** — 统一深度场,光圈式虚化(0=不虚化,可拉到很强),边缘干净不发暗。
- **深度遮挡**(近景物体盖住角色)、**边缘羽化**(只软化轮廓、内部保持清晰)、**bloom 泛光**。
- **交互** — 拖角色 / 拖影子 / 滚轮缩放 / 光照 puck;画布按任意比例自适应 + 2× 超采样。
- **控制面板** — Apple 磨砂玻璃风,全参数实时滑块;角色动态下拉、上传角色/场景(带加载动画)。

## 组件选型

| 环节 | 选用 | 说明 |
|---|---|---|
| 抠图 | **ToonOut**(`joelseytre/toonout`,二次元微调 BiRefNet) | 发丝/网兜/半透明最佳,MIT,GPU |
| 抠图(CPU 回退) | `rembg` isnet‑anime / birefnet‑general | 上传接口用,纯 CPU |
| 角色法线/AO | Depth‑Anything‑v2‑small 深度 → 法线 + 凹陷烘焙 AO | ONNX,CPU |
| 场景光照 | OpenCV 地面受光区亮度质心 | 零模型,puck 可改 |
| 场景深度 | Depth‑Anything‑v2‑small ONNX | 景深 + 遮挡 |
| 渲染 | PixiJS v8 + 自写 GLSL | WebGL,vendored,零构建 |

## 安装(miniconda)

```bash
# 1) 服务 + 推理(纯 CPU)
conda create -n relight -c conda-forge python=3.10 -y
conda run -n relight python -m ensurepip --upgrade
conda run -n relight pip install fastapi "uvicorn[standard]" python-multipart \
    onnxruntime rembg opencv-python-headless numpy pillow playwright huggingface_hub
conda run -n relight playwright install chromium      # demo / 截图工具用

# 2) 高质量抠图(ToonOut,需 GPU;可选)
conda create -n relightgen -c conda-forge python=3.10 -y
conda run -n relightgen python -m ensurepip --upgrade
conda run -n relightgen pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
conda run -n relightgen pip install transformers einops timm pillow opencv-python-headless huggingface_hub
```

> **模型权重不在仓库内**(Depth‑Anything ≈ 99 MB,超 GitHub 100 MB 限制):首次运行 `estimate_depth.py` / `make_normals.py` 时自动从 HuggingFace 下载;ToonOut、rembg 权重同样首次自动下载。

## 运行

```bash
./run.sh
# 或:conda run -n relight uvicorn app:app --app-dir backend --host 127.0.0.1 --port 8000
# 打开 http://127.0.0.1:8000/?char=<名字>
```

## 添加角色 / 场景

仓库不含版权原图与生成资产,自备图片后:

```bash
# 角色(高质量 ToonOut,GPU):
conda run -n relightgen python backend/matte_anime.py inputs/你的角色.png --name 名字
conda run -n relight   python backend/make_normals.py --name 名字
# 或纯 CPU 一步(质量略低):
conda run -n relight   python backend/prep_character.py inputs/你的角色.png --name 名字

# 场景:
conda run -n relight python backend/estimate_light.py --scene inputs/你的场景.jpg
conda run -n relight python backend/estimate_depth.py --scene inputs/你的场景.jpg
```

网页面板里的 **上传角色 / 上传场景** 按钮可直接在浏览器完成上述流程(带加载动画)。

## 控制面板

- **拖角色** = 移动 · **拖影子** = 单独移影子 · **滚轮** = 缩放 · **光照 puck** = 调光向
- 光照:主光 / 环境光 / 曝光 / 高光 / 背光压暗
- 写实效果:AO / 边缘补光 / 环境色渗入 / 阴影浓度 / 接地点 / 影子长度 / 影子角度 / 光圈(景深)/ 泛光 / 边缘柔化
- 开关:阴影 / 遮挡 / 景深 / 泛光 / 深度缩放

## 目录

```
backend/   app.py(FastAPI:静态托管 + 上传处理)· matte_anime.py(ToonOut)
           prep_character / make_normals / estimate_light / estimate_depth / preview_composite / imgio
           devtools/(shoot · dragtest · ui_shot · make_demo)· experimental/(已废弃 img2img)
web/public/ index.html · app.js · vendor/(PixiJS, interact.js)
inputs/    源图(不在仓库)   out/ 生成产物(不在仓库)   demo/ 展示图
```

## 局限

- **「半写实」= 光影写实,角色保留 2D**;曾试 img2img 把角色转真人(`experimental/`),与目标不符已废弃。
- 角色法线是深度近似;光向估计有歧义(puck 兜底);剪影阴影是屏幕投影 + 可手调,非物理光追。
- 上传走 CPU rembg;最佳发丝质量请用 GPU 的 `matte_anime.py`(ToonOut)。

## 版权 / 许可

demo 与示例中的动漫角色(Arknights、初音未来、EVA 等)版权归各自所有者;本项目仅作**技术演示 / 学习**用途,不分发原始角色素材。模型与库(ToonOut/BiRefNet、Depth‑Anything‑v2、rembg、PixiJS、FastAPI)遵循各自许可证。

**代码以 MIT 许可发布。**
