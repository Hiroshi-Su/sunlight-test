import bundledSite from '../config/site.json';
import type { Heartbeat } from './bridge.ts';
import { Clock } from './clock.ts';
import { APP_MODES, type AppMode, type ParamValues, type VisualsConfig, parseSiteConfig, parseVisualsConfig } from './config.ts';
import { drawGuides, drawLightArrow } from './diagram.ts';
import { kelvinAt, kelvinToRgb, skyColors } from './palette.ts';
import { type RoomView, createRoomScene } from './room/scene.ts';
import { findScene } from './scenes/index.ts';
import { lightDebug } from './scenes/light-debug.ts';
import { type SceneDef, type SceneInput, mergeParams } from './scenes/types.ts';
import { type Site, resolveSite, solarState, withWindowSide } from './solar.ts';
import { GpuStage } from './gpu/stage.ts';
import { initWebGpu } from './gpu/webgpu.ts';
import { type FinalOptions, Stage, type StageLike } from './stage.ts';
import { el } from './ui/dom.ts';
import { mountVerify } from './ui/verify.ts';
import { formatBench, formatPerf, gpuTotalMs } from './ui/perf.ts';
import { mountModeSwitch } from './ui/mode-switch.ts';
import { mountRoomUi } from './ui/room.ts';
import { TrailLayer } from './room/trails.ts';
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

// room モードの設定（config/room.json）。開発サーバーでは保存した最新の内容を読み、ビルド版はビルド時にあれば埋め込む。なければ null
async function loadRoomSettingsInBrowser(): Promise<unknown> {
  if (import.meta.env.DEV) {
    const res = await fetch('/config/room.json', { cache: 'no-store' }).catch(() => null);
    return res?.ok ? res.json().catch(() => null) : null;
  }
  return Object.values(import.meta.glob('../config/room.json', { eager: true, import: 'default' }))[0] ?? null;
}

