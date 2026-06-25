// scene2d.js
// A 2D isometric renderer in a hand-drawn LINE-ART style: flat light fills with
// bold, consistent ink outlines and edge lines defining every form (no 3D-style
// soft shading or gradients). The CFD grid maps onto the isometric floor by one
// linear transform. Same public API as before, so game.js / ui.js are untouched.

const TAU = Math.PI * 2;

// flat, light line-art palette — warm storybook, fills kept pale so the ink reads
const PAL = {
  paper: '#fdf6ea', paperN: '#222a48',
  water: '#cce9e2', waterN: '#557a88',
  island: '#f1ddb8', islandSide: '#e9cf9d',
  floor: '#faeed8', rug: '#f3cbb0',
  wall: '#fbf3e5', wallSide: '#f3e9d2',
  glass: '#d8eff3', frame: '#f0e7d4',
  shelf: '#ebcfa9', table: '#f0d6a9', fridge: '#f1f4f6', cabinet: '#ebc7a3',
  body: '#aed0ef', skin: '#ffe3c8', hub: '#ffdf9c', blade: '#eef3ff', fan: '#cbd2e8',
  plant: '#9bc090', pot: '#dd9b73', picture: '#ecd49a',
  ink: '#534145',
};

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

    this.heatCanvas = document.createElement('canvas');
    this.heatCanvas.width = this.N; this.heatCanvas.height = this.N;
    this.heatCtx = this.heatCanvas.getContext('2d');
    this.heatImg = this.heatCtx.createImageData(this.N, this.N);

    this._makePaper();
    this.resize();
  }

  // a small static grain tile used as a faint paper texture (generated once)
  _makePaper() {
    const s = 140, cv = document.createElement('canvas'); cv.width = s; cv.height = s;
    const c = cv.getContext('2d'), img = c.createImageData(s, s), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 235 + Math.random() * 20;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = Math.random() * 26;
    }
    c.putImageData(img, 0, 0);
    this.paperTile = cv;
  }

  // --- isometric projection -------------------------------------------------
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.W = w; this.H = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const N = this.N;
    this.sx = Math.min((w * 0.74) / (2 * N), (h * 0.9) / (1.6 * N));
    this.sy = this.sx * 0.5;
    this.unit = this.sx;
    this.AX = { x: this.sx, y: this.sy };
    this.AY = { x: -this.sx, y: this.sy };
    this.c = (N + 1) / 2;
    this.originX = w / 2;
    this.originY = h * 0.42;
    this.lw = Math.max(1.6, this.sx * 0.42);  // ink line width
  }

  toScreen(u, v, hh = 0) {
    const du = u - this.c, dv = v - this.c;
    return [this.originX + du * this.AX.x + dv * this.AY.x,
            this.originY + du * this.AX.y + dv * this.AY.y - hh];
  }
  fromScreen(px, py) {
    const dx = px - this.originX, dy = py - this.originY;
    const a = this.AX.x, b = this.AY.x, cc = this.AX.y, d = this.AY.y;
    const det = a * d - b * cc;
    return [(dx * d - b * dy) / det + this.c, (a * dy - dx * cc) / det + this.c];
  }
  depthOf(gi, gj) { return gi + gj; }

  // --- ink helpers ----------------------------------------------------------
  _ink(scale = 1) { const c = this.ctx; c.strokeStyle = PAL.ink; c.lineWidth = this.lw * scale; c.lineJoin = 'round'; c.lineCap = 'round'; }
  _poly(pts, close = true) { const c = this.ctx; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); if (close) c.closePath(); }
  _line(a, b) { const c = this.ctx; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }

  // --- hand-drawn ("sketchy") ink strokes -----------------------------------
  // Deterministic jitter keyed on quantised coordinates so a static shape draws
  // the SAME wobble every frame (no shimmer); moving props wobble gently.
  _hash(x, y) { const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.545; return n - Math.floor(n); }
  _jit(p, amp) {
    const qx = Math.round(p[0] * 0.2), qy = Math.round(p[1] * 0.2);
    return [p[0] + (this._hash(qx, qy) - 0.5) * amp, p[1] + (this._hash(qy + 9, qx + 4) - 0.5) * amp];
  }
  // wobbly stroke through pts (one bulged midpoint per edge) with slight weight
  // variation and a small pen overshoot at open-stroke ends.
  _wstroke(pts, close = true, ampMul = 1) {
    const c = this.ctx, amp = this.unit * 0.2 * ampMul, n = pts.length;
    const segs = close ? n : n - 1;
    const baseLw = c.lineWidth;
    c.lineWidth = baseLw * (0.82 + this._hash(Math.round(pts[0][0]), Math.round(pts[0][1])) * 0.42);
    c.beginPath();
    let p0 = this._jit(pts[0], amp);
    if (!close) { // overshoot the start a touch backwards
      const a = pts[0], b = pts[1] || pts[0]; const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy) || 1;
      p0 = [p0[0] + dx / l * this.unit * 0.35, p0[1] + dy / l * this.unit * 0.35];
    }
    c.moveTo(p0[0], p0[1]);
    for (let s = 0; s < segs; s++) {
      const a = pts[s], b = pts[(s + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const off = (this._hash(Math.round((a[0] + b[0]) * 0.12), Math.round((a[1] + b[1]) * 0.12)) - 0.5) * amp * 1.6;
      const mx = (a[0] + b[0]) / 2 - dy / len * off, my = (a[1] + b[1]) / 2 + dx / len * off;
      let bj = this._jit(b, amp);
      if (!close && s === segs - 1) bj = [bj[0] + dx / len * this.unit * 0.35, bj[1] + dy / len * this.unit * 0.35]; // overshoot end
      c.quadraticCurveTo(mx, my, bj[0], bj[1]);
    }
    if (close) c.closePath();
    c.stroke();
    c.lineWidth = baseLw;
  }
  _wline(a, b, ampMul = 1) { this._wstroke([a, b], false, ampMul); }

  // --- public mutators ------------------------------------------------------
  initParticles(count = 700) {
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
    this._fluid = fluid;
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
      d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 12 + 120 * Math.abs(t - 0.5);
    }
    this.heatCtx.putImageData(this.heatImg, 0, 0);
  }

  createFan(gi, gj, angle) { const f = { gi, gj, angle, power: 1, phase: 0, popT: 0 }; this.fans.push(f); return f; }
  removeFan(fan) { this.fans = this.fans.filter((f) => f !== fan); }
  setFanAngle(fan, angle) { fan.angle = angle; }

  createFurniture(type, gi, gj) {
    const dims = {
      shelf:  { w: 1.4, d: 0.5, h: 5.5, color: PAL.shelf },
      table:  { w: 1.6, d: 1.0, h: 2.6, color: PAL.table },
      fridge: { w: 1.0, d: 0.9, h: 6.2, color: PAL.fridge, heat: true },
      cabinet:{ w: 1.1, d: 0.6, h: 3.6, color: PAL.cabinet },
    }[type] || { w: 1.1, d: 0.6, h: 3.6, color: PAL.cabinet };
    const item = { type, gi, gj, w: dims.w, d: dims.d, hCells: dims.h, color: dims.color, heat: !!dims.heat, popT: 0 };
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
  pickFloor(cx, cy) { const [u, v] = this._cell(cx, cy); if (u < 1 || u > this.N || v < 1 || v > this.N) return null; return [u, v]; }
  _near(list, cx, cy, rad) {
    const r = this.canvas.getBoundingClientRect(); const px = cx - r.left, py = cy - r.top;
    let best = null, bd = Infinity;
    for (const it of list) {
      const [sx, sy] = this.toScreen(it.gi, it.gj, this.unit * (it.hCells || 4) * 0.4);
      const dd = (sx - px) ** 2 + (sy - py) ** 2;
      const rr = this.unit * (Math.max(it.w || 0.6, it.d || 0.6) * 8 * 0.5 + rad) * 2.2;
      if (dd < rr * rr && dd < bd) { bd = dd; best = it; }
    }
    return best;
  }
  pickFan(cx, cy) { return this._near(this.fans, cx, cy, 1.4); }
  pickFurniture(cx, cy) { return this._near(this.furnitureItems, cx, cy, 0.6); }

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
    this._drawIsland(ctx);
    this._drawFloor(ctx);
    this._drawWalls(ctx);
    this._drawPicture(ctx);
    this._drawPlant(ctx, 9, 9);             // potted plant in the far corner
    const props = [];
    for (const it of this.furnitureItems) props.push({ k: 'f', it, d: this.depthOf(it.gi, it.gj) });
    for (const f of this.fans) props.push({ k: 'n', it: f, d: this.depthOf(f.gi, f.gj) });
    props.push({ k: 'c', it: this.character, d: this.depthOf(this.character.gi, this.character.gj) });
    props.sort((a, b) => a.d - b.d);
    for (const p of props) { if (p.k === 'f') this._furn(ctx, p.it); else if (p.k === 'n') this._fan(ctx, p.it); else this._char(ctx, p.it); }
    this._drawStreamlines(ctx);
    this._drawNight(ctx);
    this._drawPaper(ctx);
  }

  _drawPaper(ctx) {
    if (!this._paperPat) this._paperPat = ctx.createPattern(this.paperTile, 'repeat');
    ctx.save(); ctx.globalAlpha = this.isDayNow ? 0.5 : 0.3;
    ctx.fillStyle = this._paperPat; ctx.fillRect(0, 0, this.W, this.H); ctx.restore();
  }

  // --- scene ---------------------------------------------------------------
  _floorPath(ctx) {
    const a = 0.5, b = this.N + 0.5;
    const p = [this.toScreen(a, a), this.toScreen(b, a), this.toScreen(b, b), this.toScreen(a, b)];
    this._poly(p);
    return p;
  }

  _drawSky(ctx) { ctx.fillStyle = this.isDayNow ? PAL.paper : PAL.paperN; ctx.fillRect(0, 0, this.W, this.H); }

  _drawIsland(ctx) {
    const N = this.N, ext = this.unit * 5.0, a = -1.0, b = N + 2.0;
    const c1 = this.toScreen(a, b), c2 = this.toScreen(b, b), c3 = this.toScreen(b, a);
    // water pool (flat)
    ctx.fillStyle = this.isDayNow ? PAL.water : PAL.waterN; ctx.fillRect(0, 0, this.W, this.H);
    // island sides + ink
    ctx.fillStyle = tint(PAL.islandSide, this.isDayNow);
    this._poly([c1, c2, [c2[0], c2[1] + ext], [c1[0], c1[1] + ext]]); ctx.fill();
    this._poly([c2, c3, [c3[0], c3[1] + ext], [c2[0], c2[1] + ext]]); ctx.fill();
    this._ink(1.1);
    this._wstroke([c1, c2, c3, [c3[0], c3[1] + ext], [c2[0], c2[1] + ext], [c1[0], c1[1] + ext]]);
    this._wline(c2, [c2[0], c2[1] + ext]);
    // island top
    const t1 = this.toScreen(a, a), t2 = this.toScreen(b, a), t3 = this.toScreen(b, b), t4 = this.toScreen(a, b);
    ctx.fillStyle = tint(PAL.island, this.isDayNow);
    this._poly([t1, t2, t3, t4]); ctx.fill();
    this._ink(1.1); this._wstroke([t1, t2, t3, t4]);
  }

  _drawFloor(ctx) {
    ctx.save();
    this._floorPath(ctx);
    ctx.fillStyle = tint(PAL.floor, this.isDayNow); ctx.fill();
    // heat overlay (faint)
    this._floorPath(ctx); ctx.clip();
    const AX = this.AX, AY = this.AY, c = this.c, N = this.N;
    const e = this.originX + (0.5 - c) * (AX.x + AY.x), f = this.originY + (0.5 - c) * (AX.y + AY.y);
    ctx.globalAlpha = this.isDayNow ? 0.55 : 0.4; ctx.imageSmoothingEnabled = true;
    const cur = ctx.getTransform();
    ctx.transform(AX.x, AX.y, AY.x, AY.y, e, f);
    ctx.drawImage(this.heatCanvas, 0, 0, N, N);
    ctx.setTransform(cur); ctx.globalAlpha = 1;
    // faint ink tile grid (line-art structure)
    ctx.strokeStyle = 'rgba(74,59,62,0.16)'; ctx.lineWidth = this.lw * 0.4;
    for (let i = 8; i < N; i += 8) { this._line(this.toScreen(i + 0.5, 0.5), this.toScreen(i + 0.5, N + 0.5)); this._line(this.toScreen(0.5, i + 0.5), this.toScreen(N + 0.5, i + 0.5)); }
    ctx.restore();
    // rug
    const [cx, cy] = this.toScreen(this.character.gi, this.character.gj);
    ctx.fillStyle = tint(PAL.rug, this.isDayNow);
    ctx.beginPath(); ctx.ellipse(cx, cy, this.unit * 10, this.unit * 5, 0, 0, TAU); ctx.fill();
    this._ink(0.8); ctx.beginPath(); ctx.ellipse(cx, cy, this.unit * 10, this.unit * 5, 0, 0, TAU); ctx.stroke();
    // floor outline
    this._ink(1.2); this._wstroke(this._floorPath(ctx));
  }

  _wall(ctx, ua, va, ub, vb, h, inU, inV, faceCol) {
    const wt = 1.6;
    const of1 = this.toScreen(ua, va), of2 = this.toScreen(ub, vb);
    const in1 = this.toScreen(ua + inU * wt, va + inV * wt), in2 = this.toScreen(ub + inU * wt, vb + inV * wt);
    const up = (p) => [p[0], p[1] - h];
    const ot1 = up(of1), ot2 = up(of2), it1 = up(in1), it2 = up(in2);
    ctx.fillStyle = tint(faceCol, this.isDayNow); this._poly([of1, of2, ot2, ot1]); ctx.fill();      // outer face
    ctx.fillStyle = tint(PAL.wall, this.isDayNow, 1.04); this._poly([ot1, ot2, it2, it1]); ctx.fill(); // top
    this._ink(1.1);
    this._wstroke([of1, of2, ot2, ot1]);
    this._wstroke([ot1, ot2, it2, it1]);
  }
  _drawWalls(ctx) {
    const N = this.N, H = this.unit * 6.4;
    this._wall(ctx, 0.5, 0.5, N + 0.5, 0.5, H, 0, 1, PAL.wall);       // back
    this._wall(ctx, 0.5, 0.5, 0.5, N + 0.5, H, 1, 0, PAL.wallSide);   // left
    this._drawWindow(ctx, H);
  }

  _drawWindow(ctx, H) {
    const a = this.winA, b = this.winB, hLow = H * 0.34, hHigh = H * 0.84;
    let f1, f2;
    if (this.windowWall === 'left') { f1 = this.toScreen(0.5, a); f2 = this.toScreen(0.5, b); }
    else { f1 = this.toScreen(a, 0.5); f2 = this.toScreen(b, 0.5); }
    const c = [[f1[0], f1[1] - hLow], [f2[0], f2[1] - hLow], [f2[0], f2[1] - hHigh], [f1[0], f1[1] - hHigh]];
    ctx.fillStyle = this.windowOpen ? tint(PAL.glass, this.isDayNow) : tint(PAL.frame, this.isDayNow);
    this._poly(c); ctx.fill();
    // little outside scene through the glass
    if (this.windowOpen) {
      ctx.save(); this._poly(c); ctx.clip();
      const gx = (c[0][0] + c[2][0]) / 2 + (this.windowWall === 'left' ? -8 : 8);
      const gy = (c[0][1] + c[2][1]) / 2 - this.unit * 1.5;
      if (this.isDayNow) {
        ctx.fillStyle = '#ffe7a6'; ctx.beginPath(); ctx.arc(gx, gy, this.unit * 1.6, 0, TAU); ctx.fill();
        this._ink(0.6); ctx.beginPath(); ctx.arc(gx, gy, this.unit * 1.6, 0, TAU); ctx.stroke();
        ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.9;
        const cy2 = gy + this.unit * 2.4;
        ctx.beginPath(); ctx.arc(gx - this.unit, cy2, this.unit, 0, TAU); ctx.arc(gx + this.unit * 0.4, cy2, this.unit * 1.2, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = '#eaeefc'; ctx.beginPath(); ctx.arc(gx, gy, this.unit * 1.4, 0, TAU); ctx.fill();
        ctx.fillStyle = '#222a48'; ctx.beginPath(); ctx.arc(gx + this.unit * 0.7, gy - this.unit * 0.3, this.unit * 1.2, 0, TAU); ctx.fill();
        ctx.fillStyle = '#fff'; for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.arc(gx - this.unit * (2 - k * 0.9), gy + this.unit * (1.5 - (k % 2)), 1.3, 0, TAU); ctx.fill(); }
      }
      ctx.restore();
    }
    this._ink(1.1); this._wstroke(c);
    // mullions
    this._ink(0.7);
    this._wline(mid(c[0], c[1], 0.5), mid(c[3], c[2], 0.5));
    this._wline(mid(c[0], c[3], 0.5), mid(c[1], c[2], 0.5));
  }

  // a framed picture hung on the back wall
  _drawPicture(ctx) {
    const N = this.N, H = this.unit * 6.4;
    const u0 = N * 0.80 - 4, u1 = N * 0.80 + 4;
    const f1 = this.toScreen(u0, 0.5), f2 = this.toScreen(u1, 0.5);
    const hb = H * 0.42, ht = H * 0.74;
    const cc = [[f1[0], f1[1] - hb], [f2[0], f2[1] - hb], [f2[0], f2[1] - ht], [f1[0], f1[1] - ht]];
    ctx.fillStyle = tint(PAL.picture, this.isDayNow); this._poly(cc); ctx.fill();
    this._ink(1); this._wstroke(cc);
    // tiny hill + sun doodle inside
    ctx.save(); this._poly(cc); ctx.clip();
    const mx = (cc[0][0] + cc[2][0]) / 2, my = (cc[0][1] + cc[2][1]) / 2;
    ctx.fillStyle = '#e89a6e'; ctx.beginPath(); ctx.arc(mx + 6, my - 4, 4, 0, TAU); ctx.fill();
    this._ink(0.6); ctx.strokeStyle = '#9a7b5a';
    ctx.beginPath(); ctx.moveTo(cc[3][0] + 2, my + 6); ctx.quadraticCurveTo(mx, my - 2, cc[2][0] - 2, my + 6); ctx.stroke();
    ctx.restore();
  }

  // a potted plant standing on the floor
  _drawPlant(ctx, gi, gj) {
    const [x, y] = this.toScreen(gi, gj);
    const u = this.unit;
    this._shadow(ctx, gi, gj, u * 2);
    // pot
    const pot = [[x - u * 1.4, y - u * 1.4], [x + u * 1.4, y - u * 1.4], [x + u, y], [x - u, y]];
    ctx.fillStyle = tint(PAL.pot, this.isDayNow); this._poly(pot); ctx.fill(); this._ink(1); this._wstroke(pot);
    // foliage clumps
    ctx.fillStyle = tint(PAL.plant, this.isDayNow);
    const clumps = [[x, y - u * 4.4, u * 1.8], [x - u * 1.6, y - u * 3.2, u * 1.4], [x + u * 1.6, y - u * 3.2, u * 1.4]];
    for (const [cx, cy, r] of clumps) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill(); }
    this._ink(0.9);
    for (const [cx, cy, r] of clumps) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke(); }
  }

  // continuous hand-drawn flow lines traced through the velocity field
  _drawStreamlines(ctx) {
    const fl = this._fluid; if (!fl) return;
    const N = this.N;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const col = this.isDayNow ? '74,120,180' : '150,190,235';
    let drawn = 0;
    for (let p = 0; p < this.partCount && drawn < 150; p += 2) {
      let gi = this.partPos[p * 2], gj = this.partPos[p * 2 + 1];
      const [u0, v0] = fl.sampleVelocity(gi, gj);
      if (Math.hypot(u0, v0) * 42 - 1.0 <= 0) continue;
      drawn++;
      const pts = [];
      for (let s = 0; s < 16; s++) {
        const [u, v] = fl.sampleVelocity(gi, gj);
        const sp = Math.hypot(u, v); if (sp < 0.0005) break;
        pts.push(this.toScreen(gi, gj, this.unit * 0.6));
        gi += u * N * 0.9 * 0.05; gj += v * N * 0.9 * 0.05;
        if (gi < 1 || gi > N || gj < 1 || gj > N || fl.solid[Math.round(gi) + (N + 2) * Math.round(gj)]) break;
      }
      if (pts.length < 3) continue;
      const a = Math.min(0.55, Math.min(1, this.partLife[p] * 2.2) * 0.55);
      ctx.strokeStyle = `rgba(${col},${a})`; ctx.lineWidth = this.lw * 0.6;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) { const m = mid(pts[i], pts[i + 1], 0.5); ctx.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]); }
      ctx.stroke();
      // arrowhead-ish tail tick
      const t = pts[pts.length - 1], t2 = pts[pts.length - 2];
      const dx = t[0] - t2[0], dy = t[1] - t2[1], l = Math.hypot(dx, dy) || 1;
      ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(t[0] - dx / l * this.unit * 0.8, t[1] - dy / l * this.unit * 0.8); ctx.stroke();
    }
  }

  // subtle ink contact shadow under props
  _shadow(ctx, gi, gj, rx) {
    const [x, y] = this.toScreen(gi, gj);
    ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = PAL.ink;
    ctx.translate(x, y); ctx.scale(1, 0.5); ctx.beginPath(); ctx.arc(0, 0, rx, 0, TAU); ctx.fill(); ctx.restore();
  }

  // flat-fill, ink-outlined iso box; returns key corners
  _isoBox(ctx, gi, gj, hu, hv, hpix, color, pop) {
    hu *= pop; hv *= pop; hpix *= pop;
    const b1 = this.toScreen(gi - hu, gj - hv), b2 = this.toScreen(gi + hu, gj - hv);
    const b3 = this.toScreen(gi + hu, gj + hv), b4 = this.toScreen(gi - hu, gj + hv);
    const top = (p) => [p[0], p[1] - hpix];
    const t1 = top(b1), t2 = top(b2), t3 = top(b3), t4 = top(b4);
    ctx.fillStyle = tint(color, this.isDayNow, 0.9); this._poly([b2, b3, t3, t2]); ctx.fill();    // right
    ctx.fillStyle = tint(color, this.isDayNow, 0.82); this._poly([b3, b4, t4, t3]); ctx.fill();   // front
    ctx.fillStyle = tint(color, this.isDayNow, 1.06); this._poly([t1, t2, t3, t4]); ctx.fill();   // top
    this._ink(1);
    this._wstroke([t1, t2, b2, b3, b4, t4]);              // silhouette
    this._wline(t2, t3); this._wline(t4, t3); this._wline(t3, b3);  // interior edges
    return { t1, t2, t3, t4, b3, b4 };
  }

  _furn(ctx, it) {
    const cpu = this.N / this.roomSize, hu = (it.w * cpu) / 2, hv = (it.d * cpu) / 2;
    const pop = Math.max(0.04, it.popT);
    this._shadow(ctx, it.gi, it.gj, this.unit * Math.max(hu, hv) * 1.4);
    const T = this._isoBox(ctx, it.gi, it.gj, hu, hv, this.unit * it.hCells, it.color, pop);
    this._ink(0.7);
    if (it.type === 'shelf' || it.type === 'cabinet') {
      const rows = it.type === 'shelf' ? 3 : 2;
      for (let s = 1; s <= rows; s++) this._wline(mid(T.t4, T.b4, s / (rows + 1)), mid(T.t3, T.b3, s / (rows + 1)));
    } else if (it.type === 'fridge') {
      this._wline(mid(T.t4, T.b4, 0.4), mid(T.t3, T.b3, 0.4));
      this._wline(mid(T.t3, T.b3, 0.15), mid(T.t3, T.b3, 0.6));
    }
  }

  _fan(ctx, fan) {
    const pop = Math.max(0.04, fan.popT);
    const [bx, by] = this.toScreen(fan.gi, fan.gj);
    this._shadow(ctx, fan.gi, fan.gj, this.unit * 2.6);
    const dx = Math.sin(fan.angle), dz = Math.cos(fan.angle);
    const tip = this.toScreen(fan.gi + dx * 5, fan.gj + dz * 5);
    ctx.strokeStyle = 'rgba(90,150,225,0.55)'; ctx.lineWidth = this.lw * 0.9; ctx.setLineDash([this.unit * 0.8, this.unit * 0.8]);
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tip[0], tip[1]); ctx.stroke(); ctx.setLineDash([]);
    const headY = by - this.unit * 5.2 * pop, R = this.unit * 2.3 * pop;
    ctx.fillStyle = tint(PAL.fan, this.isDayNow); ctx.beginPath(); ctx.ellipse(bx, by, this.unit * 1.6 * pop, this.unit * 0.8 * pop, 0, 0, TAU); ctx.fill();
    this._ink(0.9); ctx.beginPath(); ctx.ellipse(bx, by, this.unit * 1.6 * pop, this.unit * 0.8 * pop, 0, 0, TAU); ctx.stroke();
    this._line([bx, by], [bx, headY]);
    ctx.fillStyle = tint(PAL.fan, this.isDayNow, 1.08); ctx.beginPath(); ctx.arc(bx, headY, R, 0, TAU); ctx.fill();
    this._ink(1); ctx.beginPath(); ctx.arc(bx, headY, R, 0, TAU); ctx.stroke();
    this._ink(0.8);
    for (let b = 0; b < 4; b++) { const ang = fan.phase + (b / 4) * TAU; ctx.beginPath(); ctx.moveTo(bx, headY); ctx.lineTo(bx + Math.cos(ang) * R * 0.82, headY + Math.sin(ang) * R * 0.82); ctx.stroke(); }
    ctx.fillStyle = PAL.hub; ctx.beginPath(); ctx.arc(bx, headY, R * 0.18, 0, TAU); ctx.fill(); this._ink(0.7); ctx.beginPath(); ctx.arc(bx, headY, R * 0.18, 0, TAU); ctx.stroke();
  }

  _char(ctx, ch) {
    const [bx, by] = this.toScreen(ch.gi, ch.gj);
    const bob = Math.sin(ch.t * 2) * this.unit * 0.3;
    const S = this.unit;
    this._shadow(ctx, ch.gi, ch.gj, S * 2.4);
    // waving hand-fan (animates faster when hot)
    const wave = Math.sin(ch.t * (4 + ch.hot * 8)) * 0.5;
    const sx = bx + S * 1.5, sy = by - S * 2.8 + bob;
    const hx = sx + Math.cos(-0.4 + wave) * S * 1.8, hyy = sy + Math.sin(-0.4 + wave) * S * 1.8;
    this._ink(1); this._wline([sx, sy], [hx, hyy]);          // arm
    ctx.save(); ctx.translate(hx, hyy); ctx.rotate(-0.4 + wave);
    ctx.fillStyle = tint(PAL.blade, this.isDayNow);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, S * 1.4, -0.5, 0.5); ctx.closePath(); ctx.fill();
    this._ink(0.8); ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, S * 1.4, -0.5, 0.5); ctx.closePath(); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = tint(PAL.body, this.isDayNow);
    roundedCapsule(ctx, bx, by - S * 1.2 + bob, S * 1.7, S * 3.2);
    this._ink(1); ctx.stroke();
    const hy = by - S * 5.0 + bob;
    ctx.fillStyle = lerpHexCss(PAL.skin, '#ff9a84', Math.max(0, Math.min(1, ch.hot)));
    ctx.beginPath(); ctx.arc(bx, hy, S * 1.8, 0, TAU); ctx.fill();
    this._ink(1); ctx.beginPath(); ctx.arc(bx, hy, S * 1.8, 0, TAU); ctx.stroke();
    ctx.fillStyle = PAL.ink;
    ctx.beginPath(); ctx.arc(bx - S * 0.6, hy + S * 0.1, S * 0.18, 0, TAU); ctx.arc(bx + S * 0.6, hy + S * 0.1, S * 0.18, 0, TAU); ctx.fill();
    this._ink(0.7); ctx.beginPath(); ctx.arc(bx, hy + S * 0.5, S * 0.5, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    if (ch.hot > 0.45) { ctx.fillStyle = '#7fc8ff'; ctx.beginPath(); ctx.arc(bx + S * 1.5, hy + Math.sin(ch.t * 4) * 2, S * 0.4, 0, TAU); ctx.fill(); this._ink(0.5); ctx.stroke(); }
  }

  _drawParticles(ctx) {
    if (!this.partCount) return;
    ctx.lineCap = 'round';
    const col = this.isDayNow ? '70,120,180' : '150,190,235';
    for (let p = 0; p < this.partCount; p++) {
      const sp = this.partSpd[p];
      let b = sp * 42 - 1.0; if (b <= 0) continue;
      b = Math.min(1, b) * Math.min(1, this.partLife[p] * 2.2);
      if (b <= 0.06) continue;
      const gi = this.partPos[p * 2], gj = this.partPos[p * 2 + 1];
      const tail = Math.min(3.5, sp * 90);
      const [x2, y2] = this.toScreen(gi, gj, this.unit * 0.6);
      const [x1, y1] = this.toScreen(gi - this.partU[p] / sp * tail, gj - this.partV[p] / sp * tail, this.unit * 0.6);
      ctx.strokeStyle = `rgba(${col},${b * 0.5})`; ctx.lineWidth = this.lw * 0.6;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
  }

  _drawNight(ctx) {
    let a = this.isDayNow ? Math.max(0, 1 - this.sun) * 0.07 : 0.3;
    if (a <= 0) return;
    ctx.fillStyle = `rgba(30,36,70,${a})`; ctx.fillRect(0, 0, this.W, this.H);
  }
}

// --- helpers ----------------------------------------------------------------
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
// tint a hex string for day/night; mul lightens/darkens the flat fill
function tint(hex, isDay, mul = 1) {
  const n = parseInt(hex.replace('#', ''), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (isDay ? 1 : 0.7) * mul;
  if (f >= 1) { const t = f - 1; r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t; }
  else { r *= f; g *= f; b *= f; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
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
