# 🌬️ Fan Feng Shui

A chill little browser game for a sweltering British summer with **no air-con**.
You've only got fans — place them, aim them, arrange your furniture, and discover
the layout that keeps you coolest, by day and by night.

> A flat, hand-illustrated **2D side-on** look (a storybook cross-section of the
> room) · cozy pastel palette · a real incompressible-fluid airflow simulation
> with buoyancy under the hood. All art is original drawing code.

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
64×64 grid read as a vertical slice of the room — see [`src/fluid.js`](src/fluid.js):

- **Incompressible & mass-conserving** velocity field via an iterative pressure
  projection — this is what gives believable recirculation and vortices rather
  than air just drifting in straight lines.
- **Semi-Lagrangian advection** (unconditionally stable) carries both momentum
  and the temperature field along the flow.
- **Viscous + thermal diffusion** via Gauss–Seidel relaxation.
- **Buoyancy**: warm cells get an upward force and cool cells a downward one, so
  hot air rises to the ceiling and cool window air sinks across the floor —
  visible convection currents.
- Fans inject a cone of momentum; walls reflect it; the side-wall window is an
  opening that exchanges air and heat with the outside.

Heat transfer is deliberately approximate ([`src/game.js`](src/game.js)):
wall conduction, window air exchange, a sunny floor patch whose intensity
follows the sun's elevation, and a small ambient internal gain. Comfort uses a
**wind-chill** model — moving air only cools you while it's below skin
temperature (~33 °C); blow air hotter than that and a fan actually makes you
feel *worse*, just like in real life.

## Visual style — flat 2D side-on illustration

Everything is drawn on a plain 2D `<canvas>` as a flat, hand-illustrated
cross-section of the room — floor at the bottom, ceiling on top, walls at the
sides, a window looking out to the sky. Flat front-facing shapes, clean soft
outlines, at most two tones, no 3D face shading ([`src/scene2d.js`](src/scene2d.js)):

- The CFD grid is read as a **vertical slice** (x across, height up), so the
  temperature field and airflow map straight onto the picture.
- Furniture, fans and the character are flat illustrated props with rounded
  silhouettes; a cozy house sits on grass under a day/night sky.
- Airflow is drawn as soft **streaks** along the local flow direction, so you can
  see warm air rise, cool window air sink, and the fan's jet swirl.

## Tech

Vanilla ES modules + 2D Canvas. **No build step, no dependencies.** Weather from
the free, key-less [Open-Meteo](https://open-meteo.com/) API, with an offline
fallback so it always runs.

## Files

| file | what |
|------|------|
| `src/fluid.js`   | the stable-fluids CFD solver (velocity + temperature) |
| `src/game.js`    | weather → heat boundaries → fans/furniture → comfort scoring |
| `src/scene2d.js` | isometric 2D Townscaper-style renderer (room, heat, airflow) |
| `src/weather.js` | Open-Meteo fetch + geocoding, offline fallback |
| `src/ui.js`      | DOM controls and the main loop |
