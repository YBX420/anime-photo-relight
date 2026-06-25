// scene2d.js
// A 2D isometric renderer drawn on a plain Canvas, styled after the soft,
// rounded, pastel, ambient-occluded look of *Townscaper* — recreated with
// original drawing code, not copied assets. The CFD grid (src/fluid.js) is a
// top-down square, which maps onto the isometric floor by a single linear
// transform, so the heat field and airflow drop straight in.
//
// Public API mirrors what game.js / ui.js expect (createFan, pickFloor, etc.)
// so the simulation and UI layers didn't have to change.

const TAU = Math.PI * 2;

// soft pastel palette
const PAL = {
  sky1: '#bfe6ff', sky2: '#eaf8ff',
  nightTint: '20,28,60',
  water: 0x9ed8d6, waterN: 0x46708c,
  island: 0xe9cfa3, islandSide: 0xd6b483, islandDark: 0xc6a06e,
  floor: 0xf2e0bd, floorLine: 0xe6cfa3,
  wall: 0xf6efe3, wallTop: 0xfdf8ee, wallSide: 0xe7dcc8,
  glass: 0xbfe8ff, frame: 0xcdb79c,
  rug: 0xf2c2a6,
  bodyA: 0x8fb8e8, bodyB: 0x6f9fda, skin: 0xffdcbb, skinHot: 0xff9d88,
};

