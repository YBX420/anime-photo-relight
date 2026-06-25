// scene.js
// Three.js presentation layer. Cel-shaded ("三渲二" / toon) room, cheap inverted-
// hull outlines, a temperature heat-map on the floor, and GPU-light airflow
// particles advected by the fluid velocity field.

import * as THREE from 'three';

const TAU = Math.PI * 2;

// ----- toon helpers ---------------------------------------------------------

function gradientMap(steps = 4) {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) data[i] = Math.round((i / (steps - 1)) * 255);
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const OUTLINE_COLOR = 0x2a2433;

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.grad = gradientMap(4);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camAngle = Math.PI * 0.25;   // azimuth, stepped by view buttons
    this.camTargetAngle = this.camAngle;
    this.camHeight = 9;
    this.camDist = 13;

    this.fans = [];          // {group, blades, spinSpeed, popT, target}
    this.particles = null;
    this.partPos = null;     // grid-space particle state
    this.partLife = null;
    this.N = 64;
    this.roomSize = 8;       // world units across the room

    this._buildLights();
    this._buildEnv();
    this._buildRoom();
    this._buildHeatPlane();
    this._buildCharacter();

    this.raycaster = new THREE.Raycaster();
    this.resize();
  }

  // --- construction ---------------------------------------------------------

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffe9c4, 0x6b6f8a, 0.9);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff1d0, 1.2);
    this.sun.position.set(6, 11, 4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const d = 9;
    this.sun.shadow.camera.left = -d; this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d; this.sun.shadow.camera.bottom = -d;
    this.scene.add(this.sun);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.25);
    this.scene.add(this.ambient);
  }

  _buildEnv() {
    this.scene.background = new THREE.Color(0xcfe8ff);
    this.scene.fog = new THREE.Fog(0xcfe8ff, 22, 40);
  }

  // Cel-shaded material: banded diffuse (gradientMap) + a Fresnel rim light
  // injected via onBeforeCompile. Banding + outline + rim are the three
  // ingredients of the "三渲二" look.
  _toon(color, { emissive = 0x000000, rim = 0.45 } = {}) {
    const mat = new THREE.MeshToonMaterial({ color, emissive, gradientMap: this.grad });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.rimStrength = { value: rim };
      shader.uniforms.rimColor = { value: new THREE.Color(0xffffff) };
      shader.fragmentShader =
        'uniform float rimStrength;\nuniform vec3 rimColor;\n' +
        shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `float rimF = 1.0 - max(dot(normalize(normal), normalize(vViewPosition)), 0.0);
           rimF = smoothstep(0.55, 1.0, rimF);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb + rimColor, rimStrength * rimF);
           #include <dithering_fragment>`
        );
    };
    mat.customProgramCacheKey = () => 'toon-rim-v1';
    return mat;
  }

  _addOutline(mesh, scale = 1.05) {
    const o = new THREE.Mesh(
      mesh.geometry,
      new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide })
    );
    o.scale.setScalar(scale);
    o.raycast = () => {};
    mesh.add(o);
    return mesh;
  }

  _buildRoom() {
    const S = this.roomSize;
    const root = new THREE.Group();
    this.roomRoot = root;
    this.scene.add(root);

    // floor (toon wood-ish tile)
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(S, 0.3, S),
      this._toon(0xe7c9a0)
    );
    floor.position.y = -0.15;
    floor.receiveShadow = true;
    root.add(floor);

    // back + side walls (low so we can see in). Front-left is open to camera.
    const wallMat = this._toon(0xf3ece2);
    const wallH = 2.6, t = 0.25;
    const mkWall = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      m.position.set(x, y, z);
      m.castShadow = true; m.receiveShadow = true;
      root.add(m);
      return m;
    };
    // back wall (-z) with a window gap in the middle
    const half = S / 2;
    const winW = 3.2;
    mkWall((S - winW) / 2, wallH, t, -(winW / 2 + (S - winW) / 4), wallH / 2 - 0.15, -half);
    mkWall((S - winW) / 2, wallH, t, (winW / 2 + (S - winW) / 4), wallH / 2 - 0.15, -half);
    mkWall(winW, 0.6, t, 0, wallH - 0.45, -half); // lintel above window
    // left wall (-x)
    mkWall(t, wallH, S, -half, wallH / 2 - 0.15, 0);

    // window pane + frame in the back wall gap
    const winGroup = new THREE.Group();
    winGroup.position.set(0, 1.15, -half + 0.02);
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(winW + 0.2, 1.9, 0.12),
      this._toon(0xbfae98)
    );
    winGroup.add(frame);
    this.windowPane = new THREE.Mesh(
      new THREE.PlaneGeometry(winW - 0.1, 1.6),
      new THREE.MeshBasicMaterial({ color: 0xafe0ff, transparent: true, opacity: 0.45 })
    );
    this.windowPane.position.z = 0.07;
    winGroup.add(this.windowPane);
    // sun glow card behind the window, recoloured by time of day
    this.sunCard = new THREE.Mesh(
      new THREE.PlaneGeometry(winW + 1.4, 2.6),
      new THREE.MeshBasicMaterial({ color: 0xffe39a, transparent: true, opacity: 0.9 })
    );
    this.sunCard.position.set(0, 0.2, -0.4);
    winGroup.add(this.sunCard);
    root.add(winGroup);

    // a couch + plant so the room reads as a living room
    const couch = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 1.0), this._toon(0xd98c7a));
    couch.position.set(-2.0, 0.25, 2.3);
    couch.castShadow = true; this._addOutline(couch, 1.04);
    root.add(couch);
    const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.7, 0.3), this._toon(0xc97a68));
    back.position.set(-2.0, 0.55, 2.75); this._addOutline(back, 1.05);
    root.add(back);
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
      new THREE.MeshBasicMaterial({
        map: this.heatTex, transparent: true, opacity: 0.55, depthWrite: false,
      })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.02;
    plane.raycast = () => {};
    this.scene.add(plane);
    this.heatPlane = plane;
  }

  _buildCharacter() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.5, 6, 12), this._toon(0x7fb4e0));
    body.position.y = 0.55; body.castShadow = true; this._addOutline(body, 1.06);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 16), this._toon(0xffd9b8));
    head.position.y = 1.2; head.castShadow = true; this._addOutline(head, 1.06);
    g.add(body, head);
    // sweat drop that shows when hot
    this.sweat = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 10, 10),
      new THREE.MeshToonMaterial({ color: 0x6fc6ff, gradientMap: this.grad })
    );
    this.sweat.position.set(0.22, 1.28, 0.18);
    g.add(this.sweat);
    g.position.set(1.8, 0, 1.6);
    this.scene.add(g);
    this.character = g;
  }

  setCharacterGrid(gi, gj) {
    const [x, z] = this.gridToWorld(gi, gj);
    this.character.position.set(x, 0, z);
  }

  // --- coordinate mapping ---------------------------------------------------
  // grid 1..N  <->  world -S/2 .. S/2 on X and Z
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
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.12, 18), this._toon(0x4a5168));
    base.position.y = 0.06; base.castShadow = true;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 10), this._toon(0x6a7290));
    pole.position.y = 0.55;
    const headGroup = new THREE.Group();
    headGroup.position.y = 1.0;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.04, 10, 24), this._toon(0x9fa8c6));
    ring.rotation.y = Math.PI / 2;
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), this._toon(0xffd36e));
    hub.rotation.z = Math.PI / 2;
    const blades = new THREE.Group();
    for (let b = 0; b < 4; b++) {
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 0.5, 0.16),
        this._toon(0xbfe3ff, { emissive: 0x223344 })
      );
      blade.position.y = 0.0; blade.geometry.translate(0, 0.18, 0);
      blade.rotation.x = (b / 4) * TAU;
      blades.add(blade);
    }
    blades.rotation.y = Math.PI / 2;
    headGroup.add(ring, hub, blades);

    group.add(base, pole, headGroup);
    this._addOutline(base, 1.05);
    group.userData.headGroup = headGroup;

    const [x, z] = this.gridToWorld(gi, gj);
    group.position.set(x, 0, z);
    group.rotation.y = angle;
    group.scale.setScalar(0.01); // pop-in
    this.scene.add(group);

    const fan = { group, blades, gi, gj, angle, popT: 0, target: 1, power: 1 };
    this.fans.push(fan);
    return fan;
  }

  removeFan(fan) {
    this.scene.remove(fan.group);
    this.fans = this.fans.filter((f) => f !== fan);
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
        data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = 150;
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
      size: 0.09, transparent: true, opacity: 0.9, vertexColors: true,
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
      pos[p * 3 + 1] = 0.15 + Math.min(1.2, sp * 30) * 0.55;
      pos[p * 3 + 2] = z;
      // brightness tracks local airflow so only moving air glows (additive
      // blending makes near-zero brightness invisible). Tint cool blue→white.
      const b = Math.min(1, sp * 26) * Math.min(1, this.partLife[p] * 2.2);
      col[p * 3] = b * 0.7;
      col[p * 3 + 1] = b * 0.85;
      col[p * 3 + 2] = b;
    }
    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.geometry.attributes.color.needsUpdate = true;
  }

  // --- time of day ----------------------------------------------------------

  setTimeOfDay(isDay, sunStrength = 1) {
    if (isDay) {
      this.scene.background = new THREE.Color(0xbfe3ff);
      this.hemi.color.set(0xffe9c4); this.hemi.intensity = 0.95;
      this.sun.color.set(0xfff1d0); this.sun.intensity = 1.1 * sunStrength + 0.2;
      this.sunCard.material.color.set(0xffe39a);
      this.sunCard.material.opacity = 0.9 * sunStrength;
      this.scene.fog.color.set(0xbfe3ff);
    } else {
      this.scene.background = new THREE.Color(0x222a44);
      this.hemi.color.set(0x9fb0e0); this.hemi.intensity = 0.5;
      this.sun.color.set(0x9fb6ff); this.sun.intensity = 0.35;
      this.sunCard.material.color.set(0x3a4a8a);
      this.sunCard.material.opacity = 0.6;
      this.scene.fog.color.set(0x222a44);
    }
  }

  // --- camera / interaction -------------------------------------------------

  rotateView(dir) { this.camTargetAngle += dir * Math.PI / 2; }

  pickFloor(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    const S = this.roomSize / 2 - 0.3;
    if (Math.abs(hit.x) > S || Math.abs(hit.z) > S) return null;
    return this.worldToGrid(hit.x, hit.z);
  }

  pickFan(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    for (const fan of this.fans) {
      const hits = this.raycaster.intersectObject(fan.group, true);
      if (hits.length) return fan;
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
    // ease camera azimuth toward the stepped target (springy)
    this.camAngle += (this.camTargetAngle - this.camAngle) * Math.min(1, dt * 6);
    const a = this.camAngle;
    this.camera.position.set(
      Math.sin(a) * this.camDist,
      this.camHeight,
      Math.cos(a) * this.camDist
    );
    this.camera.lookAt(0, 0.8, 0);

    for (const fan of this.fans) {
      // springy pop-in scale
      fan.popT += (fan.target - fan.popT) * Math.min(1, dt * 10);
      const overshoot = 1 + Math.sin(Math.min(1, fan.popT) * Math.PI) * 0.12 * (fan.target);
      fan.group.scale.setScalar(fan.popT * overshoot);
      // spin blades by power
      fan.blades.rotation.x += dt * (4 + fan.power * 26);
    }

    // bob the character + sweat wobble
    if (this.character) {
      this.character.position.y = Math.sin(time * 2) * 0.03;
      if (this.sweat) {
        this.sweat.position.y = 1.28 + Math.sin(time * 3) * 0.02;
      }
    }
  }

  setCharacterHot(hotness) {
    // hotness 0..1 -> sweat visible, face redder
    if (this.sweat) this.sweat.visible = hotness > 0.45;
    const c = this.character?.children?.[1]; // head
    if (c && c.material) {
      c.material.color.lerpColors(
        new THREE.Color(0xffd9b8), new THREE.Color(0xff9a86), Math.max(0, hotness)
      );
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

// Cool→hot colormap (blue→cyan→green→yellow→red), returns [r,g,b] 0..255.
function heatColor(t) {
  const stops = [
    [0.0, [80, 140, 240]],
    [0.3, [90, 210, 210]],
    [0.5, [120, 220, 130]],
    [0.7, [245, 215, 90]],
    [1.0, [240, 90, 70]],
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
