# 🌬️ Fan Feng Shui

A chill little browser game for a sweltering British summer with **no air-con**.
You've only got fans — place them, aim them, and discover the layout that keeps
you coolest, by day and by night.

> Cel-shaded ("三渲二" / toon) visuals · springy, casual feel · a real
> incompressible-fluid airflow simulation under the hood.

## Play

It's a static site — just open `index.html` over HTTP (ES modules need a
server, not `file://`):

```bash
cd fan-cooling-game
python3 -m http.server 8099
# open http://localhost:8099
```

Three.js is vendored in `vendor/` so the game runs fully offline.

## How to play

- 🖱️ **Tap the floor** to drop a fan (up to 4). **Drag from a fan** to aim it.
- 🎚️ Select a fan to tune its **power**, rotate its aim, or remove it.
- 🪟 Toggle the **window**. At night, open it and blow cool outside air across
  the room. By day the sun heats the room through the glass — close up and let
  the breeze chill your skin instead.
- ☀️🌙 Scrub the **time of day** or let the clock run. Outdoor temperature,
  daylight and solar gain all change with the hour.
- 🌍 Type a **city** to pull that location's live temperature.

Your score ticks up the longer the spot where you're sitting stays close to a
comfortable "feels like" temperature.

## The physics (roughly right, not a thesis)

The airflow is a 2D **stable-fluids** solver (Jos Stam, 1999) running on a
64×64 top-down grid — see [`src/fluid.js`](src/fluid.js):

- **Incompressible & mass-conserving** velocity field via an iterative pressure
  projection — this is what gives believable recirculation and vortices rather
  than air just drifting in straight lines.
- **Semi-Lagrangian advection** (unconditionally stable) carries both momentum
  and the temperature field along the flow.
- **Viscous + thermal diffusion** via Gauss–Seidel relaxation.
- Fans inject a cone of momentum; walls reflect it; the window is an opening
  that exchanges air and heat with the outside.

Heat transfer is deliberately approximate ([`src/game.js`](src/game.js)):
wall conduction, window air exchange, a sunny floor patch whose intensity
follows the sun's elevation, and a small ambient internal gain. Comfort uses a
**wind-chill** model — moving air only cools you while it's below skin
temperature (~33 °C); blow air hotter than that and a fan actually makes you
feel *worse*, just like in real life.

## Visual style — cel shading

The "三渲二" look is built from the three classic ingredients
([`src/scene.js`](src/scene.js)):

1. **Banded diffuse** — `MeshToonMaterial` with a stepped gradient map.
2. **Ink outlines** — inverted-hull back-face pass.
3. **Rim light** — a Fresnel term injected into the toon shader.

## Tech

Vanilla ES modules + [Three.js](https://threejs.org/) (vendored). No build step.
Weather from the free, key-less [Open-Meteo](https://open-meteo.com/) API, with
an offline fallback so it always runs.

## Files

| file | what |
|------|------|
| `src/fluid.js` | the stable-fluids CFD solver (velocity + temperature) |
| `src/game.js`  | weather → heat boundaries → fans → comfort scoring |
| `src/scene.js` | Three.js cel-shaded room, heat-map floor, airflow particles |
| `src/weather.js` | Open-Meteo fetch + geocoding, offline fallback |
| `src/ui.js`    | DOM controls and the main loop |