async function saveRoomSettings(file: unknown): Promise<void> {
  if (bridge) return bridge.saveRoom(file);
  if (!import.meta.env.DEV) throw new Error('保存は Electron か開発サーバーでのみ使えます');
  const res = await fetch('/__save-room', { method: 'POST', body: JSON.stringify(file) });
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
if (mode !== 'kiosk') mountModeSwitch(mode, clock, bridge ? (m) => bridge.setMode(m) : undefined);

const screenCanvas = el('screen', HTMLCanvasElement);
const overlay = el('overlay', HTMLCanvasElement);
const overlayCtx = overlay.getContext('2d')!;
// 描画の方式：WebGPU が使えれば WebGPU、使えない環境や ?gpu=webgl のときは WebGL2（どちらも同じ映像になる）
const webgpu = params.get('gpu') === 'webgl' ? null : await initWebGpu();
const stage: StageLike = webgpu ? new GpuStage(screenCanvas, W, H, webgpu) : new Stage(screenCanvas, W, H);
// WebGPU の命令の誤り（シェーダーの書き間違いなど）は黙って描かれなくなるので、画面の console とログに出す（最初の 20 件まで）
let gpuErrors = 0;
webgpu?.device.addEventListener('uncapturederror', (e) => {
  if (gpuErrors++ >= 20) return;
  const message = (e as GPUUncapturedErrorEvent).error.message.slice(0, 500);
  console.error('WebGPU:', message);
  bridge?.report('gpu-error', { message });
});
// GPU の装置が失われたら（ドライバの再起動など）、アプリ本体に知らせて読み込み直してもらう。ブラウザでは自分で読み込み直す
void webgpu?.device.lost.then((info) => {
  if (info.reason === 'destroyed') return;
  if (bridge) bridge.report('gpu-device-lost', { message: info.message });
  else location.reload();
});

// ---- モードごとの設定 ----
let arrowOn = mode === 'verify' || (mode === 'kiosk' && params.has('overlay'));
const verifyParams: ParamValues = mergeParams(lightDebug, undefined);
const kioskScene = findScene(visualsConfig.activeScene);
const kioskParams = mergeParams(kioskScene, visualsConfig.scenes[kioskScene.id]);
let pngRequested = false;
let lastFrame: { input: SceneInput; params: ParamValues; opts: FinalOptions; def: SceneDef } | null = null;

const verifyUi = mode === 'verify'
  ? mountVerify(clock, site, siteConfig.sites[site.name]!.screen.magneticDeclination, {
    setArrow: (on) => { arrowOn = on; },
    setStripes: (on) => { verifyParams['stripes'] = on; },
  }, arrowOn, lightDebug.params)
  : null;
const visualsUi = mode === 'visuals'
  ? mountVisuals(clock, visualsConfig, {
    save: saveVisuals,
    savePng: () => { pngRequested = true; },
    benchmark: async () => {
      if (!lastFrame) return '';
      const ms = await stage.benchmark(lastFrame.input, lastFrame.params, lastFrame.opts);
      bridge?.report('benchmark', { scene: lastFrame.def.id, ms: Math.round(ms * 100) / 100 });
      return formatBench(ms, lastFrame.def.label);
    },
  })
  : null;

// room モード：窓の位置はパネルで切り替えられる（room の表示と光の計算だけ。設定ファイルは変えない）
const roomEntry = siteConfig.sites[site.name]!;
// 最初に表示する窓の位置は、パネルが決める（URL の ?window=、保存した値、既定の天窓の順。src/ui/room.ts）
let roomSite: Site = site;
// 計算の解像度はパネル（とURL の ?scale= ?out= ?upscale=）で切り替える。パネルは部屋を作るより先に用意する
let room: ReturnType<typeof createRoomScene> | null = null;
const rebuildRoom = (): void => {
  const view = room?.currentView();
  room?.dispose();
  room = buildRoom(view);
  if (roomUi) room.setGuides(roomUi.guides);
};
const roomUi = mode === 'room'
  ? mountRoomUi(clock, roomEntry.room, roomEntry.window, site.windowSide, bridge ? bridge.room : await loadRoomSettingsInBrowser(), {
    onWindowSide: (side) => { roomSite = withWindowSide(site, side); rebuildRoom(); },
    onRoomSize: rebuildRoom,
    benchmark: async () => (room ? room.benchmark() : null),
    onResolution: (res) => room?.setResolution(res),
    onCalibration: (c) => room?.setCalibration(c),
    onGuides: (g) => room?.setGuides(g),
    save: saveRoomSettings,
  })
  : null;
if (roomUi) roomSite = withWindowSide(site, roomUi.side);
// 部屋の中央の光の軌跡（部屋を作り直しても線の動きが続くよう、1 つだけ作る）
const trailLayer = mode === 'room' ? new TrailLayer(el('roomTrails', HTMLCanvasElement)) : null;
const buildRoom = (view?: RoomView) =>
  createRoomScene(el('roomStage', HTMLDivElement), roomSite.windowSide, roomUi?.room ?? roomEntry.room, roomSite.facingAzimuth, {
    view, gpu: webgpu, resolution: roomUi?.resolution, calibration: roomUi?.calibration, guide: el('roomGuide', HTMLCanvasElement), trails: trailLayer,
  });
if (mode === 'room') { room = buildRoom(); if (roomUi) room.setGuides(roomUi.guides); }
if (room) addEventListener('resize', () => room?.resize());
// 開発サーバーだけ：動作確認のスクリプトから room の視点を動かせるようにする
if (import.meta.env.DEV) Object.assign(window, { __room: () => room, __trails: () => trailLayer });
const roomParamCache = new Map<string, ParamValues>();
const roomScreenParams = (def: SceneDef): ParamValues => {
  let p = roomParamCache.get(def.id);
  if (!p) roomParamCache.set(def.id, (p = mergeParams(def, visualsConfig.scenes[def.id])));
  return p;
};

if (mode === 'verify' || mode === 'kiosk') {
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

// ?animTime=秒 で映像の動きの時間を止める（WebGL2 と WebGPU の見比べ、同じ絵の撮影用）
const animTime = params.has('animTime') ? Number(params.get('animTime')) : null;

// ---- 描画ループ ----
// フレームの速さの上限。?fps=30 で 30fps に固定する（room モードはパネルの「フレームの速さ」でも切り替えられる）。
// 0 なら画面の更新ごとに描く（多くは 60fps）。固定するときは、画面の更新のうち間に合わないものを飛ばす
const urlFpsLimit = params.get('fps') === '30' ? 30 : 0;
const fpsLimit = (): number => roomUi?.frameRate ?? urlFpsLimit;
let last = performance.now();
let uiAt = 0;
let frames = 0;
let beatAt = performance.now();
let lit = 0;
let fps = 60;

const jsHeapMB = (): number | null => {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / 1048576) : null;
};

function frame(now: number): void {
  const limit = fpsLimit();
  // 上限があるときは、前に描いてから 1/上限 秒たつまで描かない（画面の更新の揺れぶん、少し早めに許す）
  if (limit > 0 && now - last < 1000 / limit - 4) {
    requestAnimationFrame(frame);
    return;
  }
  const dt = (now - last) / 1000;
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  clock.tick(dt);

  const s = solarState(clock.date, room ? roomSite : site);
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
    time: animTime ?? now / 1000,
    dt,
    width: W,
    height: H,
  };
  if (room && roomUi) {
    // スクリーンの映像は、visuals で保存した調整値（config/visuals.json）で描く
    const def = roomUi.screenScene;
    const screen = roomUi.settings.screen
      ? { def, params: roomScreenParams(def), input, outMin: visualsConfig.output.min, outMax: visualsConfig.output.max }
      : null;
    room.render({ solar: s, lightColor, sky: input.sky, screen }, roomUi.settings);
  } else {
    const { def, params: p, opts } = current(lit, lightColor);
    stage.setScene(def);
    stage.render(input, p, opts);
    lastFrame = { input, params: p, opts, def };
    if (pngRequested) {
      pngRequested = false;
      const pad = (n: number): string => String(n).padStart(2, '0');
      stage.savePng(`soracity-${def.id}-${clock.ymd()}-${pad(Math.floor(lp.min / 60))}${pad(lp.min % 60)}.png`);
    }
  }

  frames++;
  if (now - beatAt > 10000) {
    const beat: Heartbeat = {
      fps: Math.round(((frames * 1000) / (now - beatAt)) * 10) / 10,
      heapMB: jsHeapMB(),
      sun: { az: Math.round(s.sun.azimuth * 100) / 100, alt: Math.round(s.sun.altitude * 100) / 100 },
      entersWindow: s.light.entersWindow,
      lit: Math.round(lit * 1000) / 1000,
      gpuMs: room ? null : gpuTotalMs(stage.gpu()),
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
    const perf = formatPerf(stage.gpu(), fps, stage.backend);
    verifyUi?.update(s, perf, verifyParams);
    visualsUi?.updateStatus(s, lit, perf);
    if (room) roomUi?.updateStatus(s, lit, room.samples, room.backend, room.renderSize, room.spotOn, fps, fpsLimit());
  }
  requestAnimationFrame(frame);
}

bridge?.report('renderer-ready', { mode, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, canvas: [W, H] });
requestAnimationFrame(frame);
