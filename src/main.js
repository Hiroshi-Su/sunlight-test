import config from '../config/site.json';
import { resolveSite, solarState } from './solar.js';
import { skyColors, kelvinAt, kelvinToRgb } from './palette.js';
import { createScreen, NOISE_PERIOD } from './screen.js';
import { drawPlan, drawDayChart, drawScreenOverlay } from './diagram.js';

const W = 3840, H = 1080;
const params = new URLSearchParams(location.search);
const site = resolveSite(config, params.get('site') ?? config.activeSite);
const declination = config.sites[site.name].screen.magneticDeclination;
const offsetMs = site.utcOffsetMinutes * 60000;

const $ = (id) => document.getElementById(id);
const screen = createScreen($('screen'), W, H);

const state = {
  utcMs: Date.now(),
  live: true,
  playing: false,
  speed: 600,
  lit: 0,
  pathDay: null,
  path: [],
};

// 現地時刻（UTC オフセットは config 由来。PC のタイムゾーンには依存しない）
const localParts = (utcMs) => {
  const d = new Date(utcMs + offsetMs);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const utcFromLocal = (y, mo, d, min) => Date.UTC(y, mo, d, 0, min) - offsetMs;
const pad2 = (n) => String(n).padStart(2, '0');

function dayPath(utcMs) {
  const { y, mo, d } = localParts(utcMs);
  const key = `${y}-${mo}-${d}`;
  if (state.pathDay === key) return state.path;
  state.pathDay = key;
  state.path = [];
  for (let min = 0; min <= 1440; min += 10) {
    const { sun, light } = solarState(new Date(utcFromLocal(y, mo, d, min)), site);
    state.path.push({ min, az: sun.azimuth, alt: sun.altitude, enters: light.entersWindow });
  }
  return state.path;
}

function setLive(on) {
  state.live = on;
  $('now').classList.toggle('on', on);
  if (on) { state.playing = false; $('play').textContent = '▶'; }
}

$('now').addEventListener('click', () => setLive(true));
$('play').addEventListener('click', () => {
  setLive(false);
  state.playing = !state.playing;
  $('play').textContent = state.playing ? '❚❚' : '▶';
});
$('speed').addEventListener('change', (e) => { state.speed = Number(e.target.value); });
$('time').addEventListener('input', (e) => {
  setLive(false);
  const { y, mo, d } = localParts(state.utcMs);
  state.utcMs = utcFromLocal(y, mo, d, Number(e.target.value));
});
$('date').addEventListener('change', (e) => {
  if (!e.target.value) return;
  setLive(false);
  const [y, mo, d] = e.target.value.split('-').map(Number);
  state.utcMs = utcFromLocal(y, mo - 1, d, localParts(state.utcMs).min);
});
$('showOverlay').addEventListener('change', (e) => { $('overlay').hidden = !e.target.checked; });
$('showStripes').addEventListener('change', (e) => { screen.uniforms.uStripes.value = e.target.checked ? 1 : 0; });

function renderHud(s) {
  const { sun, light } = s;
  const lp = localParts(state.utcMs);
  const secs = new Date(state.utcMs + offsetMs).getUTCSeconds();
  $('clock').textContent = `${lp.y}-${pad2(lp.mo + 1)}-${pad2(lp.d)}  ${pad2(Math.floor(lp.min / 60))}:${pad2(lp.min % 60)}:${pad2(secs)}  (UTC${site.utcOffsetMinutes >= 0 ? '+' : ''}${site.utcOffsetMinutes / 60})`;
  if (document.activeElement !== $('time')) $('time').value = lp.min;
  if (document.activeElement !== $('date')) $('date').value = `${lp.y}-${pad2(lp.mo + 1)}-${pad2(lp.d)}`;

  const screenAngle = Math.atan2(light.dirY, light.dirX) * 180 / Math.PI;
  const rows = [
    ['場所', `${site.label}（${site.name}）`],
    ['緯度 / 経度', `${site.latitude.toFixed(5)} / ${site.longitude.toFixed(5)}`],
    ['スクリーン向き（真北）', `${site.facingAzimuth.toFixed(1)}°`],
    ['窓の外向き（真北）', `${site.windowAzimuth.toFixed(1)}°（${site.windowSide === 'right' ? '右' : '左'}）`],
    ['太陽 方位角', `${sun.azimuth.toFixed(2)}°`],
    ['太陽 高度', `${sun.altitude.toFixed(2)}°`],
    ['赤緯', `${sun.declination.toFixed(2)}°`],
    ['均時差', `${sun.equationOfTime.toFixed(2)} 分`],
    ['light x（右+）', light.x.toFixed(3)],
    ['light y（上+）', light.y.toFixed(3)],
    ['light z（奥+）', light.z.toFixed(3)],
    ['画面内の光の角度', `${screenAngle.toFixed(1)}°`],
    ['窓への入射 cos', light.windowIncidence.toFixed(3)],
    ['窓から光が入る', light.entersWindow ? '<span class="yes">入る</span>' : '入らない'],
    ['色温度（目安）', `${Math.round(kelvinAt(sun.altitude))} K`],
  ];
  $('values').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

let last = performance.now();
let hudAt = 0;
function frame(now) {
  const dt = (now - last) / 1000;
  last = now;
  if (state.live) state.utcMs = Date.now();
  else if (state.playing) state.utcMs += dt * 1000 * state.speed;

  const s = solarState(new Date(state.utcMs), site);
  const target = s.light.entersWindow ? Math.min(1, s.light.windowIncidence * 3) : 0;
  state.lit += (target - state.lit) * Math.min(1, dt * 2);

  const sky = skyColors(s.sun.altitude);
  const u = screen.uniforms;
  u.uSkyTop.value.set(...sky.top);
  u.uSkyBottom.value.set(...sky.bottom);
  u.uLightColor.value.set(...kelvinToRgb(kelvinAt(s.sun.altitude)));
  u.uDir.value.set(s.light.dirX, s.light.dirY);
  u.uLit.value = state.lit;
  const sec = now / 1000;
  u.uDrift.value.set((sec * 0.004) % NOISE_PERIOD, (sec * 0.002) % NOISE_PERIOD);
  u.uSeed.value = Math.random();
  screen.render();

  if (now - hudAt > 100) {
    hudAt = now;
    const path = dayPath(state.utcMs);
    drawPlan($('plan'), site, s, path, declination);
    drawDayChart($('chart'), path, localParts(state.utcMs).min);
    drawScreenOverlay($('overlay'), site, s);
    renderHud(s);
  }
  requestAnimationFrame(frame);
}

const t = params.get('t')?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
if (t) {
  setLive(false);
  const [, y, mo, d, hh, mm] = t.map(Number);
  state.utcMs = utcFromLocal(y, mo - 1, d, hh * 60 + mm);
} else {
  setLive(true);
}
requestAnimationFrame(frame);
