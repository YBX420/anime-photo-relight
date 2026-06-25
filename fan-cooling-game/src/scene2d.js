// scene2d.js
// FLAT 2D side-on illustration ("2D 作画"): a storybook cross-section of a room.
// Floor at the bottom, ceiling on top, walls at the sides, a window in one side
// wall looking out to the sky. Everything is drawn as flat front-facing shapes
// with clean soft outlines and at most two tones — no 3D face shading.
//
// The CFD grid (src/fluid.js) is reused as a VERTICAL slice: gi = x across the
// room, gj = height (1 = floor, N = ceiling). game.js adds buoyancy so warm air
// rises and cool window air sinks — convection you can actually see.

const TAU = Math.PI * 2;

const PAL = {
  skyD1: '#a9def9', skyD2: '#eaf8ff',
  skyN1: '#1d2547', skyN2: '#3a4570',
  ground: '#bfe0a8', groundN: '#5e6f86',
  house: '#f3e7d0', houseLine: '#e6d4b3',
  wall: '#efe3c9', wallShade: '#e6d8ba',
  ceiling: '#f5eedd',
  floor: '#e7c79a', floorDark: '#d8b07f', skirting: '#cBa982',
  frame: '#c9b291',
  sofa: '#e89a7c', sofaD: '#d9836a', sofaCush: '#f3b89c',
  shelf: '#caa87e', shelfD: '#b08a5f', book1: '#e08a6e', book2: '#7fb8a8', book3: '#e6c06a',
  table: '#d8b388', tableD: '#bb9265',
  fridge: '#eef2f6', fridgeD: '#d7dee6',
  cabinet: '#cf9f7a', cabinetD: '#b07f5c',
  plantPot: '#d98c63', plant: '#86b97f',
  body: '#8cb6e6', bodyD: '#6f9eda', skin: '#ffdcbb', skinHot: '#ff9d88', hair: '#5b4636',
  fan: '#aab4d6', fanD: '#8c97bf', blade: '#dfeaff', hub: '#ffd06e',
  outline: 'rgba(74,58,52,0.55)',
};

