// fluid.js
// A compact 2D "stable fluids" solver (Jos Stam, 1999) extended with a
// temperature field and a solid-obstacle mask.
//
// The point of this module is *plausible* physics, not engineering-grade CFD:
//  - incompressible velocity field (mass-conserving via a pressure projection)
//  - semi-Lagrangian advection (unconditionally stable)
//  - viscous + thermal diffusion (Gauss-Seidel relaxation)
//  - buoyancy: warm air rises is modelled as a small force, but since our grid
//    is a *top-down* floor plan we instead use it as gentle thermal spreading.
//
// Grid convention: an (N+2) x (N+2) array. The outer ring (index 0 and N+1)
// is the boundary. Interior cells are 1..N. IX(i,j) = i + (N+2)*j.

export class Fluid {
  constructor(N, opts = {}) {
    this.N = N;
    const size = (N + 2) * (N + 2);
    this.size = size;

    this.u = new Float32Array(size);   // x velocity
    this.v = new Float32Array(size);   // y velocity
    this.u0 = new Float32Array(size);  // scratch / sources
    this.v0 = new Float32Array(size);
    this.T = new Float32Array(size);   // temperature (°C)
    this.T0 = new Float32Array(size);  // temperature source / scratch

    this.solid = new Uint8Array(size); // 1 = wall / obstacle cell

    this.visc = opts.visc ?? 0.00002; // momentum diffusion
    this.diff = opts.diff ?? 0.00004; // thermal diffusion
    this.iters = opts.iters ?? 14;    // Gauss-Seidel iterations
  }

  IX(i, j) {
    return i + (this.N + 2) * j;
  }

  clearSources() {
    this.u0.fill(0);
    this.v0.fill(0);
    this.T0.fill(0);
  }

  // Add a velocity impulse at a cell (used by fans).
  addVelocity(i, j, ax, ay) {
    const k = this.IX(i, j);
    this.u0[k] += ax;
    this.v0[k] += ay;
  }

  addHeat(i, j, amount) {
    this.T0[this.IX(i, j)] += amount;
  }

  // --- core operators -------------------------------------------------------

  addSource(x, s, dt) {
    for (let k = 0; k < this.size; k++) x[k] += dt * s[k];
  }

