// scene.js
// Presentation layer in the spirit of *Townscaper*: soft pastel palette, smooth
// matte (Lambert) shading with no hard ink outlines, gently rounded forms, soft
// shadows, a clean gradient sky and filmic tone-mapping. On top of that it draws
// a temperature heat-map on the floor and airflow particles advected by the
// fluid velocity field.

import * as THREE from 'three';
import { RoundedBoxGeometry } from '../vendor/addons/RoundedBoxGeometry.js';

const TAU = Math.PI * 2;

// Curated, harmonious pastel palette in the spirit of Townscaper's limited
// 16-colour set (soft terracotta / cream / sage / dusty blue / butter yellow).
const PAL = {
  floor:   0xf0dcb4,
  wall:    0xf5ecd9,
  wallTop: 0xfcf6ea,
  couch:   0xe79a7d,
  couchB:  0xd9836a,
  plant:   0x8cba84,
  pot:     0xd98c63,
  skin:    0xffdcb8,
  body:    0x8cb4e4,
  fanBody: 0xaeb7d6,
  fanBlade:0xe8f1ff,
  fanHub:  0xf5c869,
  island:  0xe7c89c,
  islandB: 0xd6b07f,
  water:   0x9bd3cf,
  // furniture
  shelf:   0xcfa87e,
  table:   0xddb787,
  fridge:  0xeef1f4,
  cabinet: 0xd2a07a,
};

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camAngle = Math.PI * 0.22;
    this.camTargetAngle = this.camAngle;
    this.camHeight = 9.5;
    this.camDist = 14;

    this.fans = [];
    this.furnitureItems = [];
    this.particles = null;
    this.N = 64;
    this.roomSize = 8;

    this._skies = {
      day: makeSky(0x9fd2ff, 0xeaf7ff),
      night: makeSky(0x232b4d, 0x46507e),
    };

    this._buildLights();
    this._buildEnv();
    this._buildIsland();
    this._buildRoom();
    this._buildHeatPlane();
    this._buildCharacter();

    this.raycaster = new THREE.Raycaster();
    this.resize();
  }

  // --- lighting & environment ----------------------------------------------

  _buildLights() {
    // bright soft sky/ground fill — the backbone of the Townscaper softness
    this.hemi = new THREE.HemisphereLight(0xdcefff, 0xf3e2c4, 1.15);
    this.scene.add(this.hemi);

    // gentle key light with soft shadows
    this.sun = new THREE.DirectionalLight(0xfff3df, 1.35);
    this.sun.position.set(7, 13, 6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 5;
    this.sun.shadow.bias = -0.0004;
    const d = 10;
    Object.assign(this.sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 40 });
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // a cool bounce from the opposite side keeps shadows from going muddy
    this.fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
    this.fill.position.set(-6, 5, -5);
    this.scene.add(this.fill);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(this.ambient);
  }

  _buildEnv() {
    this.scene.background = this._skies.day;
    this.scene.fog = new THREE.Fog(0xeaf7ff, 26, 52);
  }

  _soft(color, { emissive = 0x000000 } = {}) {
    return new THREE.MeshLambertMaterial({ color, emissive });
  }

  _round(w, h, d, r = 0.12) {
    return new RoundedBoxGeometry(w, h, d, 3, Math.min(r, Math.min(w, h, d) / 2 - 0.001));
  }

  _mesh(geo, mat, { cast = true, recv = true } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast; m.receiveShadow = recv;
    return m;
  }

  // --- island base (sits on soft water, like Townscaper) --------------------

  _buildIsland() {
    const S = this.roomSize;
    const base = this._mesh(this._round(S + 1.4, 1.4, S + 1.4, 0.5), this._soft(PAL.island));
    base.position.y = -0.9;
    this.scene.add(base);
    const lip = this._mesh(this._round(S + 2.2, 0.5, S + 2.2, 0.5), this._soft(PAL.islandB));
    lip.position.y = -1.5;
    this.scene.add(lip);

    const water = new THREE.Mesh(
      new THREE.CircleGeometry(60, 48),
      new THREE.MeshLambertMaterial({ color: PAL.water, transparent: true, opacity: 0.92 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -1.9;
    water.receiveShadow = true;
    this.water = water;
    this.scene.add(water);
  }

  _buildRoom() {
    const S = this.roomSize;
    const root = new THREE.Group();
    this.roomRoot = root;
    this.scene.add(root);

    // floor
    const floor = this._mesh(this._round(S, 0.3, S, 0.08), this._soft(PAL.floor));
    floor.position.y = -0.15;
    floor.castShadow = false;
    root.add(floor);

    const wallMat = this._soft(PAL.wall);
    const wallH = 2.6, t = 0.28, half = S / 2;
    const winW = 3.2;
    // solid back (-z) and left (-x) walls; front/right open to the camera
    const backWall = this._mesh(this._round(S, wallH, t, 0.1), wallMat);
    backWall.position.set(0, wallH / 2 - 0.15, -half);
    root.add(backWall);
    const leftWall = this._mesh(this._round(t, wallH, S, 0.1), wallMat);
    leftWall.position.set(-half, wallH / 2 - 0.15, 0);
    root.add(leftWall);

    // a movable window/door pane (built facing -z); setWindowWall() repositions it
    const winGroup = new THREE.Group();
    winGroup.add(this._mesh(this._round(winW + 0.2, 1.9, 0.16, 0.05), this._soft(PAL.wallTop), { recv: false }));
    this.windowPane = new THREE.Mesh(
      new THREE.PlaneGeometry(winW - 0.1, 1.6),
      new THREE.MeshBasicMaterial({ color: 0xcfeeff, transparent: true, opacity: 0.3 })
    );
    this.windowPane.position.z = 0.1;
    winGroup.add(this.windowPane);
    this.sunCard = new THREE.Mesh(
      new THREE.PlaneGeometry(winW + 1.6, 2.8),
      new THREE.MeshBasicMaterial({ color: 0xfff0c4, transparent: true, opacity: 0.9 })
    );
    this.sunCard.position.set(0, 0.2, -0.45);
    winGroup.add(this.sunCard);
    root.add(winGroup);
    this.windowGroup = winGroup;
    this.windowHalf = half;
    this.setWindowWall('back');

    // couch
    const couch = this._mesh(this._round(2.4, 0.7, 1.0, 0.22), this._soft(PAL.couch));
    couch.position.set(-2.0, 0.22, 2.3);
    root.add(couch);
    const back = this._mesh(this._round(2.4, 0.7, 0.32, 0.16), this._soft(PAL.couchB));
    back.position.set(-2.0, 0.5, 2.75);
    root.add(back);
    const cushion = this._mesh(this._round(1.0, 0.25, 0.8, 0.12), this._soft(0xf2b89e));
    cushion.position.set(-2.5, 0.6, 2.3);
    root.add(cushion);

    // potted plant
    const pot = this._mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.45, 18), this._soft(PAL.pot));
    pot.position.set(2.9, 0.22, 2.9);
    root.add(pot);
    for (let i = 0; i < 3; i++) {
      const leaf = this._mesh(new THREE.SphereGeometry(0.34 - i * 0.06, 14, 12), this._soft(PAL.plant));
      leaf.position.set(2.9 + (i - 1) * 0.18, 0.7 + i * 0.22, 2.9);
      leaf.scale.y = 1.3;
      root.add(leaf);
    }
    // soft rug to ground the scene
    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(1.7, 36),
      new THREE.MeshLambertMaterial({ color: 0xf4c9b0, transparent: true, opacity: 0.9 })
    );
    rug.rotation.x = -Math.PI / 2; rug.position.set(0.4, 0.012, 1.0);
    rug.receiveShadow = true;
    root.add(rug);
  }

  _buildHeatPlane() {
    this.heatTex = new THREE.DataTexture(
      new Uint8Array(this.N * this.N * 4), this.N, this.N, THREE.RGBAFormat
    );
    this.heatTex.minFilter = THREE.LinearFilter;
    this.heatTex.magFilter = THREE.LinearFilter;
    this.heatTex.needsUpdate = true;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(this.roomSize, this.roomSize),
      new THREE.MeshBasicMaterial({ map: this.heatTex, transparent: true, opacity: 0.4, depthWrite: false })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.02;
    plane.raycast = () => {};
    this.scene.add(plane);
    this.heatPlane = plane;
  }

  _buildCharacter() {
    const g = new THREE.Group();
    const body = this._mesh(new THREE.CapsuleGeometry(0.32, 0.5, 8, 16), this._soft(PAL.body));
    body.position.y = 0.55;
    const head = this._mesh(new THREE.SphereGeometry(0.3, 20, 18), this._soft(PAL.skin));
    head.position.y = 1.2;
    g.add(body, head);
    this.sweat = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 12, 12),
      new THREE.MeshLambertMaterial({ color: 0x7fd0ff, emissive: 0x113344 })
    );
    this.sweat.position.set(0.22, 1.28, 0.18);
    this.sweat.visible = false;
    g.add(this.sweat);
    g.position.set(1.8, 0, 1.6);
    this.scene.add(g);
    this.character = g;
    this.headMesh = head;
  }

  setCharacterGrid(gi, gj) {
    const [x, z] = this.gridToWorld(gi, gj);
    this.character.position.set(x, 0, z);
  }

  // Move the window to the back (-z) or left (-x) wall.
  setWindowWall(wall) {
    const g = this.windowGroup, h = this.windowHalf;
    if (wall === 'left') { g.position.set(-h + 0.06, 1.15, 0); g.rotation.y = Math.PI / 2; }
    else { g.position.set(0, 1.15, -h + 0.06); g.rotation.y = 0; }
  }

  setWindowOpen(open) {
    this.windowPane.material.opacity = open ? 0.12 : 0.5;
  }

  // --- furniture (rounded soft props; CFD obstacles via game.rebuildSolid) ---

  createFurniture(type, gi, gj) {
    const specs = {
      shelf:   { w: 1.4, d: 0.5, h: 2.0, color: PAL.shelf },
      table:   { w: 1.6, d: 1.0, h: 0.8, color: PAL.table },
      cabinet: { w: 1.1, d: 0.6, h: 1.3, color: PAL.cabinet },
      fridge:  { w: 1.0, d: 0.9, h: 2.2, color: PAL.fridge, heat: true },
    };
    const s = specs[type] || specs.cabinet;
    const g = new THREE.Group();
    const body = this._mesh(this._round(s.w, s.h, s.d, 0.12), this._soft(s.color));
    body.position.y = s.h / 2;
    g.add(body);
    if (type === 'shelf') {
      for (let k = 1; k <= 2; k++) {
        const shelf = this._mesh(this._round(s.w * 0.92, 0.06, s.d * 0.86, 0.02), this._soft(shade2(s.color, 1.08)));
        shelf.position.y = (s.h * k) / 3; g.add(shelf);
      }
    } else if (type === 'fridge') {
      const line = this._mesh(this._round(s.w * 1.01, 0.04, s.d * 0.7, 0.01), this._soft(0xcdd6df));
      line.position.set(0, s.h * 0.62, s.d * 0.2); g.add(line);
    }
    const [x, z] = this.gridToWorld(gi, gj);
    g.position.set(x, 0, z);
    g.scale.setScalar(0.01);
    this.scene.add(g);
    const item = { group: g, type, gi, gj, w: s.w, d: s.d, hCells: s.h, heat: !!s.heat, popT: 0 };
    this.furnitureItems.push(item);
    return item;
  }

  removeFurniture(item) {
    this.scene.remove(item.group);
    this.furnitureItems = this.furnitureItems.filter((f) => f !== item);
  }

  pickFurniture(clientX, clientY) {
    this.raycaster.setFromCamera(this._ndc(clientX, clientY), this.camera);
    for (const it of this.furnitureItems) {
      if (this.raycaster.intersectObject(it.group, true).length) return it;
    }
    return null;
  }

  // --- coordinate mapping ---------------------------------------------------
  gridToWorld(gi, gj) {
    const S = this.roomSize, N = this.N;
    return [((gi - 0.5) / N - 0.5) * S, ((gj - 0.5) / N - 0.5) * S];
  }
  worldToGrid(x, z) {
    const S = this.roomSize, N = this.N;
    return [((x / S) + 0.5) * N + 0.5, ((z / S) + 0.5) * N + 0.5];
  }

  // --- fans -----------------------------------------------------------------

  createFan(gi, gj, angle) {
    const group = new THREE.Group();
    const base = this._mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.14, 20), this._soft(PAL.fanBody));
    base.position.y = 0.07;
    const pole = this._mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 12), this._soft(PAL.fanBody));
    pole.position.y = 0.55;
    const headGroup = new THREE.Group();
    headGroup.position.y = 1.0;
    const ring = this._mesh(new THREE.TorusGeometry(0.34, 0.045, 12, 28), this._soft(0xc2cbe6));
    ring.rotation.y = Math.PI / 2;
    const hub = this._mesh(new THREE.SphereGeometry(0.1, 14, 14), this._soft(PAL.fanHub));
    const blades = new THREE.Group();
    for (let b = 0; b < 4; b++) {
      const blade = this._mesh(this._round(0.03, 0.5, 0.17, 0.04), this._soft(PAL.fanBlade));
      blade.geometry.translate(0, 0.18, 0);
      blade.rotation.x = (b / 4) * TAU;
      blades.add(blade);
    }
    blades.rotation.y = Math.PI / 2;
    headGroup.add(ring, hub, blades);
    group.add(base, pole, headGroup);

    const [x, z] = this.gridToWorld(gi, gj);
    group.position.set(x, 0, z);
    group.rotation.y = angle;
    group.scale.setScalar(0.01);
    this.scene.add(group);

    const fan = { group, blades, gi, gj, angle, popT: 0, target: 1, power: 1 };
    this.fans.push(fan);
    return fan;
  }

  removeFan(fan) {
    fan.dying = true;
    this.fans = this.fans.filter((f) => f !== fan);
    this.scene.remove(fan.group);
  }

  setFanAngle(fan, angle) {
    fan.angle = angle;
    fan.group.rotation.y = angle;
  }

  // --- heat-map + particles -------------------------------------------------

  updateHeat(Tfield, minT, maxT) {
    const N = this.N;
    const data = this.heatTex.image.data;
    const span = Math.max(0.01, maxT - minT);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const t = (Tfield[(i + 1) + (N + 2) * (j + 1)] - minT) / span;
        const [r, g, b] = heatColor(Math.max(0, Math.min(1, t)));
        const k = (i + j * N) * 4;
        data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = 120;
      }
    }
    this.heatTex.needsUpdate = true;
  }

  initParticles(count = 1400) {
    const N = this.N;
    this.partCount = count;
    this.partPos = new Float32Array(count * 2);
    this.partLife = new Float32Array(count);
    const positions = new Float32Array(count * 3);
    for (let p = 0; p < count; p++) {
      this.partPos[p * 2] = 1 + Math.random() * (N - 1);
      this.partPos[p * 2 + 1] = 1 + Math.random() * (N - 1);
      this.partLife[p] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const mat = new THREE.PointsMaterial({
      size: 0.1, transparent: true, opacity: 0.95, vertexColors: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.particles = new THREE.Points(geo, mat);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  }

  updateParticles(fluid, dt) {
    if (!this.particles) return;
    const N = this.N;
    const pos = this.particles.geometry.attributes.position.array;
    const col = this.particles.geometry.attributes.color.array;
    for (let p = 0; p < this.partCount; p++) {
      let gi = this.partPos[p * 2];
      let gj = this.partPos[p * 2 + 1];
      const [u, v] = fluid.sampleVelocity(gi, gj);
      const sp = Math.hypot(u, v);
      gi += u * dt * N * 0.9;
      gj += v * dt * N * 0.9;
      this.partLife[p] -= dt * (0.25 + sp * 8);
      const solid = fluid.solid[Math.round(gi) + (N + 2) * Math.round(gj)];
      if (this.partLife[p] <= 0 || gi < 1 || gi > N || gj < 1 || gj > N || solid) {
        gi = 1 + Math.random() * (N - 1);
        gj = 1 + Math.random() * (N - 1);
        this.partLife[p] = 0.5 + Math.random() * 0.8;
      }
      this.partPos[p * 2] = gi;
      this.partPos[p * 2 + 1] = gj;
      const [x, z] = this.gridToWorld(gi, gj);
      pos[p * 3] = x;
      pos[p * 3 + 1] = 0.18 + Math.min(1.2, sp * 30) * 0.55;
      pos[p * 3 + 2] = z;
      // sharp speed threshold so still air is fully invisible (no speckle);
      // only moving streams glow.
      let b = sp * 34 - 0.5;
      b = b < 0 ? 0 : Math.min(1, b);
      b *= Math.min(1, this.partLife[p] * 2.2);
      col[p * 3] = b * 0.78; col[p * 3 + 1] = b * 0.9; col[p * 3 + 2] = b;
    }
    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.geometry.attributes.color.needsUpdate = true;
  }

  // --- time of day ----------------------------------------------------------

  setTimeOfDay(isDay, sunStrength = 1) {
    if (isDay) {
      this.scene.background = this._skies.day;
      this.scene.fog.color.set(0xeaf7ff);
      this.hemi.color.set(0xdcefff); this.hemi.groundColor.set(0xf3e2c4); this.hemi.intensity = 1.05 + 0.25 * sunStrength;
      this.sun.color.set(0xfff3df); this.sun.intensity = 0.7 + 0.9 * sunStrength;
      this.ambient.intensity = 0.35;
      this.sunCard.material.color.set(0xfff0c4); this.sunCard.material.opacity = 0.9 * sunStrength;
      this.water.material.color.set(PAL.water);
    } else {
      this.scene.background = this._skies.night;
      this.scene.fog.color.set(0x2a3358);
      this.hemi.color.set(0xb6c4f0); this.hemi.groundColor.set(0x6a6f95); this.hemi.intensity = 0.6;
      this.sun.color.set(0xb9c8ff); this.sun.intensity = 0.3;
      this.ambient.intensity = 0.28;
      this.sunCard.material.color.set(0x3a4a8a); this.sunCard.material.opacity = 0.55;
      this.water.material.color.set(0x4a6f8c);
    }
  }

  // --- camera / interaction -------------------------------------------------

  rotateView(dir) { this.camTargetAngle += dir * Math.PI / 2; }

  _ndc(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  pickFloor(clientX, clientY) {
    this.raycaster.setFromCamera(this._ndc(clientX, clientY), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    const S = this.roomSize / 2 - 0.3;
    if (Math.abs(hit.x) > S || Math.abs(hit.z) > S) return null;
    return this.worldToGrid(hit.x, hit.z);
  }

  pickFan(clientX, clientY) {
    this.raycaster.setFromCamera(this._ndc(clientX, clientY), this.camera);
    for (const fan of this.fans) {
      if (this.raycaster.intersectObject(fan.group, true).length) return fan;
    }
    return null;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // --- per-frame ------------------------------------------------------------

  update(dt, time) {
    this.camAngle += (this.camTargetAngle - this.camAngle) * Math.min(1, dt * 6);
    const a = this.camAngle;
    this.camera.position.set(Math.sin(a) * this.camDist, this.camHeight, Math.cos(a) * this.camDist);
    this.camera.lookAt(0, 0.7, 0);

    for (const fan of this.fans) {
      fan.popT += (fan.target - fan.popT) * Math.min(1, dt * 10);
      const overshoot = 1 + Math.sin(Math.min(1, fan.popT) * Math.PI) * 0.12;
      fan.group.scale.setScalar(Math.max(0.001, fan.popT * overshoot));
      fan.blades.rotation.x += dt * (4 + fan.power * 26);
    }

    for (const it of this.furnitureItems) {
      it.popT += (1 - it.popT) * Math.min(1, dt * 12);
      const o = 1 + Math.sin(Math.min(1, it.popT) * Math.PI) * 0.1;
      it.group.scale.setScalar(Math.max(0.001, it.popT * o));
    }

    if (this.character) {
      this.character.position.y = Math.sin(time * 2) * 0.03;
      if (this.sweat) this.sweat.position.y = 1.28 + Math.sin(time * 3) * 0.02;
    }
  }

  setCharacterHot(hotness) {
    if (this.sweat) this.sweat.visible = hotness > 0.45;
    if (this.headMesh) {
      this.headMesh.material.color.lerpColors(
        new THREE.Color(PAL.skin), new THREE.Color(0xff9a86), Math.max(0, Math.min(1, hotness))
      );
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

// lighten/darken a hex colour number → hex number
function shade2(n, f) {
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (f >= 1) { const t = f - 1; r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t; }
  else { r *= f; g *= f; b *= f; }
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

// vertical gradient sky as a CanvasTexture used for scene.background
function makeSky(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#' + top.toString(16).padStart(6, '0'));
  g.addColorStop(1, '#' + bottom.toString(16).padStart(6, '0'));
  ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Cool→hot colormap, softened to pastel tones to suit the palette.
function heatColor(t) {
  const stops = [
    [0.0, [120, 170, 235]],
    [0.35, [130, 210, 205]],
    [0.55, [165, 220, 150]],
    [0.75, [245, 210, 120]],
    [1.0, [240, 120, 105]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (t <= b) {
      const f = (t - a) / (b - a);
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * f),
        Math.round(ca[1] + (cb[1] - ca[1]) * f),
        Math.round(ca[2] + (cb[2] - ca[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}
