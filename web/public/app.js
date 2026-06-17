/* 溶图 · 半写实重打光 v1.2 — PixiJS v8 (UMD global PIXI)
   统一深度场(场景深度 + 角色按站立点插入) -> 深度景深(DOF) + 深度遮挡;
   重打光(受光高光/反向压暗/调色) + 地面投影剪影阴影 + bloom 泛光。
*/
const PX = window.PIXI;

const FILTER_VERT = `#version 300 es
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vUV;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
vec4 filterVertexPosition(void){
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
vec2 filterTextureCoord(void){ return aPosition * (uOutputFrame.zw * uInputSize.zw); }
void main(void){ gl_Position = filterVertexPosition(); vTextureCoord = filterTextureCoord(); vUV = aPosition; }`;

const RELIGHT_FRAG = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uNormalMap;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;
uniform float uAmbient;
uniform float uDiffuse;
uniform float uHighlight;
uniform float uShadowDark;
uniform float uExposure;
uniform vec3 uTint;
uniform float uDebug;
uniform sampler2D uAO;
uniform float uAOStrength;
uniform float uRim;
uniform vec3 uRimColor;
uniform vec4 uInputSize;
uniform float uEdgeSoft;
void main(){
  vec4 a = texture(uTexture, vTextureCoord);                          // 锐利中心采样
  if (uDebug > 0.5){ finalColor = vec4(texture(uNormalMap, vUV).rgb * a.a, a.a); return; }
  // 仅羽化"边缘":3x3 预乘平均只用于输出 alpha 和边缘外取色;内部颜色保持锐利,不模糊细节
  vec2 t = uInputSize.zw * uEdgeSoft;
  vec4 acc = a * 4.0;
  acc += (texture(uTexture, vTextureCoord + vec2(t.x, 0.0)) + texture(uTexture, vTextureCoord - vec2(t.x, 0.0))
        + texture(uTexture, vTextureCoord + vec2(0.0, t.y)) + texture(uTexture, vTextureCoord - vec2(0.0, t.y))) * 2.0;
  acc += texture(uTexture, vTextureCoord + t) + texture(uTexture, vTextureCoord - t)
       + texture(uTexture, vTextureCoord + vec2(t.x, -t.y)) + texture(uTexture, vTextureCoord + vec2(-t.x, t.y));
  acc /= 16.0;
  float softA = acc.a;                                                // 仅 alpha 被羽化
  if (softA < 0.004){ finalColor = vec4(0.0); return; }
  vec3 base = a.a > 0.02 ? (a.rgb / a.a) : (acc.rgb / max(acc.a, 0.004)); // 内部锐利, 仅边缘外借平均色避免黑边
  vec3 N = normalize(texture(uNormalMap, vUV).xyz * 2.0 - 1.0);
  vec3 L = normalize(uLightDir);
  float ndl = dot(N, L);
  float diff = max(ndl, 0.0);
  float hi = pow(diff, 6.0) * uHighlight;
  float back = mix(1.0, 1.0 - uShadowDark, clamp(-ndl, 0.0, 1.0));
  float ao = mix(1.0, texture(uAO, vUV).r, uAOStrength);           // 环境光遮蔽
  vec3 shade = (uAmbient * uAmbientColor + uDiffuse * diff * uLightColor) * back * ao;
  float rim = pow(1.0 - max(N.z, 0.0), 2.5) * max(ndl, 0.0);        // 朝光的边缘补光
  vec3 col = base * shade + hi * uLightColor + rim * uRim * uRimColor;
  col = clamp(col * uExposure * uTint, 0.0, 1.0);
  finalColor = vec4(col * softA, softA);
}`;

const BRIGHT_FRAG = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uThreshold;
void main(){
  vec4 a = texture(uTexture, vTextureCoord);
  if (a.a < 0.01){ finalColor = vec4(0.0); return; }
  vec3 c = a.rgb / max(a.a, 0.01);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float k = smoothstep(uThreshold, 1.0, l);
  finalColor = vec4(c * k * a.a, a.a * k);
}`;