function shade(n, f) {
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (f >= 1) { const t = f - 1; r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t; }
  else { r *= f; g *= f; b *= f; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export class Scene2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.N = 64;
    this.roomSize = 8;

    this.fans = [];
    this.furnitureItems = [];
    this.character = { gi: 42, gj: 23, hot: 0, t: 0 };
    this.windowWall = 'back';
    this.windowOpen = true;
    this.winA = Math.floor(this.N * 0.34);
    this.winB = Math.floor(this.N * 0.66);
    this.isDayNow = true;
    this.sun = 1;

    // heat field rendered to an offscreen NxN canvas, then warped onto the floor
    this.heatCanvas = document.createElement('canvas');
    this.heatCanvas.width = this.N; this.heatCanvas.height = this.N;
    this.heatCtx = this.heatCanvas.getContext('2d');
    this.heatImg = this.heatCtx.createImageData(this.N, this.N);

    this.resize();
  }

  // --- isometric projection -------------------------------------------------
  // grid (u,v) in 1..N, height h in pixels (up). Fixed camera; +u → lower-right,
  // +v → lower-left, so (low u, low v) is the far corner at the top.
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.W = w; this.H = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const N = this.N;
    // fit the diamond width to ~78% of the viewport
    this.sx = Math.min((w * 0.78) / (2 * N), (h * 0.92) / (1.6 * N));
    this.sy = this.sx * 0.5;
    this.unit = this.sx;                 // pixels per grid cell (for heights)
    this.AX = { x: this.sx, y: this.sy };
    this.AY = { x: -this.sx, y: this.sy };
    this.c = (N + 1) / 2;
    this.originX = w / 2;
    this.originY = h * 0.40;
  }

  toScreen(u, v, h = 0) {
    const du = u - this.c, dv = v - this.c;
    return [
      this.originX + du * this.AX.x + dv * this.AY.x,
      this.originY + du * this.AX.y + dv * this.AY.y - h,
    ];
  }

  // inverse of toScreen on the floor plane (h = 0)
  fromScreen(px, py) {
    const dx = px - this.originX, dy = py - this.originY;
    const a = this.AX.x, b = this.AY.x, cc = this.AX.y, d = this.AY.y;
    const det = a * d - b * cc;
    const du = (dx * d - b * dy) / det;
    const dv = (a * dy - dx * cc) / det;
    return [du + this.c, dv + this.c];
  }

  depthOf(gi, gj) { return gi + gj; } // painter's order key

  // --- public mutators ------------------------------------------------------

  initParticles(count = 1200) {
    const N = this.N;
    this.partCount = count;
    this.partPos = new Float32Array(count * 2);
    this.partLife = new Float32Array(count);
    this.partSpd = new Float32Array(count);
    this.partU = new Float32Array(count);
    this.partV = new Float32Array(count);
    for (let p = 0; p < count; p++) {
      this.partPos[p * 2] = 1 + Math.random() * (N - 1);
      this.partPos[p * 2 + 1] = 1 + Math.random() * (N - 1);
      this.partLife[p] = Math.random();
    }
  }

  updateParticles(fluid, dt) {
    const N = this.N;
    for (let p = 0; p < this.partCount; p++) {
      let gi = this.partPos[p * 2], gj = this.partPos[p * 2 + 1];
      const [u, v] = fluid.sampleVelocity(gi, gj);
      const sp = Math.hypot(u, v);
      this.partSpd[p] = sp; this.partU[p] = u; this.partV[p] = v;
      gi += u * dt * N * 0.9; gj += v * dt * N * 0.9;
      this.partLife[p] -= dt * (0.25 + sp * 8);
      const solid = fluid.solid[Math.round(gi) + (N + 2) * Math.round(gj)];
      if (this.partLife[p] <= 0 || gi < 1 || gi > N || gj < 1 || gj > N || solid) {
        gi = 1 + Math.random() * (N - 1); gj = 1 + Math.random() * (N - 1);
        this.partLife[p] = 0.5 + Math.random() * 0.8;
      }
      this.partPos[p * 2] = gi; this.partPos[p * 2 + 1] = gj;
    }
  }

  updateHeat(Tfield, minT, maxT) {
    const N = this.N;
    const span = Math.max(0.01, maxT - minT);
    const d = this.heatImg.data;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const t = (Tfield[(i + 1) + (N + 2) * (j + 1)] - minT) / span;
        const [r, g, b] = heatColor(Math.max(0, Math.min(1, t)));
        const k = (i + j * N) * 4;
        d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 110;
      }
    }
    this.heatCtx.putImageData(this.heatImg, 0, 0);
  }

  createFan(gi, gj, angle) {
    const fan = { gi, gj, angle, power: 1, phase: 0, popT: 0 };
    this.fans.push(fan);
    return fan;
  }
  removeFan(fan) { this.fans = this.fans.filter((f) => f !== fan); }
  setFanAngle(fan, angle) { fan.angle = angle; }

  createFurniture(type, gi, gj) {
    const dims = {
      shelf:  { w: 1.4, d: 0.5, h: 5.5, color: 0xcfa87e },
      table:  { w: 1.6, d: 1.0, h: 2.6, color: 0xd9b48a },
      fridge: { w: 1.0, d: 0.9, h: 6.2, color: 0xeef2f6, heat: true },
      cabinet:{ w: 1.1, d: 0.6, h: 3.6, color: 0xcf9f7a },
    }[type] || { w: 1.1, d: 0.6, h: 3.6, color: 0xcf9f7a };
    const item = { type, gi, gj, w: dims.w, d: dims.d, hCells: dims.h, color: dims.color, heat: !!dims.heat, popT: 0 };
    this.furnitureItems.push(item);
    return item;
  }
  removeFurniture(item) { this.furnitureItems = this.furnitureItems.filter((f) => f !== item); }

  setCharacterGrid(gi, gj) { this.character.gi = gi; this.character.gj = gj; }
  setCharacterHot(h) { this.character.hot = h; }
  setWindowWall(wall) { this.windowWall = wall; }
  setWindowOpen(open) { this.windowOpen = open; }
  rotateView() { /* fixed isometric camera */ }

  setTimeOfDay(isDay, sun) { this.isDayNow = isDay; this.sun = Math.max(0, Math.min(1.4, sun)); }

  // --- picking --------------------------------------------------------------

  _cell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return this.fromScreen(clientX - rect.left, clientY - rect.top);
  }
  pickFloor(clientX, clientY) {
    const [u, v] = this._cell(clientX, clientY);
    if (u < 1 || u > this.N || v < 1 || v > this.N) return null;
    return [u, v];
  }
  _pickNearest(list, clientX, clientY, rad = 1.6) {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    let best = null, bestD = Infinity;
    for (const it of list) {
      const [sx, sy] = this.toScreen(it.gi, it.gj, this.unit * (it.hCells || 4) * 0.4);
      const dd = (sx - px) ** 2 + (sy - py) ** 2;
      const r = this.unit * (Math.max(it.w || 0.6, it.d || 0.6) * 8 * 0.5 + rad) * 2.2;
      if (dd < r * r && dd < bestD) { bestD = dd; best = it; }
    }
    return best;
  }
  pickFan(clientX, clientY) { return this._pickNearest(this.fans, clientX, clientY, 1.4); }
  pickFurniture(clientX, clientY) { return this._pickNearest(this.furnitureItems, clientX, clientY, 0.6); }

  // --- per-frame ------------------------------------------------------------

  update(dt, time) {
    this.time = time;
    for (const f of this.fans) { f.popT += (1 - f.popT) * Math.min(1, dt * 10); f.phase += dt * (3 + f.power * 24); }
    for (const it of this.furnitureItems) it.popT += (1 - it.popT) * Math.min(1, dt * 12);
    this.character.t = time;
  }

  render() {
    const ctx = this.ctx, N = this.N;
    ctx.clearRect(0, 0, this.W, this.H);
    this._drawSky(ctx);
    this._drawIsland(ctx);
    this._drawFloor(ctx);
    this._drawWalls(ctx);

    // depth-sorted props
    const props = [];
    for (const it of this.furnitureItems) props.push({ kind: 'furn', it, d: this.depthOf(it.gi, it.gj) });
    for (const f of this.fans) props.push({ kind: 'fan', it: f, d: this.depthOf(f.gi, f.gj) });
    props.push({ kind: 'char', it: this.character, d: this.depthOf(this.character.gi, this.character.gj) });
    props.sort((a, b) => a.d - b.d);
    for (const p of props) {
      if (p.kind === 'furn') this._drawFurniture(ctx, p.it);
      else if (p.kind === 'fan') this._drawFan(ctx, p.it);
      else this._drawCharacter(ctx, p.it);
    }

    this._drawParticles(ctx, 1.0);      // brighter streams over everything
    this._drawNight(ctx);
  }

  // --- drawing helpers ------------------------------------------------------

  _floorPath(ctx, inset = 0) {
    const a = 0.5 + inset, b = this.N + 0.5 - inset;
    const p1 = this.toScreen(a, a), p2 = this.toScreen(b, a);
    const p3 = this.toScreen(b, b), p4 = this.toScreen(a, b);
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
    ctx.lineTo(p3[0], p3[1]); ctx.lineTo(p4[0], p4[1]); ctx.closePath();
  }

  _drawSky(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    if (this.isDayNow) { g.addColorStop(0, PAL.sky1); g.addColorStop(1, PAL.sky2); }
    else { g.addColorStop(0, '#1f2748'); g.addColorStop(1, '#3a4570'); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, this.W, this.H);
  }

  _drawIsland(ctx) {
    const N = this.N;
    // soft water pool
    const cx = this.originX, cy = this.toScreen(this.c, this.c)[1];
    const rg = ctx.createRadialGradient(cx, cy + this.unit * N * 0.4, this.unit * 6, cx, cy + this.unit * N * 0.4, this.unit * N * 1.7);
    const water = this.isDayNow ? PAL.water : PAL.waterN;
    rg.addColorStop(0, shade(water, 1.06)); rg.addColorStop(1, shade(water, 0.82));
    ctx.fillStyle = rg; ctx.fillRect(0, 0, this.W, this.H);

    // island prism: floor diamond extruded downward
    const ext = this.unit * 5.5;
    const a = -1.0, b = N + 2.0;
    const c1 = this.toScreen(a, b), c2 = this.toScreen(b, b), c3 = this.toScreen(b, a);
    // left + right slabs
    ctx.fillStyle = shade(PAL.islandSide, this.isDayNow ? 0.9 : 0.55);
    ctx.beginPath();
    ctx.moveTo(c1[0], c1[1]); ctx.lineTo(c2[0], c2[1]);
    ctx.lineTo(c2[0], c2[1] + ext); ctx.lineTo(c1[0], c1[1] + ext); ctx.closePath(); ctx.fill();
    ctx.fillStyle = shade(PAL.islandDark, this.isDayNow ? 0.82 : 0.5);
    ctx.beginPath();
    ctx.moveTo(c2[0], c2[1]); ctx.lineTo(c3[0], c3[1]);
    ctx.lineTo(c3[0], c3[1] + ext); ctx.lineTo(c2[0], c2[1] + ext); ctx.closePath(); ctx.fill();
    // grassy top
    const t1 = this.toScreen(a, a), t2 = this.toScreen(b, a), t3 = this.toScreen(b, b), t4 = this.toScreen(a, b);
    ctx.fillStyle = shade(PAL.island, this.isDayNow ? 1 : 0.62);
    ctx.beginPath();
    ctx.moveTo(t1[0], t1[1]); ctx.lineTo(t2[0], t2[1]); ctx.lineTo(t3[0], t3[1]); ctx.lineTo(t4[0], t4[1]);
    ctx.closePath(); ctx.fill();
  }

  _drawFloor(ctx) {
    // base
    ctx.save();
    this._floorPath(ctx);
    ctx.fillStyle = shade(PAL.floor, this.isDayNow ? 1 : 0.64);
    ctx.fill();
    // heat overlay warped onto the floor rhombus via a linear transform
    this._floorPath(ctx); ctx.clip();
    const AX = this.AX, AY = this.AY, c = this.c, N = this.N;
    const e = this.originX + (0.5 - c) * (AX.x + AY.x);
    const f = this.originY + (0.5 - c) * (AX.y + AY.y);
    ctx.globalAlpha = this.isDayNow ? 0.85 : 0.6;
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(ctx.getTransform()); // keep dpr
    const cur = ctx.getTransform();
    ctx.transform(AX.x, AX.y, AY.x, AY.y, e, f);
    ctx.drawImage(this.heatCanvas, 0, 0, N, N);
    ctx.setTransform(cur);
    ctx.globalAlpha = 1;
    ctx.restore();

    // soft rug under the player
    const [rx, ry] = this.toScreen(this.character.gi - 1, this.character.gj + 1, 0.5);
    ctx.save();
    ctx.globalAlpha = this.isDayNow ? 0.5 : 0.32;
    ctx.fillStyle = shade(PAL.rug, this.isDayNow ? 1 : 0.7);
    ctx.beginPath();
    ctx.ellipse(this.toScreen(this.character.gi, this.character.gj)[0],
      this.toScreen(this.character.gi, this.character.gj)[1], this.unit * 11, this.unit * 5.5, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // faceNum / topNum are numeric colours; dim folds in day/night + which wall
  _wallQuad(ctx, ua, va, ub, vb, hpix, faceNum, topNum, dim) {
    const f1 = this.toScreen(ua, va), f2 = this.toScreen(ub, vb);
    const t1 = [f1[0], f1[1] - hpix], t2 = [f2[0], f2[1] - hpix];
    const y0 = Math.min(t1[1], t2[1]), y1 = Math.max(f1[1], f2[1]);
    // face with a soft vertical gradient (lighter at top = soft light)
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, shade(faceNum, dim * 1.08)); g.addColorStop(1, shade(faceNum, dim * 0.9));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(f1[0], f1[1]); ctx.lineTo(f2[0], f2[1]); ctx.lineTo(t2[0], t2[1]); ctx.lineTo(t1[0], t1[1]);
    ctx.closePath(); ctx.fill();
    // thin top cap
    ctx.fillStyle = shade(topNum, dim);
    ctx.beginPath();
    ctx.moveTo(t1[0], t1[1]); ctx.lineTo(t2[0], t2[1]);
    ctx.lineTo(t2[0], t2[1] - this.unit * 0.6); ctx.lineTo(t1[0], t1[1] - this.unit * 0.6);
    ctx.closePath(); ctx.fill();
    return { f1, f2 };
  }

  _drawWalls(ctx) {
    const N = this.N, H = this.unit * 7.0;
    const dim = this.isDayNow ? 1 : 0.62;
    // back wall: edge v = 0.5 (low j), spanning u
    this._wallQuad(ctx, 0.5, 0.5, N + 0.5, 0.5, H, PAL.wall, PAL.wallTop, dim * 0.98);
    // left wall: edge u = 0.5 (low i), spanning v — slightly darker (away from light)
    this._wallQuad(ctx, 0.5, 0.5, 0.5, N + 0.5, H, PAL.wall, PAL.wallTop, dim * 0.88);
    this._drawWindow(ctx, H);
  }

  _drawWindow(ctx, H) {
    const N = this.N;
    const a = this.winA ?? Math.floor(N * 0.34), b = this.winB ?? Math.floor(N * 0.66);
    const hLow = H * 0.32, hHigh = H * 0.82;
    let f1, f2;
    if (this.windowWall === 'left') { f1 = this.toScreen(0.5, a); f2 = this.toScreen(0.5, b); }
    else { f1 = this.toScreen(a, 0.5); f2 = this.toScreen(b, 0.5); }
    const corners = [
      [f1[0], f1[1] - hLow], [f2[0], f2[1] - hLow], [f2[0], f2[1] - hHigh], [f1[0], f1[1] - hHigh],
    ];
    // frame
    ctx.fillStyle = shade(PAL.frame, this.isDayNow ? 1 : 0.6);
    ctx.beginPath(); ctx.moveTo(corners[0][0], corners[0][1] + 4);
    ctx.lineTo(corners[1][0], corners[1][1] + 4); ctx.lineTo(corners[2][0], corners[2][1] - 4);
    ctx.lineTo(corners[3][0], corners[3][1] - 4); ctx.closePath(); ctx.fill();
    // glass — glows warm in daylight, deep blue at night; brighter when open
    const g = ctx.createLinearGradient(0, corners[2][1], 0, corners[0][1]);
    if (this.isDayNow) {
      g.addColorStop(0, shade(0xfff0c2, 1)); g.addColorStop(1, shade(PAL.glass, 1.05 + this.sun * 0.1));
    } else { g.addColorStop(0, '#3b4a86'); g.addColorStop(1, '#26305e'); }
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath(); ctx.fill();
    if (!this.windowOpen) { // curtain hint
      ctx.globalAlpha = 0.45; ctx.fillStyle = '#f3ede0'; ctx.fill(); ctx.globalAlpha = 1;
    }
  }

  _contactShadow(ctx, gi, gj, rx, ry) {
    const [x, y] = this.toScreen(gi, gj);
    const g = ctx.createRadialGradient(x, y, 1, x, y, rx);
    g.addColorStop(0, 'rgba(40,30,55,0.30)'); g.addColorStop(1, 'rgba(40,30,55,0)');
    ctx.fillStyle = g;
    ctx.save(); ctx.translate(x, y); ctx.scale(1, ry / rx);
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, TAU); ctx.fill(); ctx.restore();
  }

  // a soft rounded iso box centred at (gi,gj) with grid half-extents, height px
  _isoBox(ctx, gi, gj, hu, hv, hpix, color, pop = 1) {
    hu *= pop; hv *= pop; hpix *= pop;
    const b1 = this.toScreen(gi - hu, gj - hv), b2 = this.toScreen(gi + hu, gj - hv);
    const b3 = this.toScreen(gi + hu, gj + hv), b4 = this.toScreen(gi - hu, gj + hv);
    const top = (p) => [p[0], p[1] - hpix];
    const t1 = top(b1), t2 = top(b2), t3 = top(b3), t4 = top(b4);
    const dim = this.isDayNow ? 1 : 0.66;
    // right face (b2-b3)
    ctx.fillStyle = shade(color, dim * 0.82);
    quad(ctx, b2, b3, t3, t2);
    // left face (b3-b4) toward camera-left, a touch darker for AO
    ctx.fillStyle = shade(color, dim * 0.72);
    quad(ctx, b3, b4, t4, t3);
    // top face, lightest
    ctx.fillStyle = shade(color, dim * 1.08);
    quad(ctx, t1, t2, t3, t4);
    // soft top highlight
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    quad(ctx, t1, t2, mid(t2, t3, 0.5), mid(t1, t4, 0.5));
    return { t1, t2, t3, t4 };
  }

  _drawFurniture(ctx, it) {
    const cpu = this.N / this.roomSize; // cells per world unit
    const hu = (it.w * cpu) / 2, hv = (it.d * cpu) / 2;
    this._contactShadow(ctx, it.gi, it.gj, this.unit * Math.max(hu, hv) * 1.5, this.unit * Math.max(hu, hv) * 0.8);
    const pop = Math.max(0.02, it.popT);
    const top = this._isoBox(ctx, it.gi, it.gj, hu, hv, this.unit * it.hCells, it.color, pop);
    if (it.heat) { // glowing element on appliances
      ctx.fillStyle = 'rgba(255,140,90,0.8)';
      const c = mid(top.t1, top.t3, 0.5);
      ctx.beginPath(); ctx.arc(c[0], c[1] + this.unit * 1.2, this.unit * 0.9, 0, TAU); ctx.fill();
    }
  }

  _drawFan(ctx, fan) {
    const pop = Math.max(0.02, fan.popT);
    this._contactShadow(ctx, fan.gi, fan.gj, this.unit * 3.2, this.unit * 1.7);
    // direction puff on the floor
    const dx = Math.sin(fan.angle), dz = Math.cos(fan.angle);
    const tip = this.toScreen(fan.gi + dx * 5, fan.gj + dz * 5);
    const base = this.toScreen(fan.gi, fan.gj);
    ctx.strokeStyle = 'rgba(120,180,255,0.45)'; ctx.lineWidth = this.unit * 0.5;
    ctx.beginPath(); ctx.moveTo(base[0], base[1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke();
    // pole + head
    const stand = this.toScreen(fan.gi, fan.gj);
    const headH = this.unit * 5.2 * pop;
    const head = [stand[0], stand[1] - headH];
    ctx.strokeStyle = shade(0xaab4d6, this.isDayNow ? 1 : 0.7); ctx.lineWidth = this.unit * 0.55;
    ctx.beginPath(); ctx.moveTo(stand[0], stand[1]); ctx.lineTo(head[0], head[1]); ctx.stroke();
    // base disc
    ctx.fillStyle = shade(0x9aa3c4, this.isDayNow ? 1 : 0.7);
    ctx.save(); ctx.translate(stand[0], stand[1]); ctx.scale(1, 0.5);
    ctx.beginPath(); ctx.arc(0, 0, this.unit * 1.6 * pop, 0, TAU); ctx.fill(); ctx.restore();
    // head ring + blades
    const R = this.unit * 2.3 * pop;
    ctx.fillStyle = shade(0xc8d0ea, this.isDayNow ? 1 : 0.7);
    ctx.beginPath(); ctx.arc(head[0], head[1], R, 0, TAU); ctx.fill();
    ctx.fillStyle = shade(0xeef4ff, this.isDayNow ? 1 : 0.72);
    for (let b = 0; b < 4; b++) {
      const ang = fan.phase + (b / 4) * TAU;
      ctx.beginPath();
      ctx.moveTo(head[0], head[1]);
      ctx.arc(head[0], head[1], R * 0.86, ang, ang + 0.5);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = shade(0xffd06e, this.isDayNow ? 1 : 0.8);
    ctx.beginPath(); ctx.arc(head[0], head[1], R * 0.18, 0, TAU); ctx.fill();
  }

  _drawCharacter(ctx, ch) {
    const bob = Math.sin(ch.t * 2) * this.unit * 0.3;
    this._contactShadow(ctx, ch.gi, ch.gj, this.unit * 2.6, this.unit * 1.4);
    const base = this.toScreen(ch.gi, ch.gj);
    base[1] += bob;
    // body (rounded)
    const bodyTop = base[1] - this.unit * 4.4;
    const grad = ctx.createLinearGradient(0, bodyTop, 0, base[1]);
    grad.addColorStop(0, shade(PAL.bodyA, this.isDayNow ? 1.05 : 0.72));
    grad.addColorStop(1, shade(PAL.bodyB, this.isDayNow ? 1 : 0.66));
    ctx.fillStyle = grad;
    roundedCapsule(ctx, base[0], base[1] - this.unit * 1.4, this.unit * 1.9, this.unit * 3.4);
    // head
    const hy = base[1] - this.unit * 5.4;
    const skin = lerpHex(PAL.skin, PAL.skinHot, Math.max(0, Math.min(1, ch.hot)));
    ctx.fillStyle = shade(skin, this.isDayNow ? 1 : 0.7);
    ctx.beginPath(); ctx.arc(base[0], hy, this.unit * 1.9, 0, TAU); ctx.fill();
    // sweat
    if (ch.hot > 0.45) {
      ctx.fillStyle = 'rgba(120,200,255,0.95)';
      ctx.beginPath(); ctx.arc(base[0] + this.unit * 1.5, hy + Math.sin(ch.t * 4) * 2, this.unit * 0.45, 0, TAU); ctx.fill();
    }
  }

  _drawParticles(ctx, gain) {
    if (!this.partCount) return;
    const N = this.N;
    ctx.lineCap = 'round';
    const col = this.isDayNow ? '255,255,255' : '205,228,255';
    for (let p = 0; p < this.partCount; p++) {
      const sp = this.partSpd[p];
      let b = sp * 40 - 0.9;                     // only moving air shows
      if (b <= 0) continue;
      b = Math.min(1, b) * Math.min(1, this.partLife[p] * 2.2) * gain;
      if (b <= 0.05) continue;
      const gi = this.partPos[p * 2], gj = this.partPos[p * 2 + 1];
      const lift = Math.min(1.2, sp * 30) * this.unit * 1.2;
      // draw a short streak along the local flow direction = a wind trail
      const tail = Math.min(3.5, sp * 90);
      const [x2, y2] = this.toScreen(gi, gj, lift);
      const [x1, y1] = this.toScreen(gi - this.partU[p] / sp * tail, gj - this.partV[p] / sp * tail, lift);
      ctx.strokeStyle = `rgba(${col},${b * 0.65})`;
      ctx.lineWidth = this.unit * 0.42;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
  }

  _drawNight(ctx) {
    let a = this.isDayNow ? Math.max(0, (1 - this.sun)) * 0.10 : 0.40;
    if (a <= 0) return;
    ctx.fillStyle = `rgba(${PAL.nightTint},${a})`;
    ctx.fillRect(0, 0, this.W, this.H);
  }
}

// --- small geometry helpers -------------------------------------------------
function quad(ctx, a, b, c, d) {
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath(); ctx.fill();
}
function mid(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
function roundedCapsule(ctx, cx, cy, rx, h) {
  ctx.beginPath();
  ctx.moveTo(cx - rx, cy);
  ctx.lineTo(cx - rx, cy - h + rx);
  ctx.quadraticCurveTo(cx - rx, cy - h, cx, cy - h);
  ctx.quadraticCurveTo(cx + rx, cy - h, cx + rx, cy - h + rx);
  ctx.lineTo(cx + rx, cy);
  ctx.quadraticCurveTo(cx + rx, cy + rx, cx, cy + rx);
  ctx.quadraticCurveTo(cx - rx, cy + rx, cx - rx, cy);
  ctx.closePath(); ctx.fill();
}
function lerpHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((ar + (br - ar) * t) << 16 | (ag + (bg - ag) * t) << 8 | (ab + (bb - ab) * t)) & 0xffffff;
}

function heatColor(t) {
  const stops = [
    [0.0, [120, 170, 235]], [0.35, [130, 210, 205]], [0.55, [165, 220, 150]],
    [0.75, [245, 210, 120]], [1.0, [240, 120, 105]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (t <= b) { const f = (t - a) / (b - a); return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f]; }
  }
  return stops[stops.length - 1][1];
}
