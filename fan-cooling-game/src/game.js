// game.js
// Orchestrates the simulation: weather -> heat boundary conditions -> CFD fan
// airflow -> comfort scoring -> presentation. Heat transfer is intentionally
// "roughly right" rather than precise, but the airflow obeys real fluid laws
// (incompressible, mass-conserving) via src/fluid.js.

import { Fluid } from './fluid.js';
import { Scene2D } from './scene2d.js';
import { fetchWeather } from './weather.js';

const N = 64;
const SKIN_TEMP = 33;          // °C; above this a fan stops feeling cooling
const COMFORT_TARGET = 24;     // °C "feels like" we aim for
const COMFORT_BAND = 6;        // °C half-width that still scores points

export class Game {
  constructor(canvas) {
    this.scene = new Scene2D(canvas);
    this.scene.N = N;
    this.fluid = new Fluid(N, { iters: 14, visc: 0.00002, diff: 0.00006 });
    this.scene.initParticles(800);

    // window opening: a vertical span (in height) on a side wall
    this.winA = Math.floor(N * 0.45);  // bottom of window
    this.winB = Math.floor(N * 0.80);  // top of window
    this.windowOpen = true;
    this.windowWall = 'left';           // 'left' (i=1) | 'right' (i=N)

    // build state
    this.furniture = [];
    this.maxFurniture = 6;
    this.mode = 'fan';                   // 'fan' | 'furniture'
    this.furnitureType = 'shelf';

    // person stands on the floor; comfort is sampled around chest height
    const [pgi, pgj] = [Math.floor(N * 0.68), Math.floor(N * 0.16)];
    this.personGi = pgi; this.personGj = pgj;
    this.scene.setCharacterGrid(pgi, pgj);

    this.fans = [];          // {fan(scene), gi, gj, angle, power}
    this.selected = null;
    this.placeMode = false;

    this.weather = null;
    this.simHour = 14;       // 24h clock
    this.autoClock = false;
    this.timeScale = 1;

    this.score = 0;
    this.comfort = 0;
    this.feelsLike = COMFORT_TARGET;
    this.indoorAvg = COMFORT_TARGET;

    this.maxFans = 4;
    this._initTemperature(COMFORT_TARGET);
    this._t = 0;
    this.onStats = null;     // callback(stats) for UI
  }

  _initTemperature(t) {
    this.fluid.T.fill(t);
    this.fluid.T0.fill(0);
  }

  async loadWeather(loc) {
    this.weather = await fetchWeather(loc);
    this.simHour = new Date().getHours();
    return this.weather;
  }

  // --- derived environment --------------------------------------------------

  outdoorTemp() {
    if (!this.weather) return 26;
    const h = Math.floor(this.simHour) % 24;
    const arr = this.weather.hourly;
    const a = arr[h], b = arr[(h + 1) % 24];
    const f = this.simHour - Math.floor(this.simHour);
    return a + (b - a) * f;
  }

  isDay() {
    return this.simHour >= 6 && this.simHour < 21;
  }

  sunStrength() {
    // 0 at night, peaks at solar noon
    if (!this.isDay()) return 0;
    const x = (this.simHour - 6) / 15; // 0..1 across daylight
    return Math.max(0, Math.sin(x * Math.PI));
  }

  // --- fans -----------------------------------------------------------------

  placeFan(gi, gj) {
    if (this.fans.length >= this.maxFans) return null;
    gi = Math.max(3, Math.min(N - 2, Math.round(gi)));
    gj = Math.max(3, Math.min(N - 2, Math.round(gj)));
    if (this.fluid.solid[gi + (N + 2) * gj]) return null; // don't place inside furniture
    const angle = 0;
    const sFan = this.scene.createFan(gi, gj, angle);
    const fan = { sFan, gi, gj, angle, power: 1 };
    this.fans.push(fan);
    this.selectFan(fan);
    return fan;
  }

  selectFan(fan) {
    this.selected = fan;
    if (this.onStats) this._emit();
  }

  rotateSelected(deltaRad) {
    if (!this.selected) return;
    this.selected.angle += deltaRad;
    this.scene.setFanAngle(this.selected.sFan, this.selected.angle);
  }

  setSelectedPower(p) {
    if (!this.selected) return;
    this.selected.power = p;
    this.selected.sFan.power = p;
  }

  removeSelected() {
    if (!this.selected) return;
    this.scene.removeFan(this.selected.sFan);
    this.fans = this.fans.filter((f) => f !== this.selected);
    this.selected = null;
  }

  // --- furniture / build mode ----------------------------------------------

  setMode(m) { this.mode = m; if (m !== 'fan') { this.selected = null; this._emit(); } }
  setFurnitureType(t) { this.furnitureType = t; }

  placeFurniture(type, gi, gj) {
    if (this.furniture.length >= this.maxFurniture) return null;
    gi = Math.max(4, Math.min(N - 3, Math.round(gi)));
    gj = Math.max(4, Math.min(N - 3, Math.round(gj)));
    const item = this.scene.createFurniture(type, gi, gj);
    this.furniture.push(item);
    this.rebuildSolid();
    if (this.onStats) this._emit();
    return item;
  }