// 背景深度景深(DOF):离焦平面越远越虚。focus=角色站立深度 -> 统一深度场。
const DOF_FRAG = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexture;   // 清晰场景
uniform sampler2D uBlur;      // 预模糊场景
uniform sampler2D uDepth;
uniform float uFocus;
uniform float uRange;
uniform float uEnable;
uniform float uStrength;
void main(){
  vec4 sharp = texture(uTexture, vTextureCoord);
  if (uEnable < 0.5 || uStrength < 0.001){ finalColor = sharp; return; }
  vec4 blur = texture(uBlur, vUV);
  float d = texture(uDepth, vUV).r;
  float coc = clamp(abs(d - uFocus) / uRange, 0.0, 1.0) * uStrength;
  finalColor = mix(sharp, blur, clamp(coc, 0.0, 1.0));
}`;

// 深度遮挡 + DOF:仅保留比角色更近的场景像素,且按 DOF 虚化(前景散景)
const OCC_FRAG = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uBlur;
uniform sampler2D uDepth;
uniform float uCharDepth;
uniform float uFocus;
uniform float uRange;
uniform float uEnable;
uniform float uDof;
uniform float uStrength;
void main(){
  if (uEnable < 0.5){ finalColor = vec4(0.0); return; }
  float d = texture(uDepth, vUV).r;
  float occ = smoothstep(uCharDepth + 0.005, uCharDepth + 0.07, d);   // 软边遮挡
  if (occ <= 0.002){ finalColor = vec4(0.0); return; }
  vec3 col = texture(uTexture, vTextureCoord).rgb;
  if (uDof > 0.5 && uStrength > 0.001){
    vec3 blur = texture(uBlur, vUV).rgb;
    float coc = clamp(clamp(abs(d - uFocus) / uRange, 0.0, 1.0) * uStrength, 0.0, 1.0);
    col = mix(col, blur, coc);
  }
  finalColor = vec4(col * occ, occ);                                  // 预乘软 alpha
}`;

