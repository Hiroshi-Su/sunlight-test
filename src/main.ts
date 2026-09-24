import bundledConfig from '../config/site.json';
import type { Heartbeat } from './bridge.ts';
import { type AppMode, parseSiteConfig } from './config.ts';
import { type PathPoint, drawDayChart, drawPlan, drawScreenOverlay } from './diagram.ts';
import { kelvinAt, kelvinToRgb, skyColors } from './palette.ts';
import { NOISE_PERIOD, createScreen } from './screen.ts';
import { type SolarState, resolveSite, solarState } from './solar.ts';

const W = 3840, H = 1080;
const params = new URLSearchParams(location.search);
// Electron では preload 経由で実行時に config/site.json を読む（main 側で検証済み）。ブラウザではビルド時に埋め込んだ値を使う
const bridge = window.soracity;
const config = bridge?.config ?? parseSiteConfig(bundledConfig);
const mode: AppMode = bridge?.mode ?? (params.get('mode') === 'kiosk' ? 'kiosk' : 'verify');
const kiosk = mode === 'kiosk';
document.body.classList.toggle('kiosk', kiosk);
const site = resolveSite(config, params.get('site') ?? config.activeSite);
const declination = config.sites[site.name]!.screen.magneticDeclination;
const offsetMs = site.utcOffsetMinutes * 60000;

function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof type)) throw new Error(`#${id} が見つからないか型が違います`);
  return e;
}
const ui = {
  screen: el('screen', HTMLCanvasElement),
  overlay: el('overlay', HTMLCanvasElement),
  plan: el('plan', HTMLCanvasElement),
  chart: el('chart', HTMLCanvasElement),
  clock: el('clock', HTMLElement),
  values: el('values', HTMLElement),
  now: el('now', HTMLButtonElement),
  play: el('play', HTMLButtonElement),
  speed: el('speed', HTMLSelectElement),
  time: el('time', HTMLInputElement),
  date: el('date', HTMLInputElement),
  showOverlay: el('showOverlay', HTMLInputElement),
  showStripes: el('showStripes', HTMLInputElement),
};

const screen = createScreen(ui.screen, W, H);

interface ViewState {
  utcMs: number;
  live: boolean;
  playing: boolean;
  speed: number;
  /** 窓から光が入っている度合い（フェード中の値） */
  lit: number;
  pathDay: string | null;
  path: PathPoint[];
}
const state: ViewState = {
  utcMs: Date.now(),
  live: true,
  playing: false,
  speed: 600,
  lit: 0,
  pathDay: null,
  path: [],
};

// 現地時刻（UTC オフセットは config 由来。PC のタイムゾーンには依存しない）
const localParts = (utcMs: number) => {
  const d = new Date(utcMs + offsetMs);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const utcFromLocal = (y: number, mo: number, d: number, min: number): number => Date.UTC(y, mo, d, 0, min) - offsetMs;
const pad2 = (n: number): string => String(n).padStart(2, '0');

function dayPath(utcMs: number): PathPoint[] {
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

function setLive(on: boolean): void {
  state.live = on;
  ui.now.classList.toggle('on', on);
  if (on) { state.playing = false; ui.play.textContent = '▶'; }
}

ui.now.addEventListener('click', () => setLive(true));
ui.play.addEventListener('click', () => {
  setLive(false);
  state.playing = !state.playing;
  ui.play.textContent = state.playing ? '❚❚' : '▶';
});
ui.speed.addEventListener('change', () => { state.speed = Number(ui.speed.value); });
ui.time.addEventListener('input', () => {
  setLive(false);
  const { y, mo, d } = localParts(state.utcMs);
  state.utcMs = utcFromLocal(y, mo, d, Number(ui.time.value));
});
ui.date.addEventListener('change', () => {
  const m = ui.date.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return;
  setLive(false);
  state.utcMs = utcFromLocal(Number(m[1]), Number(m[2]) - 1, Number(m[3]), localParts(state.utcMs).min);
});

const setOverlay = (on: boolean): void => { ui.overlay.hidden = !on; ui.showOverlay.checked = on; };
ui.showOverlay.addEventListener('change', () => setOverlay(ui.showOverlay.checked));
addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement)) setOverlay(ui.overlay.hidden !== false);
});
setOverlay(kiosk ? params.has('overlay') : true);
ui.showStripes.addEventListener('change', () => { screen.uniforms.uStripes.value = ui.showStripes.checked ? 1 : 0; });

ui.screen.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  bridge?.report('webgl-context-lost');
});

function renderHud(s: SolarState): void {
  const { sun, light } = s;
  const lp = localParts(state.utcMs);
  const secs = new Date(state.utcMs + offsetMs).getUTCSeconds();
  ui.clock.textContent = `${lp.y}-${pad2(lp.mo + 1)}-${pad2(lp.d)}  ${pad2(Math.floor(lp.min / 60))}:${pad2(lp.min % 60)}:${pad2(secs)}  (UTC${site.utcOffsetMinutes >= 0 ? '+' : ''}${site.utcOffsetMinutes / 60})`;
  if (document.activeElement !== ui.time) ui.time.value = String(lp.min);
  if (document.activeElement !== ui.date) ui.date.value = `${lp.y}-${pad2(lp.mo + 1)}-${pad2(lp.d)}`;

  const screenAngle = Math.atan2(light.dirY, light.dirX) * 180 / Math.PI;
  const rows: [string, string][] = [
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
  ui.values.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

let last = performance.now();
let hudAt = 0;
let frames = 0;
let beatAt = performance.now();

// Chromium 独自の performance.memory
const jsHeapMB = (): number | null => {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / 1048576) : null;
};

function heartbeat(now: number, s: SolarState): void {
  const fps = (frames * 1000) / (now - beatAt);
  frames = 0;
  beatAt = now;
  const beat: Heartbeat = {
    fps: Math.round(fps * 10) / 10,
    heapMB: jsHeapMB(),
    sun: { az: Math.round(s.sun.azimuth * 100) / 100, alt: Math.round(s.sun.altitude * 100) / 100 },
    entersWindow: s.light.entersWindow,
    lit: Math.round(state.lit * 1000) / 1000,
  };
  bridge?.heartbeat(beat);
}

function frame(now: number): void {
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
  frames++;
  if (now - beatAt > 10000) heartbeat(now, s);

  if (now - hudAt > 100) {
    hudAt = now;
    if (!ui.overlay.hidden) drawScreenOverlay(ui.overlay, site, s);
    if (!kiosk) {
      const path = dayPath(state.utcMs);
      drawPlan(ui.plan, site, s, path, declination);
      drawDayChart(ui.chart, path, localParts(state.utcMs).min);
      renderHud(s);
    }
  }
  requestAnimationFrame(frame);
}

const t = params.get('t')?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
if (t) {
  setLive(false);
  state.utcMs = utcFromLocal(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]) * 60 + Number(t[5]));
} else {
  setLive(true);
}
bridge?.report('renderer-ready', { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, canvas: [W, H] });
requestAnimationFrame(frame);
