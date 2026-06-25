// ui.js — entry point. Wires DOM controls to the Game and runs the loop.
import { Game } from './game.js';
import { geocode } from './weather.js';

const canvas = document.getElementById('view');
const game = new Game(canvas);
window.game = game; // expose for debugging

// ---- HUD elements ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  outdoor: $('outdoor'), indoor: $('indoor'), feels: $('feels'),
  airspeed: $('airspeed'), comfortBar: $('comfortBar'), comfortPct: $('comfortPct'),
  score: $('score'), clock: $('clock'), place: $('place'), dayico: $('dayico'),
  fanCount: $('fanCount'), furnCount: $('furnCount'), winBtn: $('winBtn'),
  powerRow: $('powerRow'), power: $('power'), removeBtn: $('removeBtn'), tip: $('tip'),
};

function fmt(t) { return (Math.round(t * 10) / 10).toFixed(1); }
function clockStr(h) {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

game.onStats = (s) => {
  el.outdoor.textContent = fmt(s.outdoor) + '°';
  el.indoor.textContent = fmt(s.indoor) + '°';
  el.feels.textContent = fmt(s.feelsLike) + '°';
  el.airspeed.textContent = fmt(s.airSpeed) + ' m/s';
  const pct = Math.round(s.comfort * 100);
  el.comfortBar.style.width = pct + '%';
  el.comfortBar.style.background = `hsl(${pct * 1.2}, 75%, 55%)`;
  el.comfortPct.textContent = pct + '%';
  el.score.textContent = Math.floor(s.score);
  el.clock.textContent = clockStr(s.hour);
  el.dayico.textContent = s.isDay ? '☀️' : '🌙';
  el.place.textContent = (s.place || '—') + (s.offline ? ' (offline)' : '');
  el.fanCount.textContent = `${s.fans}/${s.maxFans}`;
  if (el.furnCount) el.furnCount.textContent = `${s.furniture}/${s.maxFurniture}`;
  el.winBtn.textContent = s.windowOpen ? '🪟 Window: OPEN' : '🪟 Window: CLOSED';
  el.winBtn.classList.toggle('on', s.windowOpen);
  if (s.selected) {
    el.powerRow.style.display = '';
    el.power.value = String(s.selected.power);
  } else {
    el.powerRow.style.display = 'none';
  }
};

// ---- pointer: place / select / aim-by-drag --------------------------------
let dragging = false;
function aimAt(clientX, clientY) {
  if (!game.selected) return;
  const cell = game.scene.pickFloor(clientX, clientY);
  if (!cell) return;
  const f = game.selected;
  const dx = cell[0] - f.gi, dz = cell[1] - f.gj;
  if (Math.hypot(dx, dz) < 1.2) return;
  f.angle = Math.atan2(dx, dz);
  game.scene.setFanAngle(f.sFan, f.angle);
}

canvas.addEventListener('pointerdown', (e) => {
  const res = game.pickAt(e.clientX, e.clientY);
  if (res) {
    dragging = true;
    hideTip();
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener('pointermove', (e) => { if (dragging) aimAt(e.clientX, e.clientY); });
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
});

// ---- buttons ---------------------------------------------------------------
$('rotL').onclick = () => game.rotateSelected(-Math.PI / 12);
$('rotR').onclick = () => game.rotateSelected(Math.PI / 12);
el.removeBtn.onclick = () => game.removeSelected();
el.winBtn.onclick = () => game.toggleWindow();
el.power.oninput = (e) => game.setSelectedPower(parseFloat(e.target.value));

// window-wall selector
function setWall(wall) {
  game.setWindowWall(wall);
  $('wallBack').classList.toggle('on', wall === 'back');
  $('wallLeft').classList.toggle('on', wall === 'left');
}
$('wallBack').onclick = () => setWall('back');
$('wallLeft').onclick = () => setWall('left');

// build-mode tabs
function setMode(mode) {
  game.setMode(mode);
  $('tabFan').classList.toggle('on', mode === 'fan');
  $('tabFurn').classList.toggle('on', mode === 'furniture');
  $('fanPanel').style.display = mode === 'fan' ? '' : 'none';
  $('furnPanel').style.display = mode === 'furniture' ? '' : 'none';
}
$('tabFan').onclick = () => setMode('fan');
$('tabFurn').onclick = () => setMode('furniture');

// furniture picker
document.querySelectorAll('.furn').forEach((btn) => {
  btn.onclick = () => {
    game.setFurnitureType(btn.dataset.furn);
    document.querySelectorAll('.furn').forEach((b) => b.classList.toggle('on', b === btn));
  };
});

// time controls
const timeSlider = $('time');
timeSlider.oninput = (e) => { game.autoClock = false; game.setHour(parseFloat(e.target.value)); };
$('autoClock').onclick = (e) => {
  game.autoClock = !game.autoClock;
  e.target.classList.toggle('on', game.autoClock);
  e.target.textContent = game.autoClock ? '⏩ Time: AUTO' : '⏯ Time: MANUAL';
};

// keep slider synced when the clock auto-advances
setInterval(() => { if (game.autoClock) timeSlider.value = String(game.simHour); }, 250);

// location search
$('locForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('locInput').value.trim();
  if (!q) return;
  $('locStatus').textContent = '…';
  try {
    const loc = await geocode(q);
    await game.loadWeather({ latitude: loc.latitude, longitude: loc.longitude, place: loc.name });
    timeSlider.value = String(game.simHour);
    $('locStatus').textContent = '✓';
  } catch (err) {
    $('locStatus').textContent = '✗ not found';
  }
};

function hideTip() { if (el.tip) el.tip.classList.add('hidden'); }

// ---- boot ------------------------------------------------------------------
window.addEventListener('resize', () => game.scene.resize());

// Load real weather in the background — never block the game on the network.
game.loadWeather({ place: 'London, UK' }).then(() => {
  timeSlider.value = String(game.simHour);
});

let last = performance.now();
function loop(now) {
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(0.05, Math.max(0.001, dt));
  try {
    game.frame(dt);
  } catch (err) {
    console.error('[frame]', err && err.stack || err);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
