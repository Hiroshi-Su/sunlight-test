import bundledSite from '../config/site.json';
import type { Heartbeat } from './bridge.ts';
import { Clock } from './clock.ts';
import { APP_MODES, type AppMode, type ParamValues, type VisualsConfig, parseSiteConfig, parseVisualsConfig } from './config.ts';
import { drawGuides, drawLightArrow } from './diagram.ts';
import { kelvinAt, kelvinToRgb, skyColors } from './palette.ts';
import { findScene } from './scenes/index.ts';
import { lightDebug } from './scenes/light-debug.ts';
import { type SceneDef, type SceneInput, mergeParams } from './scenes/types.ts';
import { resolveSite, solarState } from './solar.ts';
import { type FinalOptions, Stage } from './stage.ts';
import { el } from './ui/dom.ts';
import { mountVerify } from './ui/verify.ts';
import { mountVisuals } from './ui/visuals.ts';

const W = 3840, H = 1080;
const params = new URLSearchParams(location.search);
// Electron では preload 経由で実行時に config を読む（main 側で検証済み）
const bridge = window.soracity;

async function loadVisualsInBrowser(): Promise<VisualsConfig> {
  // 開発サーバーでは保存した最新の内容を読む。ビルド版はビルド時の内容を埋め込む
  if (import.meta.env.DEV) {
    const res = await fetch('/config/visuals.json', { cache: 'no-store' });
    return parseVisualsConfig(await res.json());
  }
  return parseVisualsConfig((await import('../config/visuals.json')).default);
}

async function saveVisuals(cfg: VisualsConfig): Promise<void> {
  if (bridge) return bridge.saveVisuals(cfg);
  if (!import.meta.env.DEV) throw new Error('保存は Electron か開発サーバーでのみ使えます');
  const res = await fetch('/__save-visuals', { method: 'POST', body: JSON.stringify(cfg) });
  if (!res.ok) throw new Error(await res.text());
}

const siteConfig = bridge?.config ?? parseSiteConfig(bundledSite);
const loadedVisuals = bridge?.visuals ?? await loadVisualsInBrowser();
// ?scene=ID で表示する映像を一時的に切り替える（保存はしない）
const visualsConfig: VisualsConfig = params.get('scene') ? { ...loadedVisuals, activeScene: params.get('scene')! } : loadedVisuals;
const urlMode = params.get('mode');
const mode: AppMode = bridge?.mode ?? (APP_MODES.find((m) => m === urlMode) ?? 'verify');
document.body.classList.add(`mode-${mode}`);

const site = resolveSite(siteConfig, params.get('site') ?? siteConfig.activeSite);
const clock = new Clock(site.utcOffsetMinutes);
clock.setFromParam(params.get('t'));

const screenCanvas = el('screen', HTMLCanvasElement);
const overlay = el('overlay', HTMLCanvasElement);
const overlayCtx = overlay.getContext('2d')!;
const stage = new Stage(screenCanvas, W, H);

// ---- モードごとの設定 ----
let arrowOn = mode === 'verify' || (mode === 'kiosk' && params.has('overlay'));
const verifyParams: ParamValues = mergeParams(lightDebug, undefined);
const kioskScene = findScene(visualsConfig.activeScene);
const kioskParams = mergeParams(kioskScene, visualsConfig.scenes[kioskScene.id]);
let pngRequested = false;

const verifyUi = mode === 'verify'
  ? mountVerify(clock, site, siteConfig.sites[site.name]!.screen.magneticDeclination, {
    setArrow: (on) => { arrowOn = on; },
    setStripes: (on) => { verifyParams['stripes'] = on; },
  }, arrowOn)
  : null;
const visualsUi = mode === 'visuals'
  ? mountVisuals(clock, visualsConfig, { save: saveVisuals, savePng: () => { pngRequested = true; } })
  : null;

if (mode !== 'visuals') {
  addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'd' || e.ctrlKey || e.metaKey || e.target instanceof HTMLInputElement) return;
    arrowOn = !arrowOn;
    verifyUi?.syncArrow(arrowOn);
  });
}

screenCanvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  bridge?.report('webgl-context-lost');
});

function current(lit: number, lightColor: readonly [number, number, number]): { def: SceneDef; params: ParamValues; opts: FinalOptions } {
  if (visualsUi) {
    const { preview, output } = visualsUi.config;
    const wash = preview.wash * (preview.washFollowsSun ? 0.35 + 0.65 * lit : 1);
    // 外光の色：ほぼ白に、その時間の光の色を少し混ぜる
    const washColor = [0, 1, 2].map((i) => 0.92 * 0.6 + lightColor[i]! * 0.4) as [number, number, number];
    return { def: visualsUi.scene, params: visualsUi.params, opts: { outMin: output.min, outMax: output.max, wash, washColor } };
  }
  const out = visualsConfig.output;
  const base: FinalOptions = { outMin: out.min, outMax: out.max, wash: 0, washColor: [1, 1, 1] };
  if (mode === 'kiosk') return { def: kioskScene, params: kioskParams, opts: base };
  return { def: lightDebug, params: verifyParams, opts: base };
}

// ---- 描画ループ ----
let last = performance.now();
let uiAt = 0;
let frames = 0;
let beatAt = performance.now();
let lit = 0;

const jsHeapMB = (): number | null => {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / 1048576) : null;
};

function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  clock.tick(dt);

  const s = solarState(clock.date, site);
  const target = s.light.entersWindow ? Math.min(1, s.light.windowIncidence * 3) : 0;
  lit += (target - lit) * Math.min(1, dt * 2);

  const kelvin = kelvinAt(s.sun.altitude);
  const lightColor = kelvinToRgb(kelvin);
  const lp = clock.local();
  const input: SceneInput = {
    sun: s.sun,
    light: s.light,
    lit,
    kelvin,
    lightColor,
    sky: skyColors(s.sun.altitude),
    localMinutes: lp.min + lp.sec / 60,
    time: now / 1000,
    dt,
    width: W,
    height: H,
  };
  const { def, params: p, opts } = current(lit, lightColor);
  stage.setScene(def);
  stage.render(input, p, opts);
  if (pngRequested) {
    pngRequested = false;
    const pad = (n: number): string => String(n).padStart(2, '0');
    stage.savePng(`soracity-${def.id}-${clock.ymd()}-${pad(Math.floor(lp.min / 60))}${pad(lp.min % 60)}.png`);
  }

  frames++;
  if (now - beatAt > 10000) {
    const beat: Heartbeat = {
      fps: Math.round(((frames * 1000) / (now - beatAt)) * 10) / 10,
      heapMB: jsHeapMB(),
      sun: { az: Math.round(s.sun.azimuth * 100) / 100, alt: Math.round(s.sun.altitude * 100) / 100 },
      entersWindow: s.light.entersWindow,
      lit: Math.round(lit * 1000) / 1000,
    };
    frames = 0;
    beatAt = now;
    bridge?.heartbeat(beat);
  }

  if (now - uiAt > 100) {
    uiAt = now;
    const showArrow = visualsUi ? visualsUi.view.arrow : arrowOn;
    const showGuides = visualsUi?.view.guides ?? false;
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    overlay.hidden = !showArrow && !showGuides;
    if (showGuides && visualsUi) drawGuides(overlayCtx, visualsUi.config.guides);
    if (showArrow) drawLightArrow(overlayCtx, site, s);
    verifyUi?.update(s);
    visualsUi?.updateStatus(s, lit);
  }
  requestAnimationFrame(frame);
}

bridge?.report('renderer-ready', { mode, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, canvas: [W, H] });
requestAnimationFrame(frame);
