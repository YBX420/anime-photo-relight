# 🌬️ Fan Feng Shui

A chill little browser game for a sweltering British summer with **no air-con**.
You've only got fans — place them, aim them, arrange your furniture, and discover
the layout that keeps you coolest, by day and by night.

> Soft pastel **isometric 2D** visuals in the spirit of *Townscaper* (original
> art, not copied assets) · springy, casual feel · a real incompressible-fluid
> airflow simulation under the hood.

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

- 🖱️ **Fans tab:** tap the floor to drop a fan (up to 4). **Drag from a fan**
  to aim it; select one to tune its **power** or remove it.
- 🛋️ **Furniture tab:** place a shelf, table, cabinet or fridge. Furniture is a
  real **CFD obstacle** — it blocks and redirects airflow, so where you put it
  matters. The fridge also leaks heat. Tap a piece to remove it.
- 🪟 Toggle the **window** and choose which **wall** (back/left) it's on. At
  night, open it and blow cool outside air across the room. By day the sun heats
  the room through the glass — close up and let the breeze chill your skin.
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

## Visual style — soft 3D, Townscaper-inspired (2.5D)

Rendered in real 3D with [Three.js](https://threejs.org/) but framed from a
fixed, gently-angled near-isometric camera for that calm 2.5D Townscaper feel.
The look follows the techniques surfaced in a deep-research pass on Townscaper —
all recreated with original geometry and shading, **not** copied assets
([`src/scene.js`](src/scene.js)):

- **Curated, limited pastel palette** (Townscaper ships a 16-colour set) —
  soft terracotta / cream / sage / dusty blue / butter.
- **Soft, rounded, beveled forms** — every wall, floor and prop is a
  `RoundedBoxGeometry`; **no hard ink outlines** (the inverted-hull outline
  theory was specifically refuted for Townscaper).
- **Soft lighting & ambient occlusion** — bright hemisphere fill + a gentle key
  light with large-radius soft shadows, a cool bounce fill, ACES tone-mapping.
- **Island on soft water** under a day/night gradient sky.
- Airflow drawn as additive particles that glow only where air actually moves.

## Tech

Vanilla ES modules + [Three.js](https://threejs.org/) (vendored in `vendor/`, so
it runs fully offline — no build step). Weather from the free, key-less
[Open-Meteo](https://open-meteo.com/) API, with an offline fallback.

## Files

| file | what |
|------|------|
| `src/fluid.js`  | the stable-fluids CFD solver (velocity + temperature) |
| `src/game.js`   | weather → heat boundaries → fans/furniture → comfort scoring |
| `src/scene.js`  | Three.js soft-3D Townscaper-style renderer (room, props, heat, airflow) |
| `src/weather.js`| Open-Meteo fetch + geocoding, offline fallback |
| `src/ui.js`     | DOM controls and the main loop |