// 深度感知地面投影阴影:把角色剪影沿光向投到地面,按场景深度门控(只落地面/被前景遮挡)
const SHADOW_FRAG = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uCharTex;
uniform sampler2D uDepth;
uniform vec2 uFeet;      // 角色脚下, 屏幕 0..1
uniform vec2 uCharWH;    // 角色显示宽高, 屏幕 0..1
uniform vec3 uLight;     // 屏幕空间 x右 y上 z朝观者
uniform float uCharDepth;
uniform float uGround;   // 地面前缩(影长)
uniform float uStrength;
void main(){
  vec2 d = vUV - uFeet;                                  // 相对脚下(y 向下为正)
  float hf = d.y / (uCharWH.y * uGround);                // 对应角色高度比例
  if (hf <= 0.002 || hf > 1.0){ finalColor = vec4(0.0); return; }
  float shear = uLight.x / max(uLight.y, 0.25);
  float shiftX = hf * uCharWH.y * shear;                 // 沿光反方向错切
  float u = 0.5 + (d.x - shiftX) / uCharWH.x;
  if (u < 0.0 || u > 1.0){ finalColor = vec4(0.0); return; }
  float ca = texture(uCharTex, vec2(u, 1.0 - hf)).a;     // 采样剪影 alpha
  float dep = texture(uDepth, vUV).r;
  float gate = smoothstep(uCharDepth - 0.28, uCharDepth - 0.04, dep);  // 仅落在地面(深度≈脚下/更近)
  float fade = 1.0 - hf * 0.45;                          // 远端渐淡
  finalColor = vec4(0.0, 0.0, 0.0, ca * uStrength * gate * fade);
}`;

function f32(a){ return new Float32Array(a); }

(async () => {
  const app = new PX.Application();
  const CHAR = new URLSearchParams(location.search).get('char') || 'rei';
  // 先加载场景 -> 用其真实尺寸初始化画布(任意比例都正确,不再写死 2000x1334)
  const sceneTex = await PX.Assets.load('./scene.jpg');
  const SCENE_W = sceneTex.width, SCENE_H = sceneTex.height;
  await app.init({ width: SCENE_W, height: SCENE_H, background: 0x10141a,
                   antialias: true, preference: 'webgl',
                   resolution: 2, autoDensity: false });   // 2× 超采样:角色保持清晰,坐标逻辑仍按 SCENE_W/H
  document.getElementById('stage').appendChild(app.canvas);

  // 画布按可用空间等比适配:填满可用宽,但不超视口高,任意比例都不变形
  function fitCanvas(){
    const stage = document.getElementById('stage');
    const availW = stage.clientWidth || (window.innerWidth - 340);
    const availH = window.innerHeight - 36;
    const ar = SCENE_W / SCENE_H;
    let w = availW, h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    app.canvas.style.width = Math.round(w) + 'px';
    app.canvas.style.height = Math.round(h) + 'px';
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  // 角色资产:webp 优先 -> png 回退 -> 缺失则回退 miku(避免 404 崩溃)
  let charName = CHAR;
  const loadRgba = async (n) => {
    for (const ext of ['webp', 'png']) {
      try { return await PX.Assets.load(`./${n}_rgba.${ext}`); } catch (e) {}
    }
    return null;
  };
  let charTex = await loadRgba(charName);
  if (!charTex && charName !== 'miku') {
    showErr(`角色「${charName}」资产不存在,已回退到 miku(请在面板里重新上传)`);
    charName = 'miku'; charTex = await loadRgba('miku');
  }
  if (!charTex) throw new Error('找不到任何角色资产');
  const [normalTex, depthTex] = await Promise.all([
    PX.Assets.load(`./${charName}_normal.png`),
    PX.Assets.load('./scene_depth.png'),
  ]);
  const light = await (await fetch('./light.json')).json();
  let aoTex;
  try { aoTex = await PX.Assets.load(`./${charName}_ao.png`); } catch (e) { aoTex = PX.Texture.WHITE; }

  // 接地点(脚的位置):默认=抠图底边(适配大多数角色,脚就在底部)。
  // 长发/拖尾垂到脚下方的角色(如初音),用面板「接地点」滑块上移即可。
  let footFrac = 1.0;

  // 预模糊场景 -> RenderTexture(DOF 的"虚化层",一次性)
  const blurRT = PX.RenderTexture.create({ width: SCENE_W, height: SCENE_H });
  const blurSrc = new PX.Sprite(sceneTex);
  // repeatEdgePixels:模糊时钳制边缘像素,既不发暗也不缩放(与清晰层对齐)
  blurSrc.filters = [new PX.BlurFilter({ strength: 11, quality: 6, repeatEdgePixels: true })];
  app.renderer.render({ container: blurSrc, target: blurRT });

  // 羽化深度图(软化深度边缘)-> DOF/遮挡过渡更平滑, 消除深度硬圈
  const depthSoftRT = PX.RenderTexture.create({ width: SCENE_W, height: SCENE_H });
  const depthSrc = new PX.Sprite(depthTex);
  depthSrc.filters = [new PX.BlurFilter({ strength: 4, quality: 4, repeatEdgePixels: true })];
  app.renderer.render({ container: depthSrc, target: depthSoftRT });

  // 读深度像素(落点深度 -> DOF 焦平面 / 遮挡 / 缩放)
  const dImg = new Image(); dImg.src = './scene_depth.png'; await dImg.decode();
  const dCan = document.createElement('canvas'); dCan.width = SCENE_W; dCan.height = SCENE_H;
  const dCtx = dCan.getContext('2d', { willReadFrequently: true });
  dCtx.drawImage(dImg, 0, 0, SCENE_W, SCENE_H);
  const depthData = dCtx.getImageData(0, 0, SCENE_W, SCENE_H).data;
  const sampleDepth = (x, y) => {
    x = Math.max(0, Math.min(SCENE_W - 1, x | 0)); y = Math.max(0, Math.min(SCENE_H - 1, y | 0));
    return depthData[(y * SCENE_W + x) * 4] / 255;
  };

  // 场景颜色画布(用于环境色渗入)
  const sImg = new Image(); sImg.src = './scene.jpg'; await sImg.decode();
  const sCan = document.createElement('canvas'); sCan.width = SCENE_W; sCan.height = SCENE_H;
  const sCtx = sCan.getContext('2d', { willReadFrequently: true });
  sCtx.drawImage(sImg, 0, 0, SCENE_W, SCENE_H);
  const sceneData = sCtx.getImageData(0, 0, SCENE_W, SCENE_H).data;
  const sceneColor = (x, y) => {
    x = Math.max(0, Math.min(SCENE_W - 1, x | 0)); y = Math.max(0, Math.min(SCENE_H - 1, y | 0));
    const i = (y * SCENE_W + x) * 4; return [sceneData[i], sceneData[i + 1], sceneData[i + 2]];
  };
  const mix3 = (a, b, t) => [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];
  const envColor = (cx, fy, w, h) => {        // 角色周围环境色,归一为色调
    const pts = [[cx - w * 0.6, fy - h * 0.5], [cx + w * 0.6, fy - h * 0.5], [cx, fy + 14], [cx, fy - h * 0.85]];
    let r = 0, g = 0, b = 0;
    for (const [x, y] of pts) { const c = sceneColor(x, y); r += c[0]; g += c[1]; b += c[2]; }
    const n = pts.length; r /= n; g /= n; b /= n;
    const m = Math.max(r, g, b, 1);
    return [r / m, g / m, b / m];
  };

  const Lv = [...light.dir];
  const lightColor = light.color || [1, 0.95, 0.85];
  const ambientColor = light.ambientColor || [0.6, 0.7, 0.85];
  const DOF_RANGE = 0.9;   // 大 = 更多在焦, 景深更轻(默认虚化较弱)

  // 1) 背景 + DOF
  const bg = new PX.Sprite(sceneTex);
  const dof = new PX.Filter({
    glProgram: new PX.GlProgram({ vertex: FILTER_VERT, fragment: DOF_FRAG }),
    resources: {
      uBlur: blurRT.source, uDepth: depthSoftRT.source,
      dofUniforms: { uFocus: { value: 0.9, type: 'f32' }, uRange: { value: DOF_RANGE, type: 'f32' },
                     uEnable: { value: 1.0, type: 'f32' }, uStrength: { value: 0.0, type: 'f32' } },
    },
  });
  bg.filters = [dof];
  app.stage.addChild(bg);

  // 2) 角色剪影地面阴影(剪影压扁/错切贴地)—— 可拖拽 + 可开关
  const shadowSil = new PX.Sprite(charTex);
  shadowSil.anchor.set(0.5, 1.0);
  shadowSil.tint = 0x000000;
  shadowSil.blendMode = 'multiply';
  shadowSil.filters = [new PX.BlurFilter({ strength: 9, quality: 4 })];
  shadowSil.filters[0].clipToViewport = false;
  shadowSil.eventMode = 'static';
  shadowSil.cursor = 'move';
  app.stage.addChild(shadowSil);

  // 3) 角色重打光
  const relight = new PX.Filter({
    glProgram: new PX.GlProgram({ vertex: FILTER_VERT, fragment: RELIGHT_FRAG }),
    resources: {
      uNormalMap: normalTex.source,
      uAO: aoTex.source,
      lightUniforms: {
        uLightDir:     { value: f32(Lv), type: 'vec3<f32>' },
        uLightColor:   { value: f32(lightColor), type: 'vec3<f32>' },
        uAmbientColor: { value: f32(ambientColor), type: 'vec3<f32>' },
        uAmbient:      { value: Math.min(light.ambient ?? 0.25, 0.24), type: 'f32' },
        uDiffuse:      { value: 0.92, type: 'f32' },
        uHighlight:    { value: 0.6, type: 'f32' },
        uShadowDark:   { value: 0.72, type: 'f32' },
        uExposure:     { value: 1.0, type: 'f32' },
        uTint:         { value: f32([1.05, 1.0, 0.93]), type: 'vec3<f32>' },
        uDebug:        { value: new URLSearchParams(location.search).get('debug') === 'normal' ? 1.0 : 0.0, type: 'f32' },
        uAOStrength:   { value: 0.85, type: 'f32' },
        uRim:          { value: 0.5, type: 'f32' },
        uRimColor:     { value: f32(lightColor), type: 'vec3<f32>' },
        uEdgeSoft:     { value: 1.1, type: 'f32' },
      },
    },
  });
  relight.padding = 0;
  relight.clipToViewport = false;   // 角色移出画布边缘时不裁剪帧缓冲,保持法线 UV 对齐
  const char = new PX.Sprite(charTex);
  char.anchor.set(0.5, 1.0);   // 锚点=抠图底边(角色完整渲染,不裁脚)
  char.filters = [relight];
  char.eventMode = 'static';
  char.cursor = 'grab';
  app.stage.addChild(char);

  // 4) bloom 泛光
  const glow = new PX.Sprite(charTex);
  glow.anchor.set(0.5, 1.0);
  glow.blendMode = 'add';
  glow.alpha = 0.5;
  glow.filters = [
    new PX.Filter({ glProgram: new PX.GlProgram({ vertex: FILTER_VERT, fragment: BRIGHT_FRAG }),
      resources: { brightUniforms: { uThreshold: { value: 0.72, type: 'f32' } } } }),
    new PX.BlurFilter({ strength: 7, quality: 4 }),
  ];
  glow.filters.forEach(f => { f.clipToViewport = false; });
  app.stage.addChild(glow);

  // 5) 深度遮挡 + DOF
  const occlude = new PX.Sprite(sceneTex);
  const occFilter = new PX.Filter({
    glProgram: new PX.GlProgram({ vertex: FILTER_VERT, fragment: OCC_FRAG }),
    resources: {
      uBlur: blurRT.source, uDepth: depthSoftRT.source,
      occUniforms: { uCharDepth: { value: 0.9, type: 'f32' }, uFocus: { value: 0.9, type: 'f32' },
                     uRange: { value: DOF_RANGE, type: 'f32' }, uEnable: { value: 1.0, type: 'f32' },
                     uDof: { value: 1.0, type: 'f32' }, uStrength: { value: 0.0, type: 'f32' } },
    },
  });
  occlude.filters = [occFilter];
  app.stage.addChild(occlude);

  // ---------- 状态 ----------
  const baseScale = (SCENE_H * 0.55) / charTex.height;   // 角色约占场景高 55%
  const state = { x: SCENE_W * 0.5, y: SCENE_H * 0.9, scaleMul: 1, occ: true, shadow: true,
                  depthScale: false, dof: true, glow: true, envAmt: 1.0, shadowAlpha: 1.0,
                  shDX: 0, shDY: 0, shLen: 1.0, shAngle: 0 };
  const lerp = (a, b, t) => a + (b - a) * t;

  function layout(){
    let s = baseScale * state.scaleMul;
    const cd = sampleDepth(state.x, state.y - 4);          // 角色站立点深度
    if (state.depthScale) s *= lerp(0.45, 1.15, cd);
    const sc = s;

    for (const sp of [char, glow]){ sp.position.set(state.x, state.y); sp.scale.set(sc); sp.skew.x = 0; }

    // 环境色渗入:环境光/边缘光吸收角色周围的背景颜色
    const env = envColor(state.x, state.y, charTex.width * sc, charTex.height * sc);
    const lu = relight.resources.lightUniforms.uniforms;
    lu.uAmbientColor = f32(mix3(ambientColor, env, 0.6 * state.envAmt));
    lu.uRimColor = f32(mix3(lightColor, env, 0.45 * state.envAmt));

    // 角色剪影地面阴影:从脚部接地线压扁贴地 + 朝光反方向错切;可拖拽偏移
    const lx = Lv[0], ly = Math.max(0.25, Lv[1]);
    const footY = state.y - (1.0 - footFrac) * charTex.height * sc;  // 脚部接地线(「接地点」滑块)
    const slen = (0.30 + 0.55 * (1.0 - ly)) * state.shLen;  // 太阳越低越长 × 用户长度
    shadowSil.position.set(state.x + state.shDX, footY + state.shDY);
    shadowSil.scale.set(sc, -sc * slen);                  // 负=从脚下贴地朝前压扁
    shadowSil.skew.x = -(lx / ly);                        // 沿光反方向错切
    shadowSil.rotation = state.shAngle;                   // 影子角度(用户旋转)
    shadowSil.alpha = 0.5 * state.shadowAlpha;
    shadowSil.visible = state.shadow;

    // 统一深度焦平面 = 角色站立深度
    dof.resources.dofUniforms.uniforms.uFocus = cd;
    dof.resources.dofUniforms.uniforms.uEnable = state.dof ? 1.0 : 0.0;
    const occU = occFilter.resources.occUniforms.uniforms;
    occU.uCharDepth = cd; occU.uFocus = cd;
    occU.uEnable = state.occ ? 1.0 : 0.0; occU.uDof = state.dof ? 1.0 : 0.0;

    glow.visible = state.glow;

    document.getElementById('stat-depth').textContent =
      `站立深度: ${cd.toFixed(2)} (1近/0远) · 焦平面=此处 · 缩放×${(sc / baseScale).toFixed(2)}`;
    document.getElementById('stat-toggle').textContent =
      `遮挡 ${state.occ ? '✓' : '✗'} · 阴影 ${state.shadow ? '✓' : '✗'} · 深度缩放 ${state.depthScale ? '✓' : '✗'} · 景深 ${state.dof ? '✓' : '✗'} · 泛光 ${state.glow ? '✓' : '✗'}`;
  }

  function setLight(lx, ly, lz){
    const n = Math.hypot(lx, ly, lz) || 1;
    Lv[0] = lx / n; Lv[1] = ly / n; Lv[2] = lz / n;
    relight.resources.lightUniforms.uniforms.uLightDir = f32(Lv);
    document.getElementById('stat-light').textContent =
      `光向: [${Lv.map(v => v.toFixed(2)).join(', ')}]`;
    layout();
  }

  // ---------- 交互 ----------
  // 只有角色和影子可拖;其它图层不拦截指针
  for (const sp of [bg, glow, occlude]) sp.eventMode = 'none';

  app.stage.eventMode = 'static';
  app.stage.hitArea = app.screen;
  let mode = null, grabDX = 0, grabDY = 0;
  char.on('pointerdown', (e) => {
    mode = 'char'; char.cursor = 'grabbing';
    grabDX = state.x - e.global.x; grabDY = state.y - e.global.y;
    e.stopPropagation();
  });
  shadowSil.on('pointerdown', (e) => {              // 影子可独立拖拽
    mode = 'shadow';
    grabDX = state.shDX - e.global.x; grabDY = state.shDY - e.global.y;
    e.stopPropagation();
  });
  app.stage.on('pointerup', () => { mode = null; char.cursor = 'grab'; });
  app.stage.on('pointerupoutside', () => { mode = null; });
  app.stage.on('pointermove', onMove);
  function onMove(e){
    if (!mode) return;
    const p = e.global;
    if (mode === 'char'){ state.x = p.x + grabDX; state.y = p.y + grabDY; layout(); }
    else if (mode === 'shadow'){ state.shDX = p.x + grabDX; state.shDY = p.y + grabDY; layout(); }
    // 调光改用面板 puck(已移除背景拖拽调光)
  }
  app.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.scaleMul = Math.max(0.2, Math.min(3, state.scaleMul * (1 - e.deltaY * 0.0012)));
    layout();
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'o') state.occ = !state.occ;
    else if (k === 's') state.shadow = !state.shadow;
    else if (k === 'd') state.depthScale = !state.depthScale;
    else if (k === 'b') state.dof = !state.dof;
    else if (k === 'g') state.glow = !state.glow;
    else return;
    layout();
  });

  window.__setDemo = (o = {}) => {
    if (o.x != null) state.x = o.x;
    if (o.y != null) state.y = o.y;
    if (o.scale != null) state.scaleMul = o.scale;
    for (const k of ['occ', 'shadow', 'dof', 'glow', 'depthScale'])
      if (o[k] != null) state[k] = o[k];
    if (o.light) setLight(o.light[0], o.light[1], o.light[2]); else layout();
  };

  window.__getState = () => ({ x: state.x, y: state.y, light: [...Lv] });

  // 控制面板接口
  window.__app = {
    char: charName,
    setLightXY: (px, py) => setLight(px, py, 0.6),
    getLight: () => [...Lv],
    setParam: (k, v) => {
      const lu = relight.resources.lightUniforms.uniforms;
      if (k === 'ambient') lu.uAmbient = v;
      else if (k === 'diffuse') lu.uDiffuse = v;
      else if (k === 'exposure') lu.uExposure = v;
      else if (k === 'highlight') lu.uHighlight = v;
      else if (k === 'shadowDark') lu.uShadowDark = v;
      else if (k === 'ao') lu.uAOStrength = v;
      else if (k === 'rim') lu.uRim = v;
      else if (k === 'edgeSoft') lu.uEdgeSoft = v;
      else if (k === 'shadowStrength') { state.shadowAlpha = v; layout(); }
      else if (k === 'foot') { footFrac = Math.max(0.3, Math.min(1, v)); layout(); }
      else if (k === 'shLen') { state.shLen = v; layout(); }
      else if (k === 'shAngle') { state.shAngle = v * Math.PI / 180; layout(); }
      else if (k === 'aperture') {                    // 0=无虚化;越大景深越浅、虚化越强(区间已拉大)
        const str = v * 1.5, rng = 0.16 + (1 - Math.min(v, 1)) * 0.9;
        const du = dof.resources.dofUniforms.uniforms, ou = occFilter.resources.occUniforms.uniforms;
        du.uStrength = str; du.uRange = rng; ou.uStrength = str; ou.uRange = rng;
      }
      else if (k === 'glowAlpha') glow.alpha = v;
      else if (k === 'env') { state.envAmt = v; layout(); }
    },
    toggle: (k, b) => { state[k] = b; layout(); },
    reEstimate: async () => { const l = await (await fetch('./light.json?' + Date.now())).json(); setLight(l.dir[0], l.dir[1], l.dir[2]); },
    defaults: {
      ambient: Math.min(light.ambient ?? 0.25, 0.24), diffuse: 0.92, exposure: 1.0, highlight: 0.6,
      shadowDark: 0.72, ao: 0.85, rim: 0.5, shadowStrength: 1.0, dofRange: DOF_RANGE,
      glowAlpha: 0.5, env: 1.0, edgeSoft: 1.1, foot: footFrac, aperture: 0.5,
      shLen: 1.0, shAngle: 0,
    },
  };
  window.dispatchEvent(new Event('app-ready'));

  setLight(Lv[0], Lv[1], Lv[2]);
  layout();
  window.__ready = true;
})();