function shade(hex, f) {
  const n = typeof hex === 'number' ? hex : parseInt(hex.replace('#', ''), 16);
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
    this.character = { gi: 44, gj: 6, hot: 0, t: 0 };
    this.windowWall = 'left';
    this.windowOpen = true;
    this.winA = Math.floor(this.N * 0.42);
    this.winB = Math.floor(this.N * 0.80);
    this.isDayNow = true;
    this.sun = 1;

    this.heatCanvas = document.createElement('canvas');
    this.heatCanvas.width = this.N; this.heatCanvas.height = this.N;
    this.heatCtx = this.heatCanvas.getContext('2d');
    this.heatImg = this.heatCtx.createImageData(this.N, this.N);

    this.resize();
  }

  // --- layout / projection (front elevation, no skew) -----------------------
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.W = w; this.H = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.roomW = Math.min(w * 0.66, (h * 0.62) / 0.62);
    this.roomH = this.roomW * 0.62;
    this.ox = (w - this.roomW) / 2;             // interior left
    this.ceilY = (h - this.roomH) / 2 - h * 0.02;
    this.floorY = this.ceilY + this.roomH;      // interior bottom
    this.unit = this.roomW / this.N;            // px per grid cell (x)
    this.unitY = this.roomH / this.N;           // px per grid cell (height)
    this.wt = this.roomW * 0.045;               // wall thickness
  }

  toScreen(gi, gj) {
    return [this.ox + (gi - 0.5) / this.N * this.roomW,
            this.floorY - (gj - 0.5) / this.N * this.roomH];
  }
  fromScreen(px, py) {
    return [(px - this.ox) / this.roomW * this.N + 0.5,
            (this.floorY - py) / this.roomH * this.N + 0.5];
  }

  // --- mutators (same API as before) ---------------------------------------
  initParticles(count = 900) {
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
    const N = this.N, span = Math.max(0.01, maxT - minT), d = this.heatImg.data;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const t = Math.max(0, Math.min(1, (Tfield[(i + 1) + (N + 2) * (j + 1)] - minT) / span));
      const [r, g, b] = heatColor(t);
      const k = (i + j * N) * 4;
      d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 14 + 120 * Math.abs(t - 0.5);
    }
    this.heatCtx.putImageData(this.heatImg, 0, 0);
  }

  createFan(gi, gj, angle) { const f = { gi, gj, angle, power: 1, phase: 0, popT: 0 }; this.fans.push(f); return f; }
  removeFan(fan) { this.fans = this.fans.filter((f) => f !== fan); }
  setFanAngle(fan, angle) { fan.angle = angle; }

  createFurniture(type, gi, gj) {
    const dims = {
      shelf:   { w: 1.3, hCells: 16, color: PAL.shelf },
      table:   { w: 1.7, hCells: 8,  color: PAL.table },
      cabinet: { w: 1.2, hCells: 11, color: PAL.cabinet },
      fridge:  { w: 1.1, hCells: 20, color: PAL.fridge, heat: true },
    }[type] || { w: 1.2, hCells: 11, color: PAL.cabinet };
    const item = { type, gi, gj, w: dims.w, d: dims.w, hCells: dims.hCells, color: dims.color, heat: !!dims.heat, popT: 0 };
    this.furnitureItems.push(item);
    return item;
  }
  removeFurniture(item) { this.furnitureItems = this.furnitureItems.filter((f) => f !== item); }

  setCharacterGrid(gi, gj) { this.character.gi = gi; this.character.gj = gj; }
  setCharacterHot(h) { this.character.hot = h; }
  setWindowWall(wall) { this.windowWall = wall; }
  setWindowOpen(open) { this.windowOpen = open; }
  rotateView() {}
  setTimeOfDay(isDay, sun) { this.isDayNow = isDay; this.sun = Math.max(0, Math.min(1.4, sun)); }

  // --- picking --------------------------------------------------------------
  _cell(cx, cy) { const r = this.canvas.getBoundingClientRect(); return this.fromScreen(cx - r.left, cy - r.top); }
  pickFloor(cx, cy) {
    const [u, v] = this._cell(cx, cy);
    if (u < 1 || u > this.N || v < 1 || v > this.N) return null;
    return [u, v];
  }
  _nearest(list, cx, cy, radCells) {
    const r = this.canvas.getBoundingClientRect(); const px = cx - r.left, py = cy - r.top;
    let best = null, bd = Infinity;
    for (const it of list) {
      const [sx, sy] = this.toScreen(it.gi, (it.hCells || 8) * 0.5);
      const dd = (sx - px) ** 2 + (sy - py) ** 2;
      const rr = this.unit * ((it.w || 1) * 8 * 0.5 + radCells);
      if (dd < rr * rr && dd < bd) { bd = dd; best = it; }
    }
    return best;
  }
  pickFan(cx, cy) { return this._nearest(this.fans, cx, cy, 3); }
  pickFurniture(cx, cy) { return this._nearest(this.furnitureItems, cx, cy, 1); }

  // --- per-frame ------------------------------------------------------------
  update(dt, time) {
    this.time = time;
    for (const f of this.fans) { f.popT += (1 - f.popT) * Math.min(1, dt * 10); f.phase += dt * (3 + f.power * 22); }
    for (const it of this.furnitureItems) it.popT += (1 - it.popT) * Math.min(1, dt * 12);
    this.character.t = time;
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    this._drawSky(ctx);
    this._drawHouse(ctx);
    this._drawInteriorClip(ctx, () => {
      this._drawRoomSurfaces(ctx);
      this._drawHeat(ctx);
      this._drawParticles(ctx, 0.5);
      // props on the floor
      const sorted = [...this.furnitureItems].sort((a, b) => a.gi - b.gi);
      for (const it of sorted) this._drawFurniture(ctx, it);
      for (const f of this.fans) this._drawFan(ctx, f);
      this._drawCharacter(ctx, this.character);
      this._drawParticles(ctx, 1.0);
    });
    this._drawWindowFrame(ctx);
    this._drawNight(ctx);
    this._vignette(ctx);
  }

  // --- backgrounds ----------------------------------------------------------
  _drawSky(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    if (this.isDayNow) { g.addColorStop(0, PAL.skyD1); g.addColorStop(1, PAL.skyD2); }
    else { g.addColorStop(0, PAL.skyN1); g.addColorStop(1, PAL.skyN2); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, this.W, this.H);
    // sun / moon
    const sx = this.W * 0.16, sy = this.H * (this.isDayNow ? 0.2 : 0.18);
    ctx.fillStyle = this.isDayNow ? 'rgba(255,236,170,0.95)' : 'rgba(232,238,255,0.9)';
    ctx.beginPath(); ctx.arc(sx, sy, this.W * 0.035, 0, TAU); ctx.fill();
    // soft clouds (day)
    if (this.isDayNow) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      for (const [cx, cy, s] of [[0.72, 0.16, 1], [0.5, 0.28, 0.7], [0.85, 0.32, 0.8]]) cloud(ctx, this.W * cx, this.H * cy, this.W * 0.05 * s);
    }
    // ground outside
    ctx.fillStyle = this.isDayNow ? PAL.ground : PAL.groundN;
    ctx.fillRect(0, this.floorY + this.wt, this.W, this.H);
  }

  _drawHouse(ctx) {
    // structure: a rounded cream block enclosing the interior (walls)
    const x = this.ox - this.wt, y = this.ceilY - this.wt;
    const w = this.roomW + this.wt * 2, h = this.roomH + this.wt * 2;
    ctx.fillStyle = PAL.house;
    rr(ctx, x, y, w, h, this.wt * 1.4); ctx.fill();
    ctx.strokeStyle = PAL.houseLine; ctx.lineWidth = 2; ctx.stroke();
    // a little pitched roof for cozy storybook feel
    ctx.fillStyle = shade(PAL.house, 0.92);
    ctx.beginPath();
    ctx.moveTo(x - this.wt * 0.5, y + 2);
    ctx.lineTo(this.ox + this.roomW / 2, y - this.roomH * 0.18);
    ctx.lineTo(x + w + this.wt * 0.5, y + 2);
    ctx.closePath(); ctx.fill();
  }

  _drawInteriorClip(ctx, draw) {
    ctx.save();
    rr(ctx, this.ox, this.ceilY, this.roomW, this.roomH, this.wt * 0.4); ctx.clip();
    draw();
    ctx.restore();
  }

  _drawRoomSurfaces(ctx) {
    // back wall
    ctx.fillStyle = PAL.wall; ctx.fillRect(this.ox, this.ceilY, this.roomW, this.roomH);
    // ceiling band
    ctx.fillStyle = PAL.ceiling; ctx.fillRect(this.ox, this.ceilY, this.roomW, this.roomH * 0.06);
    // floor
    const fh = this.roomH * 0.1;
    ctx.fillStyle = PAL.floor; ctx.fillRect(this.ox, this.floorY - fh, this.roomW, fh);
    ctx.fillStyle = shade(PAL.floorDark, 1); ctx.fillRect(this.ox, this.floorY - fh, this.roomW, this.roomH * 0.012);
    // faint floorboards
    ctx.strokeStyle = 'rgba(150,110,70,0.18)'; ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) { const x = this.ox + (i / 8) * this.roomW; ctx.beginPath(); ctx.moveTo(x, this.floorY - fh); ctx.lineTo(x, this.floorY); ctx.stroke(); }
  }

  _drawHeat(ctx) {
    ctx.save();
    ctx.globalAlpha = this.isDayNow ? 0.6 : 0.45;
    ctx.imageSmoothingEnabled = true;
    ctx.translate(this.ox, this.floorY); ctx.scale(this.roomW / this.N, -this.roomH / this.N);
    ctx.drawImage(this.heatCanvas, 0, 0, this.N, this.N);
    ctx.restore();
  }

  _drawWindowFrame(ctx) {
    // a sky cut-out in the chosen side wall
    const left = this.windowWall === 'left';
    const wx = left ? this.ox - this.wt * 0.5 : this.ox + this.roomW - this.wt * 0.5;
    const [, yTop] = this.toScreen(0, this.winB);
    const [, yBot] = this.toScreen(0, this.winA);
    const ww = this.wt * 1.3, x = wx - (left ? this.wt * 0.4 : -this.wt * 0.4) - ww / 2 + this.wt * 0.5;
    const winX = left ? this.ox - this.wt : this.ox + this.roomW - this.wt * 0.3;
    const wWidth = this.wt * 1.3;
    // glass = sky
    const g = ctx.createLinearGradient(0, yTop, 0, yBot);
    if (this.isDayNow) { g.addColorStop(0, PAL.skyD1); g.addColorStop(1, '#dff3ff'); }
    else { g.addColorStop(0, '#2a3563'); g.addColorStop(1, '#3c4878'); }
    ctx.fillStyle = g;
    rr(ctx, winX, yTop, wWidth, yBot - yTop, 6); ctx.fill();
    if (this.isDayNow && this.windowOpen) { // sun glow through glass
      ctx.fillStyle = 'rgba(255,240,190,0.5)';
      rr(ctx, winX, yTop, wWidth, (yBot - yTop) * 0.5, 6); ctx.fill();
    }
    // frame
    ctx.strokeStyle = PAL.frame; ctx.lineWidth = this.wt * 0.28;
    rr(ctx, winX, yTop, wWidth, yBot - yTop, 6); ctx.stroke();
    ctx.lineWidth = this.wt * 0.14;
    ctx.beginPath(); ctx.moveTo(winX, (yTop + yBot) / 2); ctx.lineTo(winX + wWidth, (yTop + yBot) / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(winX + wWidth / 2, yTop); ctx.lineTo(winX + wWidth / 2, yBot); ctx.stroke();
    if (!this.windowOpen) { ctx.fillStyle = 'rgba(243,237,224,0.6)'; rr(ctx, winX, yTop, wWidth, yBot - yTop, 6); ctx.fill(); }
  }

  // --- flat illustrated props ----------------------------------------------
  _shadow(ctx, gx, w) {
    const [x] = this.toScreen(gx, 1);
    const g = ctx.createRadialGradient(x, this.floorY - this.roomH * 0.02, 1, x, this.floorY - this.roomH * 0.02, w);
    g.addColorStop(0, 'rgba(60,45,40,0.22)'); g.addColorStop(1, 'rgba(60,45,40,0)');
    ctx.fillStyle = g;
    ctx.save(); ctx.translate(x, this.floorY - this.roomH * 0.02); ctx.scale(1, 0.3);
    ctx.beginPath(); ctx.arc(0, 0, w, 0, TAU); ctx.fill(); ctx.restore();
  }
  _stroke(ctx) { ctx.strokeStyle = PAL.outline; ctx.lineWidth = Math.max(1.4, this.unit * 0.5); ctx.lineJoin = 'round'; ctx.stroke(); }

  _drawFurniture(ctx, it) {
    const pop = Math.max(0.02, it.popT);
    const halfW = it.w * (this.N / this.roomSize) / 2 * this.unit;
    const [cx] = this.toScreen(it.gi, 1);
    const baseY = this.floorY - this.roomH * 0.018;
    const hgt = it.hCells * this.unitY * pop;
    const x = cx - halfW, y = baseY - hgt, w2 = halfW * 2;
    this._shadow(ctx, it.gi, halfW * 1.25);
    const dim = this.isDayNow ? 1 : 0.7;
    const r = Math.min(w2, hgt) * 0.16;
    if (it.type === 'shelf' || it.type === 'cabinet') {
      ctx.fillStyle = shade(it.color, dim); rr(ctx, x, y, w2, hgt, r); ctx.fill(); this._stroke(ctx);
      // shelves + books
      const rows = it.type === 'shelf' ? 3 : 2;
      for (let s = 1; s <= rows; s++) {
        const sy = y + (hgt * s) / (rows + 1);
        ctx.strokeStyle = shade(it.color, dim * 0.8); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x + r, sy); ctx.lineTo(x + w2 - r, sy); ctx.stroke();
        if (it.type === 'shelf') {
          const cols = [PAL.book1, PAL.book2, PAL.book3];
          for (let bk = 0; bk < 4; bk++) {
            ctx.fillStyle = shade(cols[(bk + s) % 3], dim);
            rr(ctx, x + r + bk * (w2 - 2 * r) / 4 + 2, sy - hgt * 0.13, (w2 - 2 * r) / 4 - 4, hgt * 0.12, 2); ctx.fill();
          }
        }
      }
    } else if (it.type === 'table') {
      ctx.fillStyle = shade(it.color, dim);
      rr(ctx, x, y, w2, hgt * 0.22, r); ctx.fill(); this._stroke(ctx);
      ctx.fillStyle = shade(it.color, dim * 0.85);
      rr(ctx, x + w2 * 0.08, y + hgt * 0.2, w2 * 0.1, hgt * 0.8, 3); ctx.fill();
      rr(ctx, x + w2 * 0.82, y + hgt * 0.2, w2 * 0.1, hgt * 0.8, 3); ctx.fill();
    } else { // fridge
      ctx.fillStyle = shade(it.color, dim); rr(ctx, x, y, w2, hgt, r); ctx.fill(); this._stroke(ctx);
      ctx.strokeStyle = shade(it.color, dim * 0.8); ctx.lineWidth = 2;
      const my = y + hgt * 0.36; ctx.beginPath(); ctx.moveTo(x + r, my); ctx.lineTo(x + w2 - r, my); ctx.stroke();
      ctx.fillStyle = shade(0xb9c2cc, dim);
      rr(ctx, x + w2 * 0.74, y + hgt * 0.1, w2 * 0.08, hgt * 0.18, 3); ctx.fill();
      rr(ctx, x + w2 * 0.74, y + hgt * 0.46, w2 * 0.08, hgt * 0.3, 3); ctx.fill();
      ctx.fillStyle = 'rgba(255,150,100,0.85)';
      ctx.beginPath(); ctx.arc(x + w2 * 0.3, my - 6, 4, 0, TAU); ctx.fill();
    }
  }

  _drawFan(ctx, fan) {
    const pop = Math.max(0.02, fan.popT);
    const [cx] = this.toScreen(fan.gi, 1);
    const floor = this.floorY - this.roomH * 0.018;
    const dim = this.isDayNow ? 1 : 0.72;
    this._shadow(ctx, fan.gi, this.unit * 3);
    const poleH = this.roomH * 0.2 * pop;
    const headY = floor - poleH;
    const R = this.roomW * 0.05 * pop;
    // direction arrow on the floor
    const dir = Math.sin(fan.angle) >= 0 ? 1 : -1;
    ctx.strokeStyle = 'rgba(120,180,255,0.5)'; ctx.lineWidth = this.unit * 0.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, headY); ctx.lineTo(cx + dir * R * 2.4, headY); ctx.stroke();
    // base
    ctx.fillStyle = shade(PAL.fanD, dim);
    rr(ctx, cx - R * 0.7, floor - this.roomH * 0.02, R * 1.4, this.roomH * 0.025, 4); ctx.fill();
    // pole
    ctx.strokeStyle = shade(PAL.fan, dim); ctx.lineWidth = this.unit * 0.7;
    ctx.beginPath(); ctx.moveTo(cx, floor); ctx.lineTo(cx, headY); ctx.stroke();
    // guard ring
    ctx.fillStyle = shade(PAL.fan, dim * 1.05);
    ctx.beginPath(); ctx.arc(cx, headY, R, 0, TAU); ctx.fill();
    this._strokeCircle(ctx, cx, headY, R);
    // blades (spinning) drawn as soft petals
    ctx.fillStyle = shade(PAL.blade, dim);
    for (let b = 0; b < 4; b++) {
      const a = fan.phase + (b / 4) * TAU;
      ctx.save(); ctx.translate(cx, headY); ctx.rotate(a);
      ctx.beginPath(); ctx.ellipse(R * 0.42, 0, R * 0.42, R * 0.2, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = shade(PAL.hub, dim);
    ctx.beginPath(); ctx.arc(cx, headY, R * 0.16, 0, TAU); ctx.fill();
  }

  _drawCharacter(ctx, ch) {
    const [cx] = this.toScreen(ch.gi, 1);
    const floor = this.floorY - this.roomH * 0.018;
    const bob = Math.sin(ch.t * 2) * 1.5;
    const dim = this.isDayNow ? 1 : 0.74;
    const scale = this.roomH;
    this._shadow(ctx, ch.gi, this.unit * 2.6);
    // legs
    ctx.fillStyle = shade(PAL.bodyD, dim);
    rr(ctx, cx - scale * 0.035, floor - scale * 0.11, scale * 0.03, scale * 0.11, 3); ctx.fill();
    rr(ctx, cx + scale * 0.005, floor - scale * 0.11, scale * 0.03, scale * 0.11, 3); ctx.fill();
    // body
    ctx.fillStyle = shade(PAL.body, dim);
    rr(ctx, cx - scale * 0.05, floor - scale * 0.26 + bob, scale * 0.1, scale * 0.17, scale * 0.04); ctx.fill(); this._stroke(ctx);
    // head
    const hy = floor - scale * 0.31 + bob;
    ctx.fillStyle = shade(lerpHexCss(PAL.skin, PAL.skinHot, Math.max(0, Math.min(1, ch.hot))), dim);
    ctx.beginPath(); ctx.arc(cx, hy, scale * 0.055, 0, TAU); ctx.fill(); this._strokeCircle(ctx, cx, hy, scale * 0.055);
    // hair + eyes
    ctx.fillStyle = shade(PAL.hair, dim);
    ctx.beginPath(); ctx.arc(cx, hy - scale * 0.012, scale * 0.056, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
    ctx.fillStyle = '#4a3b34';
    ctx.beginPath(); ctx.arc(cx - scale * 0.018, hy + scale * 0.005, 2, 0, TAU); ctx.arc(cx + scale * 0.018, hy + scale * 0.005, 2, 0, TAU); ctx.fill();
    // sweat
    if (ch.hot > 0.45) {
      ctx.fillStyle = 'rgba(120,200,255,0.95)';
      ctx.beginPath(); ctx.arc(cx + scale * 0.05, hy + Math.sin(ch.t * 4) * 2, 3, 0, TAU); ctx.fill();
    }
  }

  _strokeCircle(ctx, x, y, r) { ctx.strokeStyle = PAL.outline; ctx.lineWidth = Math.max(1.4, this.unit * 0.5); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke(); }

  _drawParticles(ctx, gain) {
    if (!this.partCount) return;
    ctx.lineCap = 'round';
    const col = this.isDayNow ? '255,255,255' : '205,228,255';
    for (let p = 0; p < this.partCount; p++) {
      const sp = this.partSpd[p];
      let b = sp * 40 - 0.9; if (b <= 0) continue;
      b = Math.min(1, b) * Math.min(1, this.partLife[p] * 2.2) * gain;
      if (b <= 0.05) continue;
      const gi = this.partPos[p * 2], gj = this.partPos[p * 2 + 1];
      const tail = Math.min(3.5, sp * 90);
      const [x2, y2] = this.toScreen(gi, gj);
      const [x1, y1] = this.toScreen(gi - this.partU[p] / sp * tail, gj - this.partV[p] / sp * tail);
      ctx.strokeStyle = `rgba(${col},${b * 0.4})`; ctx.lineWidth = this.unit * 0.3;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
  }

  _drawNight(ctx) {
    let a = this.isDayNow ? Math.max(0, 1 - this.sun) * 0.08 : 0.34;
    if (a <= 0) return;
    ctx.fillStyle = `rgba(24,30,64,${a})`; ctx.fillRect(0, 0, this.W, this.H);
  }
  _vignette(ctx) {
    const g = ctx.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.3, this.W / 2, this.H / 2, this.H * 0.8);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(30,20,40,0.16)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, this.W, this.H);
  }
}

// --- helpers ----------------------------------------------------------------
function rr(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function cloud(ctx, x, y, s) {
  ctx.beginPath();
  ctx.arc(x, y, s, 0, TAU); ctx.arc(x + s, y + s * 0.2, s * 0.8, 0, TAU);
  ctx.arc(x - s, y + s * 0.2, s * 0.7, 0, TAU); ctx.arc(x + s * 0.4, y - s * 0.4, s * 0.6, 0, TAU);
  ctx.fill();
}
function lerpHexCss(a, b, t) {
  const pa = parseInt(a.replace('#', ''), 16), pb = parseInt(b.replace('#', ''), 16);
  const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
  const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
  return `rgb(${(ar + (br - ar) * t) | 0},${(ag + (bg - ag) * t) | 0},${(ab + (bb - ab) * t) | 0})`;
}
function heatColor(t) {
  const stops = [[0, [120, 170, 235]], [0.35, [130, 210, 205]], [0.55, [165, 220, 150]], [0.75, [245, 210, 120]], [1, [240, 120, 105]]];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (t <= b) { const f = (t - a) / (b - a); return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f]; }
  }
  return stops[stops.length - 1][1];
}