  // Enforce boundary conditions. b: 0 scalar, 1 = u (x-vel), 2 = v (y-vel).
  // Solid cells reflect the relevant velocity component so air can't pass
  // through walls; scalars (temperature) are simply copied from the neighbour.
  setBnd(b, x) {
    const N = this.N;
    const IX = (i, j) => i + (N + 2) * j;

    for (let i = 1; i <= N; i++) {
      x[IX(0, i)]     = b === 1 ? -x[IX(1, i)] : x[IX(1, i)];
      x[IX(N + 1, i)] = b === 1 ? -x[IX(N, i)] : x[IX(N, i)];
      x[IX(i, 0)]     = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
      x[IX(i, N + 1)] = b === 2 ? -x[IX(i, N)] : x[IX(i, N)];
    }
    x[IX(0, 0)]         = 0.5 * (x[IX(1, 0)] + x[IX(0, 1)]);
    x[IX(0, N + 1)]     = 0.5 * (x[IX(1, N + 1)] + x[IX(0, N)]);
    x[IX(N + 1, 0)]     = 0.5 * (x[IX(N, 0)] + x[IX(N + 1, 1)]);
    x[IX(N + 1, N + 1)] = 0.5 * (x[IX(N, N + 1)] + x[IX(N + 1, N)]);

    // Interior obstacles: reflect the normal velocity, mirror scalars.
    const solid = this.solid;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const k = IX(i, j);
        if (!solid[k]) continue;
        if (b === 1) { x[k] = 0; }
        else if (b === 2) { x[k] = 0; }
        else {
          // average the open neighbours so heat hugs the wall sensibly
          let sum = 0, n = 0;
          if (!solid[IX(i - 1, j)]) { sum += x[IX(i - 1, j)]; n++; }
          if (!solid[IX(i + 1, j)]) { sum += x[IX(i + 1, j)]; n++; }
          if (!solid[IX(i, j - 1)]) { sum += x[IX(i, j - 1)]; n++; }
          if (!solid[IX(i, j + 1)]) { sum += x[IX(i, j + 1)]; n++; }
          x[k] = n ? sum / n : x[k];
        }
      }
    }
  }

  linSolve(b, x, x0, a, c) {
    const N = this.N;
    const IX = (i, j) => i + (N + 2) * j;
    const invC = 1 / c;
    for (let t = 0; t < this.iters; t++) {
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          const k = IX(i, j);
          x[k] = (x0[k] + a * (x[k - 1] + x[k + 1] + x[k - (N + 2)] + x[k + (N + 2)])) * invC;
        }
      }
      this.setBnd(b, x);
    }
  }

  diffuse(b, x, x0, diff, dt) {
    const a = dt * diff * this.N * this.N;
    this.linSolve(b, x, x0, a, 1 + 4 * a);
  }

  advect(b, d, d0, u, v, dt) {
    const N = this.N;
    const IX = (i, j) => i + (N + 2) * j;
    const dt0 = dt * N;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        let x = i - dt0 * u[IX(i, j)];
        let y = j - dt0 * v[IX(i, j)];
        if (x < 0.5) x = 0.5; if (x > N + 0.5) x = N + 0.5;
        const i0 = Math.floor(x), i1 = i0 + 1;
        if (y < 0.5) y = 0.5; if (y > N + 0.5) y = N + 0.5;
        const j0 = Math.floor(y), j1 = j0 + 1;
        const s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
        d[IX(i, j)] =
          s0 * (t0 * d0[IX(i0, j0)] + t1 * d0[IX(i0, j1)]) +
          s1 * (t0 * d0[IX(i1, j0)] + t1 * d0[IX(i1, j1)]);
      }
    }
    this.setBnd(b, d);
  }

  // Pressure projection: make the velocity field divergence-free so that mass
  // is conserved. This is the step that makes the flow look like a real fluid
  // (vortices, recirculation behind obstacles) instead of just drifting smoke.
  project(u, v, p, div) {
    const N = this.N;
    const IX = (i, j) => i + (N + 2) * j;
    const h = 1.0 / N;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        div[IX(i, j)] = -0.5 * h * (
          u[IX(i + 1, j)] - u[IX(i - 1, j)] +
          v[IX(i, j + 1)] - v[IX(i, j - 1)]
        );
        p[IX(i, j)] = 0;
      }
    }
    this.setBnd(0, div);
    this.setBnd(0, p);
    this.linSolve(0, p, div, 1, 4);
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        u[IX(i, j)] -= 0.5 * (p[IX(i + 1, j)] - p[IX(i - 1, j)]) / h;
        v[IX(i, j)] -= 0.5 * (p[IX(i, j + 1)] - p[IX(i, j - 1)]) / h;
      }
    }
    this.setBnd(1, u);
    this.setBnd(2, v);
  }

  velStep(dt) {
    this.addSource(this.u, this.u0, dt);
    this.addSource(this.v, this.v0, dt);

    // diffuse (swap buffers: u0/v0 become the previous state)
    let tmp;
    tmp = this.u; this.u = this.u0; this.u0 = tmp;
    this.diffuse(1, this.u, this.u0, this.visc, dt);
    tmp = this.v; this.v = this.v0; this.v0 = tmp;
    this.diffuse(2, this.v, this.v0, this.visc, dt);

    this.project(this.u, this.v, this.u0, this.v0);

    tmp = this.u; this.u = this.u0; this.u0 = tmp;
    tmp = this.v; this.v = this.v0; this.v0 = tmp;
    this.advect(1, this.u, this.u0, this.u0, this.v0, dt);
    this.advect(2, this.v, this.v0, this.u0, this.v0, dt);

    this.project(this.u, this.v, this.u0, this.v0);
  }

  tempStep(dt) {
    this.addSource(this.T, this.T0, dt);
    let tmp = this.T; this.T = this.T0; this.T0 = tmp;
    this.diffuse(0, this.T, this.T0, this.diff, dt);
    tmp = this.T; this.T = this.T0; this.T0 = tmp;
    this.advect(0, this.T, this.T0, this.u, this.v, dt);
  }

  step(dt) {
    this.velStep(dt);
    this.tempStep(dt);
    this.clearSources();
  }

  // --- sampling helpers (bilinear) -----------------------------------------

  sample(field, fi, fj) {
    const N = this.N;
    if (fi < 0.5) fi = 0.5; if (fi > N + 0.5) fi = N + 0.5;
    if (fj < 0.5) fj = 0.5; if (fj > N + 0.5) fj = N + 0.5;
    const i0 = Math.floor(fi), i1 = i0 + 1;
    const j0 = Math.floor(fj), j1 = j0 + 1;
    const s1 = fi - i0, s0 = 1 - s1, t1 = fj - j0, t0 = 1 - t1;
    const IX = (i, j) => i + (N + 2) * j;
    return (
      s0 * (t0 * field[IX(i0, j0)] + t1 * field[IX(i0, j1)]) +
      s1 * (t0 * field[IX(i1, j0)] + t1 * field[IX(i1, j1)])
    );
  }

  sampleVelocity(fi, fj) {
    return [this.sample(this.u, fi, fj), this.sample(this.v, fi, fj)];
  }

  sampleTemp(fi, fj) {
    return this.sample(this.T, fi, fj);
  }
}