  removeFurnitureItem(item) {
    this.scene.removeFurniture(item);
    this.furniture = this.furniture.filter((f) => f !== item);
    this.rebuildSolid();
    if (this.onStats) this._emit();
  }

  setWindowWall(wall) {
    this.windowWall = wall;
    this.scene.setWindowWall(wall);
    if (this.onStats) this._emit();
  }

  pickAt(x, y) {
    if (this.mode === 'furniture') {
      const it = this.scene.pickFurniture(x, y);
      if (it) { this.removeFurnitureItem(it); return 'remove-furniture'; }
      const cell = this.scene.pickFloor(x, y);
      if (cell) { this.placeFurniture(this.furnitureType, cell[0], cell[1]); return 'place-furniture'; }
      return null;
    }
    const fan = this.scene.pickFan(x, y);
    if (fan) {
      const g = this.fans.find((f) => f.sFan === fan);
      if (g) { this.selectFan(g); return 'fan'; }
    }
    const cell = this.scene.pickFloor(x, y);
    if (cell) {
      this.placeFan(cell[0], cell[1]);
      return 'place';
    }
    return null;
  }

  // --- physics step ---------------------------------------------------------

  applyBoundary(dt) {
    const f = this.fluid;
    const Tout = this.outdoorTemp();
    const sun = this.sunStrength();
    const idx = (i, j) => i + (N + 2) * j;

    // 1) wall / floor / ceiling conduction toward outdoor (walls insulate, so
    //    the coefficient is small).
    const wallK = 0.16 * dt;
    for (let i = 1; i <= N; i++) {
      f.T[idx(i, 1)] += (Tout - f.T[idx(i, 1)]) * wallK;
      f.T[idx(i, N)] += (Tout - f.T[idx(i, N)]) * wallK;
      f.T[idx(1, i)] += (Tout - f.T[idx(1, i)]) * wallK;
      f.T[idx(N, i)] += (Tout - f.T[idx(N, i)]) * wallK;
    }

    // 2) window on a side wall (vertical span winA..winB in height). When open it
    //    exchanges air with outside and blows a breeze inward; cool incoming air
    //    then sinks under its own (negative) buoyancy. Left wall inward = +i,
    //    right wall inward = -i.
    const open = this.windowOpen ? 1 : 0;
    const exch = (0.9 * dt) * open;
    const breeze = 8.0 * open;
    const outdoorBreeze = this.weather ? Math.min(1.5, (this.weather.wind || 5) / 12) : 0.6;
    const left = this.windowWall !== 'right';
    const nx = left ? 1 : -1;
    const wallI = left ? 1 : N;
    for (let j = this.winA; j <= this.winB; j++) {
      for (let d = 0; d < 3; d++) {
        const i = left ? wallI + d : wallI - d;
        const k = idx(i, j);
        f.T[k] += (Tout - f.T[k]) * exch;
        f.u0[k] += nx * breeze * outdoorBreeze;
      }
    }

    // 3) solar gain: sunlight pours through the window onto the area just inside
    //    it and the floor below. A closed window (curtains) blocks most of it.
    const sunHeat = sun * 8.0 * dt * (0.2 + 0.8 * open);
    if (sun > 0) {
      const ci = left ? 8 : N - 8;
      for (let j = 2; j <= this.winB; j++) {
        for (let d = 1; d <= 12; d++) {
          const i = left ? 1 + d : N - d;
          const fall = (1 - d / 13) * (j <= this.winA ? 0.5 : 1);
          f.T0[idx(i, j)] += sunHeat * Math.max(0.15, fall) * 0.4;
        }
      }
    }

    // 4) buoyancy: warm air rises, cool air sinks. Force on the vertical (v)
    //    velocity is proportional to how much warmer a cell is than the room
    //    average. This is what fluid.js needs to make convection plausible.
    const ref = this.indoorAvg || 24;
    const BUOY = 2.2;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const k = idx(i, j);
        if (f.solid[k]) continue;
        const dT = f.T[k] - ref;
        f.v0[k] += BUOY * Math.max(-3, Math.min(3, dT)) * dt;
      }
    }

    // 5) ambient internal gain near the floor (appliances, a warm body).
    const baseGain = 0.02 * dt;
    for (let i = Math.floor(N * 0.2); i <= Math.floor(N * 0.8); i++) {
      f.T0[idx(i, 2)] += baseGain;
    }

    // 6) appliances (fridge) dump heat into open cells around their floor box.
    const cpu = N / this.scene.roomSize;
    for (const item of this.furniture) {
      if (!item.heat) continue;
      const hw = Math.round((item.w * cpu) / 2) + 1;
      const hh = Math.round(item.hCells) + 1;
      for (let j = 1; j <= hh; j++) {
        for (let i = item.gi - hw; i <= item.gi + hw; i++) {
          if (i < 1 || i > N || j > N) continue;
          const k = idx(i, j);
          if (!f.solid[k]) f.T0[k] += 2.2 * dt;
        }
      }
    }
  }

  // Rebuild the obstacle mask. In the side view furniture sits on the floor, so
  // each piece blocks a column of cells from the floor up to its height.
  rebuildSolid() {
    const f = this.fluid;
    f.solid.fill(0);
    const cpu = N / this.scene.roomSize;
    for (const item of this.furniture) {
      const hw = (item.w * cpu) / 2;
      const top = Math.round(item.hCells);
      for (let j = 1; j <= Math.min(N, top); j++) {
        for (let i = Math.round(item.gi - hw); i <= Math.round(item.gi + hw); i++) {
          if (i >= 1 && i <= N && j >= 1 && j <= N) f.solid[i + (N + 2) * j] = 1;
        }
      }
    }
  }

  applyFans() {
    const f = this.fluid;
    for (const fan of this.fans) {
      const dirx = Math.sin(fan.angle);
      const dirz = Math.cos(fan.angle);
      // grid axes: i along world x, j along world z
      const strength = 16 * fan.power;
      const ci = fan.gi + dirx * 1.5;
      const cj = fan.gj + dirz * 1.5;
      // a short cone of impulse in front of the fan
      for (let r = 1; r <= 6; r++) {
        const spread = r * 0.5;
        for (let s = -2; s <= 2; s++) {
          const px = Math.round(ci + dirx * r - dirz * s * 0.6);
          const py = Math.round(cj + dirz * r + dirx * s * 0.6);
          if (px < 1 || px > N || py < 1 || py > N) continue;
          const w = (1 - r / 8) * (1 - Math.abs(s) / 3.2);
          f.addVelocity(px, py, dirx * strength * w, dirz * strength * w);
        }
      }
    }
  }

  step(dt) {
    // sources must be added before the solver consumes & clears them
    this.fluid.clearSources();
    this.applyBoundary(dt);
    this.applyFans();
    this.fluid.step(dt);
    this._score(dt);
  }

  _score(dt) {
    const f = this.fluid;
    const [u, v] = f.sampleVelocity(this.personGi, this.personGj);
    const speed = Math.hypot(u, v);                 // grid units / step
    const airSpeedMs = Math.min(4, speed * 22);     // rough m/s for display
    const airT = f.sampleTemp(this.personGi, this.personGj);

    // wind-chill style relief: only helps while air is cooler than skin; above
    // skin temperature a fan actually makes you feel hotter.
    let relief;
    if (airT < SKIN_TEMP) {
      relief = Math.min(4.5, airSpeedMs * 1.5) * ((SKIN_TEMP - airT) / 14);
    } else {
      relief = -Math.min(1.5, airSpeedMs * 0.4);
    }
    this.feelsLike = airT - relief;

    // average indoor air temp (interior cells)
    let sum = 0, n = 0;
    for (let j = 1; j <= N; j += 2) for (let i = 1; i <= N; i += 2) { sum += f.T[i + (N + 2) * j]; n++; }
    this.indoorAvg = sum / n;

    const off = Math.abs(this.feelsLike - COMFORT_TARGET);
    this.comfort = Math.max(0, 1 - off / COMFORT_BAND);  // 0..1
    this.score += this.comfort * dt;
    this.airSpeedMs = airSpeedMs;
    this.personAirT = airT;
  }

  toggleWindow() { this.windowOpen = !this.windowOpen; }
  setHour(h) { this.simHour = ((h % 24) + 24) % 24; }

  // --- main loop ------------------------------------------------------------

  frame(dt) {
    this._t += dt;
    if (this.autoClock) {
      this.simHour = (this.simHour + dt * this.timeScale * 0.4) % 24;
    }

    // run a couple of sub-steps for a livelier flow at low frame cost
    const sub = 2;
    for (let s = 0; s < sub; s++) this.step((dt / sub) * 1.2);

    // presentation
    const minT = this.outdoorTemp() - 6;
    const maxT = Math.max(this.outdoorTemp() + 8, 34);
    this.scene.updateHeat(this.fluid.T, minT, maxT);
    this.scene.updateParticles(this.fluid, dt);
    this.scene.setTimeOfDay(this.isDay(), 0.4 + this.sunStrength());
    this.scene.setWindowOpen(this.windowOpen);
    const hotness = Math.max(0, Math.min(1, (this.feelsLike - 24) / 8));
    this.scene.setCharacterHot(hotness);
    this.scene.update(dt, this._t);
    this.scene.render();

    this._emit();
  }

  _emit() {
    if (!this.onStats) return;
    this.onStats({
      outdoor: this.outdoorTemp(),
      indoor: this.indoorAvg,
      feelsLike: this.feelsLike,
      personAirT: this.personAirT,
      airSpeed: this.airSpeedMs || 0,
      comfort: this.comfort,
      score: this.score,
      hour: this.simHour,
      isDay: this.isDay(),
      windowOpen: this.windowOpen,
      windowWall: this.windowWall,
      fans: this.fans.length,
      maxFans: this.maxFans,
      furniture: this.furniture.length,
      maxFurniture: this.maxFurniture,
      mode: this.mode,
      furnitureType: this.furnitureType,
      selected: this.selected
        ? { angle: this.selected.angle, power: this.selected.power }
        : null,
      place: this.weather?.place,
      offline: this.weather?.offline,
    });
  }
}
