// room モードの UI：時刻操作・窓の位置と大きさの切り替えパネルと、太陽・lit の状態表示
import type { MoonPosition } from '../moon.ts';
import GUI from 'lil-gui';
import type { Clock } from '../clock.ts';
import { mountCalibMode } from './calib-mode.ts';
import { WINDOW_SIDES, WINDOW_SIDE_LABEL, type WindowSide } from '../config.ts';
import { PALETTE_KELVIN_ALTS, PALETTE_SKY_ALTS, type PaletteTable, defaultPalette, kelvinAt, setPalette } from '../palette.ts';
import { EXHIBIT_SIZE, type GuideOptions, LIGHT_KINDS, type LightKind, MAX_BLOBS, MAX_SHIM_COLORS, MAX_SHIM_PALETTE, MAX_SPOTS, MAX_PRISMS, type MoonSettings, type OrganicLook, PRISM_MOTIONS, PRISM_PATTERNS, type Openings, WINDOW_TOPS, type WindowTop, GLASS_FACES, GLASS_KINDS, GLASS_SURFACES, type GlassFace, type GlassKind, type GlassSurface, MOON_MODES, SEA_WAVES, type SeaWaves, SHIMMER_ANCHORS, SHIMMER_COLOR_MODES, type PrismMotion, type PrismPattern, type PrismSettings, SPOT_MODES, TRAIL_COLOR_MODES, type TrailSettings, type RoomGeometry, type RoomOutput, type RoomRenderSettings, type RoomResolution, type SpotLight, type SpotMode, type SpotSettings, type ViewCalibration, type WindowGeometry, defaultCalibration } from '../room/scene.ts';
import { SCENES, findScene } from '../scenes/index.ts';
import type { SceneDef } from '../scenes/types.ts';
import type { SolarState } from '../solar.ts';
import type { Backend } from '../stage.ts';
import { BACKEND_LABEL } from './perf.ts';
import { el, ignoreSliderWheel } from './dom.ts';
import { type WarpCorners, warpCss } from './warp.ts';
import { type RoomSettingsFile, mergeKnown, oneOf } from '../room/settings-file.ts';
import { shareRoomSettings } from '../room/live-share.ts';
import { mountTimeControls } from './time-controls.ts';

/**
 * room モードを開いたときの既定値（URL で上書きできる）。時刻は現在時刻、窓の位置は天窓（src/main.ts）
 * - 水盤はオン、波の強さは 0.3。水盤で跳ね返った光（壁・天井の揺らぎ）はオフ（窓の外の水面の反射と見分けやすいように、別に出し消しする）
 * - 雲が日差しをさえぎる（雲の影）はオフ
 * - 天窓の大きさは天井いっぱい（天井の面が消える大きさ）。URL の ?winW= ?winH= を指定したときはその値
 */
export const ROOM_DEFAULTS = { pool: true, poolReflect: false, seaView: true, waveAmp: 0.3, cloudShadow: false } as const;

/**
 * スポットライト 1 台の既定（鑑賞者の頭上：手前の端から 0.6m、天井から 0.15m。真下から奥へ 35° 傾ける）。
 * 2 台目以降は左右に並べ、4 台目は少し奥に置く
 */
const SPOT_LIGHT_BASE: SpotLight = {
  strength: 1, beamDeg: 60, softness: 0.35, tiltDeg: 35, panDeg: 0,
  fromFrontM: 0.6, belowCeilingM: 0.15, xM: 0, colorMode: 'kelvin', kelvin: 9000, color: '#ffd9a8',
};
const SPOT_LIGHT_PLACES: Partial<SpotLight>[] = [{}, { xM: -2.5 }, { xM: 2.5 }, { fromFrontM: 2.0, tiltDeg: 20 }];
export const spotLightDefault = (i: number): SpotLight => ({ ...SPOT_LIGHT_BASE, ...SPOT_LIGHT_PLACES[i % SPOT_LIGHT_PLACES.length] });
export const SPOT_DEFAULTS: SpotSettings = {
  mode: 'auto', kind: 'ambient', ambient: { strength: 1, marginM: 0.5, kelvin: 4000 }, count: 3, onAltDeg: 5, fullAltDeg: -4, showLamp: false,
  lights: Array.from({ length: MAX_SPOTS }, (_, i) => spotLightDefault(i)),
};
/** 光の軌跡の既定（部屋の中央・目の高さのあたりに、半径 1.2m で 1,024 本）。既定では出さない（?trails=1 か、パネルで出す） */
export const TRAIL_DEFAULTS: TrailSettings = {
  on: false, count: 1024, points: 48, widthPx: 3, speed: 1.2, turbulence: 0.6, spread: 0.2,
  radiusM: 1.2, centerHeightM: 1.6, centerFromFrontM: 0, brightness: 1,
  colorMode: 'scene', color: '#66ccff', hueSpread: 1,
};
/** プリズムの既定（既定では出さない。?prism=1（吊るプリズム）・?prism=streaks / hung / panel / beams / none か、パネルで出す。
 * E・F・G は ?waves=1・?organic=1・?blobs=1 で重ね、?prism=waves / organic / blobs はそれだけ）。虹の広がりは、見えやすいように本物のガラスより大きくしている */
export const PRISM_DEFAULTS: PrismSettings = {
  on: false, pattern: 'hung', vividness: 0.7, speed: 0.15, motion: 'spin', swayDeg: 35, causticSpreadM: 0.04,
  streaks: { strength: 1, amount: 0.8, lengthM: 1.2, angleDeg: 20 },
  hung: { count: 10, facets: 3, strength: 2.5, sizeM: 0.2, deviationDeg: 30, dispersionDeg: 12, dropM: 0.6 },
  panel: { strength: 0.9, deviationDeg: 15, dispersionDeg: 8, ridgeAngleDeg: 0 },
  waves: {
    on: false, wobbleM: 0.12, waveLengthM: 1.2, speed: 0.15,
    fringe: 0.3, soft: 0.05, halo: 0.4, haloWidth: 0.6, haloHue: 0.62, saturation: 1.6,
  },
  organic: {
    on: false, wobbleM: 0.08, scaleM: 0.25, speed: 0.15, pastel: 0.12,
    fringe: 0.12, soft: 0.02, halo: 0.35, haloWidth: 0.3, haloHue: 0.83, saturation: 1.6,
  },
  blobs: {
    on: false, count: 5, strength: 8, sizeM: 0.4, grow: 0.12, deviationDeg: 12, wobble: 0.3, speed: 0.15, pastel: 0.5,
    fringe: 0.35, soft: 0.08, halo: 0.5, haloWidth: 0.6, haloHue: 1, saturation: 1.6,
  },
  shimmer: {
    on: false, amount: 1, anchor: 'surface', scaleM: 0.6, lineWidth: 0.05, warp: 1.2, speed: 0.3, base: 0.6, gain: 2, dispersion: 0.04, iridescence: 0.6,
    colorMode: 'spectrum', colorCount: 3, hueStart: 0, hueEnd: 1,
    // 選んだ色の既定は、参考の水底の写真の色（水色・ラベンダー・ピンク・淡い黄・白）
    palette: ['#7fe3ff', '#c9a8ff', '#ff9ad5', '#fff1a8', '#ffffff'], paletteCount: 4,
    lineColor: '#ffffff', baseColor: '#ffffff', saturation: 1,
  },
  beams: { count: 8, strength: 2.5, widthM: 0.3, blur: 0.06, deviationDeg: 10, dispersionDeg: 8, ridgeAngleDeg: 0 },
};
const PRISM_PATTERN_LABEL: Record<PrismPattern, string> = {
  streaks: 'A：日だまりの中に虹の筋（演出寄り）',
  hung: 'B：窓に吊るプリズム（本物寄り）',
  panel: 'C：窓をプリズムの板で覆う',
  beams: 'D：日差しの先に虹の筋（窓ガラスのプリズム）',
  none: '出さない（E〜H だけにするとき）',
};
const PRISM_MOTION_LABEL: Record<PrismMotion, string> = {
  spin: '一方向に回り続ける',
  sway: '左右にねじれては戻る',
  wind: '風の強さで揺れる',
  still: '止まったまま',
};
/** 月明かりの既定（南の空、高度 50° の月。太陽が 0° を切ると点き始め、−8° で最大） */
export const MOON_DEFAULTS: MoonSettings = {
  on: true, strength: 0.5, skyStrength: 0.7, color: '#a9bfff', azimuthDeg: 180, altitudeDeg: 50, onAltDeg: 0, fullAltDeg: -8,
  mode: 'realFull', seaRoadStrength: 1.5, seaRoadOffsetDeg: 0, seaRoadAltDeg: 6,
};
const SPOT_MODE_LABEL: Record<SpotMode, string> = { auto: '自動（太陽が沈むと点く）', on: '常に点ける', off: '消す' };
const LIGHT_KIND_LABEL: Record<LightKind, string> = { spot: 'スポットライト（頭上から丸く照らす）', ambient: '全体照明（天井全体がやわらかく光る）' };

/** パネルの操作を、部屋の表示へ伝える */
export interface RoomUiHooks {
  /** 窓の位置を切り替えたとき。room モードの表示と光の計算だけに効き、設定ファイルは変えない */
  onWindowSide(side: WindowSide): void;
  /** 部屋の寸法を変えたとき（部屋を作り直す） */
  onRoomSize(): void;
  /** 今の設定で重さを測る */
  benchmark(): Promise<number | null>;
  /** 計算の解像度・出す大きさを変えたとき */
  onResolution(res: RoomResolution): void;
  /** パース合わせの視点を変えたとき */
  onCalibration(c: ViewCalibration): void;
  /** 合わせるための線の出し方を変えたとき */
  onGuides(g: GuideOptions): void;
  /** 部屋の設定を保存する（config/room.json） */
  save(file: RoomSettingsFile): Promise<void>;
  /** 「会場の値を入れる」で入れる値（非公開の会場のデータがあるときだけ。src/main.ts） */
  venuePreset?: VenuePreset | null;
}

/** 現地（会場）に合わせた部屋の寸法と視点。パース調整の出発点にする */
export interface VenuePreset {
  label: string;
  room: { widthM: number; heightM: number };
  calibration: ViewCalibration;
  windowSide?: WindowSide;
}

/**
 * @param configRoom config/site.json の部屋の寸法（初期値。パネルで変えられる）
 * @param configWindow config/site.json の窓の大きさ（初期値）
 * @param configSide config/site.json の窓の位置（初期値）
 * @param saved 保存した room の設定（config/room.json の中身。なければ null）。コードの既定に重ね、URL の指定がさらに優先する
 */
export function mountRoomUi(
  clock: Clock,
  configRoom: RoomGeometry,
  configWindow: WindowGeometry,
  configSide: WindowSide,
  saved: unknown,
  hooks: RoomUiHooks,
) {
  const { onWindowSide, benchmark, onResolution } = hooks;
  const q = new URLSearchParams(location.search);
  // コードの既定 → 保存した値。URL の指定は、下でそれぞれの値を決めるときに優先する
  const base = mergeKnown(codeDefaults(configRoom, configWindow), saved);
  // 部屋の寸法。設定ファイル（config/site.json）は変えない。パネルで変えたものは「部屋の設定を保存」で config/room.json に残せる
  const room: RoomGeometry = { ...base.room };
  const gui = new GUI({ container: el('room-panel', HTMLElement), width: 380, title: 'room' });
  ignoreSliderWheel(gui.domElement);

  // 保存（パネルのいちばん上）。現地で合わせた値を config/room.json に書き、次に開いたときに読む
  const saveState = { text: saved ? '保存した設定（config/room.json）を読み込んだ' : '保存した設定はない（既定の値）' };
  const doSave = async (): Promise<string> => {
    saveState.text = '保存中…';
    try {
      await hooks.save(collect());
      saveState.text = `保存した（${new Date().toLocaleTimeString()}）`;
    } catch (err) {
      saveState.text = `保存できなかった：${err instanceof Error ? err.message : String(err)}`;
    }
    return saveState.text;
  };
  gui.add({ run: doSave }, 'run').name('部屋の設定を保存（config/room.json）');
  gui.add(saveState, 'text').name('保存').disable().listen();

  // 窓：左の壁・右の壁（どちらも壁いっぱい）はそれぞれあり・なし、天井はなし・天井いっぱい・天窓（天井の一部）のどれか。いくつでも組み合わせられる。
  // 計算の上では、1 つ目の窓（左 > 右）と天井の窓で表し、残りの壁の窓は面ぜんたいを開ける（core.ts の uOpenMask）。
  // URL：?open=left,right,skylight（left・right と、full か skylight を並べる）。前の ?window=left / right / ceiling / skylight / ceiling-left も使える
  const openings: Openings = openingsOf(saved, base);
  const urlChoice = WINDOW_CHOICES.find((w) => w === q.get('window'));
  if (urlChoice) Object.assign(openings, openingsFromChoice(urlChoice, openings));
  if (q.has('open')) {
    const list = (q.get('open') ?? '').split(',');
    Object.assign(openings, { left: list.includes('left'), right: list.includes('right'), top: list.includes('skylight') ? 'skylight' : list.includes('full') ? 'full' : 'none' });
    if (!openings.left && !openings.right && openings.top === 'none') openings.left = true;
  }
  const state = { side: openingsLayout(openings, room, configWindow.sillHeightM).side };
  const fr = gui.addFolder('部屋');

  // 画面の設定。照り返しを 0 にすると、窓から直接届く光だけになる（照り返しの効果を見比べられる）
  // 水は ?sea=1（海）・?ripples=1（水面の反射の揺らぎ）・?pool=1（水盤）で最初からオンにできる
  // 窓の大きさは ?winW=（幅）・?winH=（高さ）・?sill=（床から窓の下端まで）で最初の値を指定できる（m）
  // 雲は ?clouds=1、スクリーンの映像は ?screen=1（光の雲）か ?screen=映像の ID で最初からオンにできる
  const on = (k: string, fallback = false): boolean => (q.has(k) ? q.get(k) === '1' : fallback);
  const num = (k: string, fallback: number): number => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const r0 = base.render;
  // 窓の大きさは窓の組み合わせから決まる（壁は壁いっぱい、天井は天井いっぱいか天窓の大きさ）
  const winBase = openingsLayout(openings, room, configWindow.sillHeightM).window;
  const settings: RoomRenderSettings = {
    ...r0,
    // ?seaWaves=sines で前の正弦波の海
    seaWaves: oneOf(q.get('seaWaves') ?? r0.seaWaves, SEA_WAVES, 'fft'),
    seaCompare: on('seaCompare', r0.seaCompare),
    seaView: on('sea', r0.seaView), seaRipples: on('ripples', r0.seaRipples), pool: on('pool', r0.pool), poolReflect: on('poolReflect', r0.poolReflect),
    waveAmp: num('wave', r0.waveAmp),
    window: { ...winBase },
    openings,
    clouds: on('clouds', r0.clouds), cloudShadow: on('cloudShadow', r0.cloudShadow),
    screen: q.has('screen') ? q.get('screen') !== '0' : r0.screen,
    // ?moon=0 で月明かりを消して開く
    moon: { ...r0.moon, on: on('moon', r0.moon.on), mode: oneOf(q.get('moonMode') ?? r0.moon.mode, MOON_MODES, 'realFull') },
    // ?glass=right,back のように、ガラスの壁にする面を並べる（?glass=0 ですべて壁）
    glassSpec: {
      ...r0.glassSpec,
      kind: oneOf(r0.glassSpec.kind, GLASS_KINDS, 'lowIron'),
      surface: oneOf(q.get('glassSurface') ?? r0.glassSpec.surface, GLASS_SURFACES, 'flat'),
      prism: on('glassPrism', r0.glassSpec.prism),
    },
    glass: Object.fromEntries(GLASS_FACES.map((f) => [f, q.has('glass') ? (q.get('glass') ?? '').split(',').includes(f) : !!r0.glass[f]])) as Record<GlassFace, boolean>,
    // プリズム：保存した値の出し方・動き方が選択肢になければ既定にする
    prism: {
      ...r0.prism,
      pattern: oneOf(r0.prism.pattern, PRISM_PATTERNS, PRISM_DEFAULTS.pattern),
      motion: oneOf(r0.prism.motion, PRISM_MOTIONS, PRISM_DEFAULTS.motion),
      shimmer: {
        ...r0.prism.shimmer,
        anchor: oneOf(r0.prism.shimmer.anchor, SHIMMER_ANCHORS, PRISM_DEFAULTS.shimmer.anchor),
        colorMode: oneOf(r0.prism.shimmer.colorMode, SHIMMER_COLOR_MODES, PRISM_DEFAULTS.shimmer.colorMode),
      },
    },
    // ?trails=1 で光の軌跡を出して開く（既定は出さない）
    trails: { ...r0.trails, on: on('trails', r0.trails.on), colorMode: oneOf(r0.trails.colorMode, TRAIL_COLOR_MODES, 'scene') },
    // ?spot=on / off / auto でスポットライトの点け方、?spotCount=2 で台数を指定できる
    // ?light=ambient で全体照明、?light=spot でスポットライト
    spot: {
      ...base.spot,
      mode: oneOf(q.get('spot') ?? base.spot.mode, SPOT_MODES, SPOT_DEFAULTS.mode),
      kind: oneOf(q.get('light') ?? base.spot.kind, LIGHT_KINDS, SPOT_DEFAULTS.kind),
      ambient: { ...base.spot.ambient },
      count: Math.min(MAX_SPOTS, Math.max(1, Math.round(num('spotCount', base.spot.count)))),
      lights: base.spot.lights.map((l) => ({ ...l, colorMode: oneOf(l.colorMode, ['kelvin', 'color'] as const, 'kelvin') })),
    },
  };
  const screenParam = q.get('screen') ?? base.screenScene;
  const screen = { id: SCENES.some((d) => d.id === screenParam) ? screenParam : 'light-clouds' };

  // 窓のあり・なし。最後の 1 つは外せない（窓がないと光が入らない）。変えたら窓の大きさを決め直し、1 つ目の窓の位置が変わったら部屋を作り直す
  const win = settings.window;
  const applyOpenings = (): void => {
    if (!openings.left && !openings.right && openings.top === 'none') { openings.left = true; cLeft.updateDisplay(); }
    openings.skyWidthM = Math.min(openings.skyWidthM, room.widthM);
    openings.skyDepthM = Math.min(openings.skyDepthM, room.depthM);
    const lay = openingsLayout(openings, room, configWindow.sillHeightM);
    Object.assign(win, lay.window);
    cSkyW.max(room.widthM).show(openings.top === 'skylight').updateDisplay();
    cSkyD.max(room.depthM).show(openings.top === 'skylight').updateDisplay();
    if (lay.side !== state.side) { state.side = lay.side; onWindowSide(state.side); }
  };
  const cLeft = fr.add(openings, 'left').name('左の壁を窓に（壁いっぱい）').onChange(applyOpenings);
  fr.add(openings, 'right').name('右の壁を窓に（壁いっぱい）').onChange(applyOpenings);
  fr.add(openings, 'top', { 'なし': 'none', '天井いっぱい': 'full', '天窓（天井の一部）': 'skylight' }).name('天井の窓').onChange(applyOpenings);
  const cSkyW = fr.add(openings, 'skyWidthM', 0.2, room.widthM, 0.05).name('天窓の幅（左右、m）').onChange(applyOpenings);
  const cSkyD = fr.add(openings, 'skyDepthM', 0.2, room.depthM, 0.05).name('天窓の奥行き（m）').onChange(applyOpenings);
  const fit = applyOpenings;
  // 部屋の寸法（現地の空間に合わせる）。動かし終えたときに部屋を作り直す
  const roomChanged = (): void => { fit(); hooks.onRoomSize(); };
  fr.add(room, 'widthM', 2, 40, 0.05).name('部屋の幅（m）').onFinishChange(roomChanged);
  fr.add(room, 'depthM', 2, 40, 0.05).name('部屋の奥行き（m）').onFinishChange(roomChanged);
  fr.add(room, 'heightM', 2, 15, 0.05).name('部屋の高さ（m）').onFinishChange(roomChanged);
  fr.add({ run: (): void => { Object.assign(room, configRoom); fr.controllers.forEach((c) => c.updateDisplay()); roomChanged(); } }, 'run').name('部屋の寸法を設定どおりに戻す');
  fit();
  const fv = gui.addFolder('光の計算');
  fv.add(settings, 'bounces', 0, 6, 1).name('照り返しの回数');
  fv.add(settings, 'smooth').name('照り返しのざらつきをならす');
  fv.add(settings, 'exposure', 0.1, 8, 0.05).name('露出（明るさ）');
  // 重さ：今の設定で 60 フレーム続けて描き、GPU の処理が終わるまで待って 1 フレームの時間を測る（その間は描画が止まる）
  const bench = { text: '' };
  fv.add({ run: async () => {
    bench.text = '計測中…';
    const ms = await benchmark();
    bench.text = ms === null ? '' : `1 フレーム ${ms.toFixed(1)} ms（最大 ${Math.floor(1000 / ms)} fps 相当）`;
  } }, 'run').name('重さを測る（60 フレーム）');
  fv.add(bench, 'text').name('結果').disable().listen();

  // 解像度：小さく計算して引き伸ばす。展示の投影で細かいざらつき（グレイン）がどこまで見えるかを確かめる
  // URL の ?scale=0.5（計算の倍率）・?out=exhibit / actual（出し方）・?upscale=pixel（画素のまま引き伸ばす）でも最初の値を指定できる
  const view = el('roomView', HTMLElement);
  const scaleParam = Number(q.get('scale'));
  const outParam = q.get('out');
  const OUTPUT_KINDS = ['view', 'exhibit', 'actual'] as const;
  const resolution: RoomResolution = {
    scale: q.has('scale') && scaleParam >= 0.1 && scaleParam <= 1 ? scaleParam : Math.min(1, Math.max(0.1, base.resolution.scale)),
    output: oneOf(outParam ?? base.resolution.output, OUTPUT_KINDS, 'view'),
  };
  const look = { upscale: oneOf(q.get('upscale') ?? base.resolution.upscale, ['smooth', 'pixel'] as const, 'smooth') };
  // フレームの速さ：0 = 画面の更新ごと（多くは 60fps）、30 = 30fps に固定。?fps=30 でも指定できる
  const pace = { fps: (q.get('fps') ?? String(base.resolution.fps)) === '30' ? 30 : 0 };
  const fq = gui.addFolder('解像度');
  const actualBar = mountActualBar(
    (sc) => { resolution.scale = sc; changed(); },
    () => { resolution.output = 'exhibit'; changed(); },
    () => { look.upscale = look.upscale === 'pixel' ? 'smooth' : 'pixel'; changed(); },
  );
  const changed = (): void => {
    view.classList.toggle('exhibit', resolution.output === 'exhibit');
    view.classList.toggle('actual', resolution.output === 'actual');
    view.classList.toggle('pixelated', look.upscale === 'pixel');
    // 原寸：出す 1 画素 = 画面の 1 画素（高解像度ディスプレイでは CSS の大きさを 1/devicePixelRatio にする）
    view.style.setProperty('--actual-w', `${EXHIBIT_SIZE.width / devicePixelRatio}px`);
    view.style.setProperty('--actual-h', `${EXHIBIT_SIZE.height / devicePixelRatio}px`);
    actualBar.update(resolution, look.upscale === 'pixel');
    fq.controllers.forEach((c) => c.updateDisplay());
    onResolution({ ...resolution });
  };
  const OUTPUTS: Record<string, RoomOutput> = {
    '画面の枠の大きさ': 'view',
    [`${EXHIBIT_SIZE.width}×${EXHIBIT_SIZE.height} を縮めて見る（シミュレーション）`]: 'exhibit',
    [`${EXHIBIT_SIZE.width}×${EXHIBIT_SIZE.height} を原寸で見る（はみ出す分はスクロール）`]: 'actual',
  };
  fq.add(resolution, 'output', OUTPUTS).name('見え方').onChange(changed);
  fq.add(resolution, 'scale', 0.1, 1, 0.05).name('計算の解像度（倍）').onChange(changed);
  for (const sc of SCALE_PRESETS) {
    fq.add({ [`p${sc}`]: () => { resolution.scale = sc; changed(); } }, `p${sc}`).name(`計算の解像度 ${Math.round(sc * 100)}%`);
  }
  fq.add(look, 'upscale', { 'なめらか（線形補間）': 'smooth', '画素のまま（ドット）': 'pixel' }).name('引き伸ばし方').onChange(changed);
  fq.add(pace, 'fps', { '画面の更新ごと（多くは 60fps）': 0, '30fps に固定': 30 }).name('フレームの速さ');
  fq.add({ run: () => { void view.requestFullscreen?.(); } }, 'run').name('全画面で見る（Esc で戻る）');
  changed();

  // 視点・パース合わせ：現地で投影するとき、見る人の位置から見て、映像の部屋が実際の空間とつながって見えるように合わせる。
  // 投影面（映像が映る面）と目の位置を実寸で入れると、画角とレンズシフトが決まる。最後に四隅の位置合わせで、投影のずれを直す
  // ?view=fixed で、最初から現地に合わせた視点で見る
  const calib: ViewCalibration = { ...base.calibration, mode: oneOf(q.get('view') ?? base.calibration.mode, ['free', 'fixed'] as const, 'free') };
  const calibChanged = (): void => hooks.onCalibration({ ...calib });
  const fp = gui.addFolder('視点・パース合わせ');
  // パース調整モード：現地で投影を見ながら合わせる画面（src/ui/calib-mode.ts）。?calib=1 で最初から入る
  let calibMode: ReturnType<typeof mountCalibMode> | null = null;
  fp.add({ run: () => calibMode?.toggle() }, 'run').name('パース調整モード（入る・終わる。キー C で終わる）');
  const preset = hooks.venuePreset;
  if (preset) {
    fp.add({ run: () => {
      Object.assign(room, preset.room);
      Object.assign(calib, { ...preset.calibration, mode: 'fixed' });
      if (preset.windowSide) { Object.assign(openings, openingsFromChoice(preset.windowSide, openings)); fr.controllersRecursive().forEach((c) => c.updateDisplay()); applyOpenings(); }
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      roomChanged();
      calibChanged();
    } }, 'run').name(`会場の値を入れる（${preset.label}）`);
  }
  fp.add(calib, 'mode', { 'マウスで自由に動かす': 'free', '現地に合わせた視点（固定）': 'fixed' }).name('視点').onChange(calibChanged);
  const calibCtl = [
    fp.add(calib, 'planeWidthM', 0.5, 40, 0.01).name('投影面：幅（m）'),
    fp.add(calib, 'planeHeightM', 0, 20, 0.01).name('投影面：高さ（m、0 で画面の縦横比から）'),
    fp.add(calib, 'planeBottomM', -3, 10, 0.01).name('投影面：下端の高さ（床から m）'),
    fp.add(calib, 'planeDepthM', -10, 40, 0.01).name('投影面：位置（部屋の手前の端から奥へ m）'),
    fp.add(calib, 'planeXM', -20, 20, 0.01).name('投影面：左右のずれ（m、右が正）'),
    fp.add(calib, 'planeYawDeg', -45, 45, 0.1).name('投影面の向き：左右（度）'),
    fp.add(calib, 'planePitchDeg', -45, 45, 0.1).name('投影面の向き：上下（度）'),
    fp.add(calib, 'planeRollDeg', -45, 45, 0.1).name('投影面の向き：回転（度）'),
    fp.add(calib, 'eyeDistM', 0.3, 40, 0.01).name('目の位置：投影面からの距離（m）'),
    fp.add(calib, 'eyeHeightM', 0, 6, 0.01).name('目の位置：高さ（床から m）'),
    fp.add(calib, 'eyeXM', -20, 20, 0.01).name('目の位置：左右（m、右が正）'),
  ];
  calibCtl.forEach((c) => c.onChange(calibChanged));
  fp.add({ run: () => { Object.assign(calib, { ...defaultCalibration(room), mode: calib.mode }); calibCtl.forEach((c) => c.updateDisplay()); calibChanged(); } }, 'run').name('投影面と目の位置を初期値に戻す');

  // 合わせるための線：部屋の辺（白）・床の格子（青）・窓（緑）・スクリーン（黄）・ライト（橙）
  const guides: GuideOptions = { ...base.guides, show: on('guides', base.guides.show) };
  const guidesChanged = (): void => hooks.onGuides({ ...guides });
  fp.add(guides, 'show').name('合わせるための線を出す').onChange(guidesChanged);
  fp.add(guides, 'gridM', 0, 5, 0.25).name('床の格子の間隔（m、0 で消す）').onChange(guidesChanged);

  // 四隅の位置合わせ（台形補正）：映像の四隅を、幅・高さの % でずらす。投影面の形にぴったり合わせる最後の調整
  const stage = el('roomStage', HTMLElement);
  const warpPct = { ...base.warp };
  const corners = (): WarpCorners => {
    const w = warpPct;
    return [[w.tlx / 100, w.tly / 100], [w.trx / 100, w.try / 100], [w.brx / 100, w.bry / 100], [w.blx / 100, w.bly / 100]];
  };
  const applyWarp = (): void => { stage.style.transform = warpCss(stage.clientWidth, stage.clientHeight, corners()); };
  new ResizeObserver(applyWarp).observe(stage);
  const fw4 = fp.addFolder('四隅の位置合わせ（台形補正、%）');
  const warpNames: [keyof typeof warpPct, string][] = [
    ['tlx', '左上：横'], ['tly', '左上：縦'], ['trx', '右上：横'], ['try', '右上：縦'],
    ['brx', '右下：横'], ['bry', '右下：縦'], ['blx', '左下：横'], ['bly', '左下：縦'],
  ];
  for (const [k, label] of warpNames) fw4.add(warpPct, k, -25, 25, 0.05).name(label).onChange(applyWarp);
  fw4.add({ run: () => { for (const [k] of warpNames) warpPct[k] = 0; fw4.controllers.forEach((c) => c.updateDisplay()); applyWarp(); } }, 'run').name('四隅を元に戻す');
  fw4.close();

  // ガラスの壁：面ごとに、枠なしの一枚ガラスにする（外は空と海。光も景色も通り、部屋の中が映り込む）。窓（穴）の所は窓のまま
  const fgl = gui.addFolder('ガラスの壁（窓の所は穴のまま、残りを一枚ガラスに）');
  const GLASS_LABEL: Record<GlassFace, string> = { right: '右の壁', left: '左の壁', ceiling: '天井（天窓のときは、天窓のまわりの天井）', front: '手前の壁（見る人の側）', back: '奥の壁（スクリーンの側）' };
  for (const f of GLASS_FACES) fgl.add(settings.glass, f).name(GLASS_LABEL[f]);
  // ガラスの仕様と表面の形（すべてのガラスの面に共通）
  const gsp = settings.glassSpec;
  fgl.add(gsp, 'kind', { '高透過ガラス（低鉄。ほぼ無色）': 'lowIron', '普通の板ガラス（わずかに緑）': 'float', '色付きガラス': 'tinted' }).name('ガラスの種類').onChange(() => showGlass());
  const cGlassColor = fgl.addColor(gsp, 'color').name('ガラスの色（色付きのとき）');
  fgl.add(gsp, 'transmission', 0, 1, 0.01).name('透過率の倍率');
  fgl.add(gsp, 'surface', { '平ら': 'flat', '波打ち（水面のような細かい波）': 'wave', 'うねり（大きくゆるやかな波）': 'swell', 'リブ（縦の筋）': 'reeded' }).name('表面の形').onChange(() => showGlass());
  const cGlassScale = fgl.add(gsp, 'scaleM', 0.02, 1.5, 0.01).name('模様の大きさ（m）');
  const cGlassDepth = fgl.add(gsp, 'depthMM', 0, 5, 0.05).name('表面の深さ（mm。深いほどゆがみと光の網目が強い）');
  const cGlassPrism = fgl.add(gsp, 'prism').name('通る光にプリズム（虹）を出す').onChange(() => showGlass());
  const cGlassPrismK = fgl.add(gsp, 'prismStrength', 1, 60, 1).name('虹の強さ（本物の何倍か）');
  const showGlass = (): void => {
    const wavy = gsp.surface !== 'flat';
    cGlassColor.show(gsp.kind === 'tinted');
    cGlassScale.show(wavy);
    cGlassDepth.show(wavy);
    cGlassPrism.show(wavy);
    cGlassPrismK.show(wavy && gsp.prism);
  };
  showGlass();

  // 水：3 つはそれぞれ独立に出し消しできる（窓の外の 2 つは、壁の窓のときだけ効く）
  const fw = gui.addFolder('水');
  fw.add(settings, 'seaView').name('窓の外の海').onChange(() => showSeaSplit());
  fw.add(settings, 'seaRipples').name('窓の外の水面の反射（天井・壁の揺らぎ）');
  fw.add(settings, 'pool').name('床の水盤');
  fw.add(settings, 'poolReflect').name('床の水盤で跳ね返った光（壁・天井の揺らぎ）');
  fw.add(settings, 'waveAmp', 0, 3, 0.05).name('波の強さ');
  fw.add(settings, 'poolDepthM', 0.02, 1.5, 0.01).name('水盤の深さ（m）');
  fw.add(settings, 'seaLevelM', -5, 0, 0.05).name('窓の外の水面の高さ（床から m）');
  fw.add(settings, 'seaWaves', { 'FFT（海の波の統計から。WebGPU のとき）': 'fft', '正弦波 20 本（前の作り方）': 'sines' }).name('海の波の作り方').onChange(() => showSeaSplit());
  fw.add(settings, 'seaCompare').name('正弦波の海と FFT の海を比べる（手前側：正弦波・奥側：FFT）').onChange(() => showSeaSplit());
  fw.add(settings, 'seaWindMS', 0.5, 20, 0.1).name('海の上の風速（m/s、FFT のとき）');
  fw.add(settings, 'seaWaveScale', 0, 3, 0.01).name('海の波の高さの倍率（FFT のとき）');
  // 比べるときは、映像の左上に札を出す（海を窓の奥行きの真ん中で分け、手前側が正弦波・奥側が FFT。WebGPU のときだけ分かれる）
  const seaSplit = document.createElement('div');
  seaSplit.style.cssText = 'position:absolute;top:8px;left:8px;pointer-events:none;z-index:5;font:12px sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:3px 8px;border-radius:4px;';
  seaSplit.textContent = '海を比べている：手前側（見る人の側）＝正弦波の海（前）／奥側（スクリーンの側）＝FFT の海（今）';
  document.getElementById('roomStage')?.append(seaSplit);
  const showSeaSplit = (): void => { seaSplit.style.display = settings.seaCompare && settings.seaView && settings.seaWaves === 'fft' ? '' : 'none'; };
  showSeaSplit();
  fw.add(settings, 'seaRoughness', 0.0005, 0.03, 0.0005).name('海面の細かい粗さ（大きいほど太陽のきらめきが広い帯に）');
  fw.add(settings, 'seaScatter', 0, 3, 0.05).name('海の波の山が透ける強さ');

  // 空・雲：窓から見える空に雲が流れ、太陽を横切ると日差しが弱まる（雲の影が部屋を通り過ぎる）
  const fc = gui.addFolder('空・雲');
  fc.add(settings, 'clouds').name('窓の外の空に雲');
  fc.add(settings, 'cloudShadow').name('雲が日差しをさえぎる（雲の影）');
  fc.add(settings, 'cloudAmount', 0, 1, 0.01).name('雲の量');
  fc.add(settings, 'cloudOpacity', 0, 1, 0.01).name('雲の厚さ（さえぎる割合）');
  fc.add(settings, 'cloudSizeM', 100, 5000, 10).name('雲のかたまりの大きさ（m）');
  fc.add(settings, 'cloudHeightM', 300, 6000, 50).name('雲の高さ（m）');
  fc.add(settings, 'windMS', 0, 200, 1).name('雲の流れる速さ（m/s）');
  fc.add(settings, 'windFromDeg', 0, 360, 1).name('風が吹いてくる方位（度、北 0・東 90）');

  // スクリーン：visuals の映像を、奥の壁のスクリーンに投影したように映す（調整値は config/visuals.json の保存値）
  const fs = gui.addFolder('スクリーン');
  fs.add(settings, 'screenArea').name('奥の壁に投影する場所を示す');
  fs.add(settings, 'screen').name('スクリーンに映像を映す');
  fs.add(screen, 'id', Object.fromEntries(SCENES.map((d) => [d.label, d.id]))).name('映す映像');
  fs.add(settings, 'screenGain', 0, 3, 0.01).name('プロジェクターの明るさ');

  // プリズム：窓に吊ったプリズムが日差しを虹に分ける。水の光の揺らぎの縁も虹色ににじむ（?prism=1 で最初からオン）
  const pr = settings.prism;
  const prismParam = q.get('prism');
  if (prismParam !== null) {
    pr.on = prismParam !== '0';
    if ((PRISM_PATTERNS as readonly string[]).includes(prismParam)) pr.pattern = prismParam as PrismPattern;
    if (prismParam === 'waves' || prismParam === 'organic' || prismParam === 'blobs' || prismParam === 'shimmer') { pr.pattern = 'none'; pr[prismParam].on = true; }
  }
  for (const k of ['waves', 'organic', 'blobs', 'shimmer'] as const) {
    const v = q.get(k);
    if (v === null) continue;
    pr[k].on = v !== '0';
    if (pr[k].on) pr.on = true;
  }
  const fpz = gui.addFolder('プリズム（虹色の光）');
  fpz.add(pr, 'on').name('虹を出す');
  fpz.add(pr, 'pattern', Object.fromEntries(PRISM_PATTERNS.map((k) => [PRISM_PATTERN_LABEL[k], k]))).name('出し方').onChange(() => showPrism());
  const pzA = fpz.addFolder('A：日だまりの中に虹の筋');
  pzA.add(pr.streaks, 'strength', 0, 3, 0.01).name('明るさ');
  pzA.add(pr.streaks, 'amount', 0, 1, 0.01).name('筋の多さ');
  pzA.add(pr.streaks, 'lengthM', 0.1, 3, 0.05).name('筋の長さ（m）');
  pzA.add(pr.streaks, 'angleDeg', -180, 180, 1).name('筋の向き（度）');
  const pzB = fpz.addFolder('B：窓に吊るプリズム');
  pzB.add(pr.hung, 'count', 1, MAX_PRISMS, 1).name('プリズムの数');
  pzB.add(pr.hung, 'facets', 1, 4, 1).name('1 つのプリズムから出る虹の数（面の数）');
  pzB.add(pr.hung, 'strength', 0, 5, 0.01).name('虹の明るさ');
  pzB.add(pr.hung, 'sizeM', 0.02, 0.4, 0.005).name('プリズムの大きさ（m）');
  pzB.add(pr.hung, 'deviationDeg', 5, 70, 0.5).name('光が曲がる角度（度）');
  pzB.add(pr.hung, 'dispersionDeg', 0.5, 30, 0.1).name('虹の広がり（赤と紫の差、度）');
  pzB.add(pr.hung, 'dropM', 0, 3, 0.05).name('吊る位置：窓の上の端から下へ（m）');
  const pzC = fpz.addFolder('C：窓をプリズムの板で覆う');
  pzC.add(pr.panel, 'strength', 0, 2, 0.01).name('明るさ（板を通る割合）');
  pzC.add(pr.panel, 'deviationDeg', 0, 45, 0.5).name('光が曲がる角度（度）');
  pzC.add(pr.panel, 'dispersionDeg', 0.5, 30, 0.1).name('虹の広がり（赤と紫の差、度）');
  pzC.add(pr.panel, 'ridgeAngleDeg', -180, 180, 1).name('曲がる向き（板の稜の向き、度）');
  const pzD = fpz.addFolder('D：日差しの先に虹の筋');
  pzD.add(pr.beams, 'count', 1, MAX_PRISMS, 1).name('光の束の数');
  pzD.add(pr.beams, 'strength', 0, 5, 0.01).name('虹の明るさ');
  pzD.add(pr.beams, 'widthM', 0.02, 0.4, 0.005).name('束の太さ（m）');
  pzD.add(pr.beams, 'blur', 0, 0.15, 0.001).name('進むにつれてぼける割合');
  pzD.add(pr.beams, 'deviationDeg', 0, 45, 0.5).name('光が曲がる角度（度）');
  pzD.add(pr.beams, 'dispersionDeg', 0.5, 20, 0.1).name('虹の広がり（赤と紫の差、度）');
  pzD.add(pr.beams, 'ridgeAngleDeg', -180, 180, 1).name('虹の色が並ぶ向き（稜の向き、度）');
  // E・F・G 共通の、縁の見え方の項目（unit は長さの単位の書き方、max は長さの上限）
  const addLook = (f: GUI, o: OrganicLook, unit: string, max: number): void => {
    f.add(o, 'fringe', -max / 2, max / 2, max / 400).name(`縁の色の帯の幅（${unit}、負で色の並びが逆）`);
    f.add(o, 'soft', 0.001, max / 4, max / 1000).name(`縁のぼかし（${unit}）`);
    f.add(o, 'saturation', 0, 3, 0.01).name('色の濃さ');
    f.add(o, 'halo', 0, 2, 0.01).name('外へ広がる光の明るさ');
    f.add(o, 'haloWidth', 0.01, max * 2, max / 200).name(`外へ広がる幅（${unit}）`);
    f.add(o, 'haloHue', 0, 1, 0.01).name('外へ広がる光の色合い（赤 0 → 黄 → 緑 → 水色 → 青 → 紫 1）');
  };
  const pzE = fpz.addFolder('E：波のプリズム（水盤の日だまりの縁が波で揺れる。A〜D と重ねられる）');
  pzE.add(pr.waves, 'on').name('波のプリズムを重ねる');
  pzE.add(pr.waves, 'wobbleM', 0, 0.5, 0.005).name('波で縁が揺れる大きさ（m）');
  pzE.add(pr.waves, 'waveLengthM', 0.2, 4, 0.05).name('波の長さ（m）');
  pzE.add(pr.waves, 'speed', 0, 1, 0.01).name('波の進む速さ（m/秒）');
  addLook(pzE, pr.waves, 'm', 0.6);
  const pzF = fpz.addFolder('F：有機的な日だまりの縁（A〜D と重ねられる）');
  pzF.add(pr.organic, 'on').name('有機的な縁を重ねる');
  pzF.add(pr.organic, 'wobbleM', 0, 0.3, 0.005).name('縁が揺れる大きさ（m）');
  pzF.add(pr.organic, 'scaleM', 0.03, 1.5, 0.01).name('揺らぎの模様の大きさ（m）');
  pzF.add(pr.organic, 'speed', 0, 1, 0.01).name('形が変わる速さ');
  pzF.add(pr.organic, 'pastel', 0, 1, 0.01).name('内側の淡い色');
  addLook(pzF, pr.organic, 'm', 0.4);
  const pzG = fpz.addFolder('G：虹のしみ（A〜D と重ねられる）');
  pzG.add(pr.blobs, 'on').name('虹のしみを重ねる');
  pzG.add(pr.blobs, 'count', 1, MAX_BLOBS, 1).name('しみの数');
  pzG.add(pr.blobs, 'strength', 0, 10, 0.05).name('明るさ');
  pzG.add(pr.blobs, 'sizeM', 0.05, 1, 0.01).name('しみの大きさ（m、窓の所で）');
  pzG.add(pr.blobs, 'grow', 0, 0.4, 0.005).name('進むにつれて大きくなる割合');
  pzG.add(pr.blobs, 'deviationDeg', 0, 45, 0.5).name('光が曲がる角度（度）');
  pzG.add(pr.blobs, 'wobble', 0, 0.8, 0.01).name('形の崩れ方');
  pzG.add(pr.blobs, 'speed', 0, 1, 0.01).name('形が変わる速さ');
  pzG.add(pr.blobs, 'pastel', 0, 1, 0.01).name('内側の淡い色');
  addLook(pzG, pr.blobs, '半径に対する割合', 1);
  const pzH = fpz.addFolder('H：水のきらめき（日なたに水底のような光の網目。A〜G と重ねられる）');
  pzH.add(pr.shimmer, 'on').name('水のきらめきを重ねる');
  pzH.add(pr.shimmer, 'amount', 0, 1, 0.01).name('重ねる強さ');
  pzH.add(pr.shimmer, 'anchor', { '日差しと一緒に動く（斜めの面では伸びる）': 'light', '面に固定（どこでも大きさが変わらない）': 'surface' }).name('網目の置き方');
  pzH.add(pr.shimmer, 'scaleM', 0.05, 1.5, 0.01).name('網目の大きさ（m）');
  pzH.add(pr.shimmer, 'lineWidth', 0.01, 0.3, 0.005).name('線の太さ（網目に対する割合）');
  pzH.add(pr.shimmer, 'warp', 0, 2, 0.01).name('網目のゆがみ（大きいほど丸く流れる）');
  pzH.add(pr.shimmer, 'speed', 0, 2, 0.01).name('形が変わる速さ');
  pzH.add(pr.shimmer, 'base', 0, 1.5, 0.01).name('線のない所の明るさ');
  pzH.add(pr.shimmer, 'gain', 0, 6, 0.05).name('線の明るさ');
  pzH.add(pr.shimmer, 'dispersion', -0.2, 0.2, 0.002).name('線の縁の虹のずれ（網目に対する割合）');
  pzH.add(pr.shimmer, 'iridescence', 0, 1, 0.01).name('線のまわりの膜のような虹色');
  // 色：虹の色の範囲から取るか、選んだ色を並べるか。線の縁の色の数、線と地の色合い、色の濃さ
  pzH.add(pr.shimmer, 'colorMode', { '虹の色の範囲から': 'spectrum', '選んだ色を並べる': 'palette' }).name('色の決め方').onChange(() => showShimColor());
  pzH.add(pr.shimmer, 'colorCount', 3, MAX_SHIM_COLORS, 1).name('線の縁に並べる色の数');
  const cHue0 = pzH.add(pr.shimmer, 'hueStart', 0, 1, 0.01).name('虹の色の範囲：始め（赤 0 → 黄 → 緑 → 水色 → 青 → 紫 1）');
  const cHue1 = pzH.add(pr.shimmer, 'hueEnd', 0, 1, 0.01).name('虹の色の範囲：終わり');
  const cPalN = pzH.add(pr.shimmer, 'paletteCount', 2, MAX_SHIM_PALETTE, 1).name('使う色の数').onChange(() => showShimColor());
  const cPal = Array.from({ length: MAX_SHIM_PALETTE }, (_, i) => pzH.addColor(pr.shimmer.palette, i).name(`色 ${i + 1}`));
  pzH.addColor(pr.shimmer, 'lineColor').name('線の色合い');
  pzH.addColor(pr.shimmer, 'baseColor').name('線のない所の色合い');
  pzH.add(pr.shimmer, 'saturation', 0, 2, 0.01).name('色の濃さ（0 で白黒）');
  const showShimColor = (): void => {
    const pal = pr.shimmer.colorMode === 'palette';
    cHue0.show(!pal);
    cHue1.show(!pal);
    cPalN.show(pal);
    cPal.forEach((c, i) => c.show(pal && i < Math.round(pr.shimmer.paletteCount)));
  };
  showShimColor();
  const cViv = fpz.add(pr, 'vividness', 0, 1, 0.01).name('日なたの虹の色を際立たせる（A・B・D）');
  const cMotion = fpz.add(pr, 'motion', Object.fromEntries(PRISM_MOTIONS.map((k) => [PRISM_MOTION_LABEL[k], k]))).name('プリズムの動き方（B・D）').onChange(() => showPrism());
  const cSway = fpz.add(pr, 'swayDeg', 0, 90, 1).name('揺れの大きさ（度）');
  const cSpeed = fpz.add(pr, 'speed', 0, 1, 0.01).name('動く速さ（A：筋の揺れ、B・D：プリズムの動き）');
  fpz.add(pr, 'causticSpreadM', 0, 0.2, 0.005).name('水の光の揺らぎのにじみ（m）');
  const showPrism = (): void => {
    pzA.show(pr.pattern === 'streaks');
    pzB.show(pr.pattern === 'hung');
    pzC.show(pr.pattern === 'panel');
    pzD.show(pr.pattern === 'beams');
    cViv.show(pr.pattern !== 'panel' && pr.pattern !== 'none');
    cSpeed.show(pr.pattern !== 'panel' && pr.pattern !== 'none');
    const moving = pr.pattern === 'hung' || pr.pattern === 'beams';
    cMotion.show(moving);
    cSway.show(moving && (pr.motion === 'sway' || pr.motion === 'wind'));
  };
  showPrism();
  fpz.add({ run: () => {
    // 中の項目のまとまり（streaks など）は、パネルがつながっている同じものに値だけ写す
    const { streaks, hung, panel, beams, waves, organic, blobs, shimmer } = pr;
    Object.assign(pr, { ...PRISM_DEFAULTS, on: pr.on, pattern: pr.pattern, streaks, hung, panel, beams, waves, organic, blobs, shimmer });
    Object.assign(streaks, PRISM_DEFAULTS.streaks);
    Object.assign(hung, PRISM_DEFAULTS.hung);
    Object.assign(panel, PRISM_DEFAULTS.panel);
    Object.assign(beams, PRISM_DEFAULTS.beams);
    Object.assign(waves, PRISM_DEFAULTS.waves);
    Object.assign(organic, PRISM_DEFAULTS.organic);
    Object.assign(blobs, PRISM_DEFAULTS.blobs);
    const { palette } = shimmer;
    Object.assign(shimmer, PRISM_DEFAULTS.shimmer, { palette });
    palette.splice(0, palette.length, ...PRISM_DEFAULTS.shimmer.palette);
    fpz.controllersRecursive().forEach((c) => c.updateDisplay());
    showPrism();
    showShimColor();
  } }, 'run').name('プリズムの設定を既定に戻す（出し方はそのまま）');
  // 保存はパネルのいちばん上の「部屋の設定を保存」と同じ（プリズムだけでなく、パネルの今の値をまとめて config/room.json に書く）
  fpz.add({ run: doSave }, 'run').name('プリズムの設定を保存（部屋の設定と一緒に config/room.json へ）');
  fpz.add(saveState, 'text').name('保存').disable().listen();

  // 光の軌跡：部屋の中央の空間を、たくさんの光の線が漂う（three-line-trails と同じ考え方の演出を書き直したもの）
  const tr = settings.trails;
  const ft = gui.addFolder('光の軌跡');
  ft.add(tr, 'on').name('部屋の中央に光の軌跡を出す');
  ft.add(tr, 'count', 16, 4096, 1).name('線の本数');
  ft.add(tr, 'points', 4, 128, 1).name('軌跡の長さ（点の数）');
  ft.add(tr, 'widthPx', 0.5, 20, 0.1).name('太さ（3840 幅での画素）');
  ft.add(tr, 'brightness', 0, 3, 0.01).name('明るさ');
  ft.add(tr, 'speed', 0.05, 5, 0.01).name('速さ（m/s）');
  ft.add(tr, 'turbulence', 0.05, 4, 0.01).name('流れの細かさ');
  ft.add(tr, 'spread', 0, 4, 0.01).name('線ごとのばらつき');
  ft.add(tr, 'radiusM', 0.2, 5, 0.05).name('漂う範囲（半径 m）');
  ft.add(tr, 'centerHeightM', 0.2, 10, 0.05).name('中心の高さ（床から m）');
  ft.add(tr, 'centerFromFrontM', 0, 40, 0.05).name('中心の位置（手前の端から奥へ m、0 = 部屋の中央）');
  ft.add(tr, 'colorMode', { '日差し・ライトの色に合わせる': 'scene', '線ごとに色相をずらす（元の演出に近い）': 'hue', '色を選ぶ': 'color' }).name('色の決め方').onChange(() => showTrailColor());
  const cTc = ft.addColor(tr, 'color').name('色（基準の色）');
  const cTh = ft.add(tr, 'hueSpread', 0, 1, 0.01).name('色相をずらす幅');
  const showTrailColor = (): void => { cTc.show(tr.colorMode !== 'scene'); cTh.show(tr.colorMode === 'hue'); };
  showTrailColor();
  ft.add({ run: () => { Object.assign(tr, { ...TRAIL_DEFAULTS, on: tr.on }); ft.controllers.forEach((c) => c.updateDisplay()); showTrailColor(); } }, 'run').name('光の軌跡の設定を既定に戻す');

  // ライト（夜）：鑑賞者の頭上のスポットライト。太陽が沈んで窓から光が入らなくなると、代わりに部屋を照らす。
  // 点け方と自動で点く高度は全部のライトで共通。明るさ・形・向き・位置・色はライトごと
  const spot = settings.spot;
  const fl = gui.addFolder('ライト（夜）');
  fl.add(spot, 'mode', Object.fromEntries(SPOT_MODES.map((m) => [SPOT_MODE_LABEL[m], m]))).name('点け方');
  fl.add(spot, 'kind', Object.fromEntries(LIGHT_KINDS.map((k) => [LIGHT_KIND_LABEL[k], k]))).name('照明の種類').onChange(() => showLights());
  fl.add(spot, 'onAltDeg', -18, 20, 0.5).name('自動：点き始める太陽の高度（度）');
  fl.add(spot, 'fullAltDeg', -18, 20, 0.5).name('自動：最大になる太陽の高度（度）');
  // 全体照明
  const fa = fl.addFolder('全体照明');
  fa.add(spot.ambient, 'strength', 0, 5, 0.01).name('明るさ');
  fa.add(spot.ambient, 'marginM', 0, Math.min(room.widthM, room.depthM) / 2 - 0.1, 0.05).name('光る面：天井の端から内側へ（m）');
  fa.add(spot.ambient, 'kelvin', 1800, 10000, 50).name('色温度（K）');
  // スポットライト
  const cCount = fl.add(spot, 'count', 1, MAX_SPOTS, 1).name('台数').onChange(() => showLights());
  const cLamp = fl.add(spot, 'showLamp').name('ライトの器具を描く（照らす光は変わらない）');
  const lightFolders = spot.lights.map((light, i) => {
    const f = fl.addFolder(`ライト ${i + 1}`);
    f.add(light, 'strength', 0, 5, 0.01).name('明るさ');
    f.add(light, 'beamDeg', 5, 160, 1).name('光の広がり（度）');
    f.add(light, 'softness', 0, 1, 0.01).name('縁のぼけ');
    f.add(light, 'tiltDeg', 0, 90, 1).name('傾き（真下 0°・奥へ倒す）');
    f.add(light, 'panDeg', -90, 90, 1).name('左右の向き（度、右が正）');
    f.add(light, 'fromFrontM', 0.05, room.depthM - 0.05, 0.05).name('位置：手前の端から（m）');
    f.add(light, 'belowCeilingM', 0, room.heightM - 0.1, 0.05).name('位置：天井から（m）');
    f.add(light, 'xM', -room.widthM / 2 + 0.05, room.widthM / 2 - 0.05, 0.05).name('位置：左右（m、右が正）');
    f.add(light, 'colorMode', { '色温度で決める': 'kelvin', '色を選ぶ': 'color' }).name('色の決め方').onChange(() => showColor());
    const cK = f.add(light, 'kelvin', 1800, 10000, 50).name('色温度（K）');
    const cC = f.addColor(light, 'color').name('色');
    const showColor = (): void => { cK.show(light.colorMode === 'kelvin'); cC.show(light.colorMode === 'color'); };
    showColor();
    f.add({ run: () => { Object.assign(light, spotLightDefault(i)); f.controllers.forEach((c) => c.updateDisplay()); showColor(); } }, 'run').name('このライトを既定に戻す');
    if (i > 0) f.close();
    return f;
  });
  const showLights = (): void => {
    const isSpot = spot.kind === 'spot';
    fa.show(!isSpot);
    cCount.show(isSpot);
    cLamp.show(isSpot);
    lightFolders.forEach((f, i) => f.show(isSpot && i < spot.count));
  };
  showLights();

  // 日差しと空の色：太陽の高度ごとの日差しの色温度と、空の色の表（src/palette.ts の目安の値）を変える。
  // 現地の光に合わせて追い込むため。間の高度は、前後の値をなめらかにつなぐ。room モードの表示と光の計算に効く
  const pal: PaletteTable = { kelvin: [...base.palette.kelvin], sky: base.palette.sky.map((c) => ({ ...c })) };
  setPalette(pal);
  const palChanged = (): void => setPalette(pal);
  const fpal = gui.addFolder('日差しと空の色（太陽の高度ごと）');
  const altLabel = (alts: readonly number[], i: number): string =>
    i === 0 ? `太陽 ${alts[i]}° 以下` : i === alts.length - 1 ? `太陽 ${alts[i]}° 以上` : `太陽 ${alts[i]}°`;
  const fk = fpal.addFolder('日差しの色温度（K）');
  PALETTE_KELVIN_ALTS.forEach((_, i) => fk.add(pal.kelvin as unknown as Record<string, number>, String(i), 1000, 12000, 50).name(altLabel(PALETTE_KELVIN_ALTS, i)).onChange(palChanged));
  const fsk = fpal.addFolder('空の色（上・地平線の近く）');
  PALETTE_SKY_ALTS.forEach((_, i) => {
    fsk.addColor(pal.sky[i]!, 'top').name(`${altLabel(PALETTE_SKY_ALTS, i)}：上`).onChange(palChanged);
    fsk.addColor(pal.sky[i]!, 'bottom').name(`${altLabel(PALETTE_SKY_ALTS, i)}：地平線の近く`).onChange(palChanged);
  });
  fpal.add({ run: () => {
    const d = defaultPalette();
    d.kelvin.forEach((k, i) => { pal.kelvin[i] = k; });
    d.sky.forEach((c, i) => Object.assign(pal.sky[i]!, c));
    [...fk.controllers, ...fsk.controllers].forEach((c) => c.updateDisplay());
    palChanged();
  } }, 'run').name('日差しと空の色を既定に戻す');
  fpal.close();

  // 月明かり（夜）：太陽が沈むと、太陽の代わりに月が窓から光を差し込み、夜空も明るくなる
  const mn = settings.moon;
  const fm = gui.addFolder('月明かり（夜）');
  fm.add(mn, 'on').name('月明かりを点ける（太陽が沈むと点く）');
  fm.add(mn, 'strength', 0, 5, 0.01).name('月の光の明るさ');
  fm.add(mn, 'skyStrength', 0, 5, 0.01).name('夜空の明るさ');
  fm.addColor(mn, 'color').name('色');
  fm.add(mn, 'azimuthDeg', 0, 360, 1).name('月の方位（度、北 0・東 90）');
  fm.add(mn, 'altitudeDeg', 1, 89, 1).name('月の高度（度）');
  fm.add(mn, 'onAltDeg', -18, 10, 0.5).name('点き始める太陽の高度（度）');
  fm.add(mn, 'fullAltDeg', -18, 10, 0.5).name('最大になる太陽の高度（度）');
  fm.add(mn, 'mode', {
    'A：部屋も海も、窓の真ん中の向きの低い月（向きがそろう）': 'low',
    'B：部屋も海も、方位・高度で決めた月（本物どおり）': 'set',
    '前の作り方：部屋は決めた月、海だけ低い月（向きがそろわない）': 'split',
    '本物の月（日時から位置と満ち欠け。月が出ていない・新月の夜は暗い）': 'real',
    '本物の月の位置で、いつも満月の明るさ': 'realFull',
  }).name('月の置き方');
  fm.add(mn, 'seaRoadStrength', 0, 20, 0.1).name('海に映す月の光の明るさ（0 で海に光の道を出さない）');
  fm.add(mn, 'seaRoadOffsetDeg', -80, 80, 1).name('低い月の向き：窓の真ん中から奥へ（度、A と前の作り方）');
  fm.add(mn, 'seaRoadAltDeg', 1, 60, 0.5).name('低い月の高度（度。低いほど光の道が長く、部屋の奥まで差し込む）');
  fm.add({ run: () => { Object.assign(mn, { ...MOON_DEFAULTS, on: mn.on }); fm.controllers.forEach((c) => c.updateDisplay()); } }, 'run').name('月明かりの設定を既定に戻す');

  mountTimeControls(gui, clock);

  // 保存する中身（パネルの今の値）
  const collect = (): RoomSettingsFile => {
    const { window: _w, spot: _s, ...render } = settings;
    return {
      version: 1, windowSide: state.side, room: { ...room }, window: { ...win }, render, screenScene: screen.id,
      spot: { ...spot, lights: spot.lights.map((l) => ({ ...l })) },
      resolution: { ...resolution, upscale: look.upscale, fps: pace.fps }, palette: { kelvin: [...pal.kelvin], sky: pal.sky.map((c) => ({ ...c })) }, calibration: { ...calib }, guides: { ...guides }, warp: { ...warpPct },
    };
  };

  // パネルの今の値を、同じブラウザ（アプリ）の他の画面と分け合う（site モードの「映すもの」がこの値で描く。src/room/live-share.ts）
  shareRoomSettings(collect);

  // パース調整モード（パネルの「視点・パース合わせ」のボタン・キー C・?calib=1）
  calibMode = mountCalibMode({
    gui, keep: [fr, fp], view, calib, room, warp: warpPct, guides,
    onCalibration: calibChanged,
    onRoomSize: roomChanged,
    onWarp: applyWarp,
    onGuides: guidesChanged,
    save: doSave,
  });
  if (q.get('calib') === '1') calibMode.enter();

  const statusEl = el('room-status', HTMLElement);
  const sameAsConfig = (): boolean =>
    win.widthM === configWindow.widthM && win.heightM === configWindow.heightM && win.sillHeightM === configWindow.sillHeightM;
  const windowSizeText = (): string => openingsText(openings, room);
  return {
    settings,
    /** スクリーンに映す映像 */
    get screenScene(): SceneDef { return findScene(screen.id); },
    /** 窓の位置（URL・保存した値・既定から決めたもの。切り替えると onWindowSide） */
    get side(): WindowSide { return state.side; },
    /** 計算の解像度・出す大きさ */
    get resolution(): RoomResolution { return { ...resolution }; },
    /** フレームの速さの上限（0 = 画面の更新ごと、30 = 30fps に固定） */
    get frameRate(): number { return pace.fps; },
    /** 部屋の寸法（パネルで変えたもの） */
    get room(): RoomGeometry { return { ...room }; },
    /** パース合わせの視点 */
    get calibration(): ViewCalibration { return { ...calib }; },
    /** 合わせるための線 */
    get guides(): GuideOptions { return { ...guides }; },
    /** 四隅の位置合わせ */
    get warp(): WarpCorners { return corners(); },
    /** @param fps 画面の更新の速さ（毎フレームの間隔をならしたもの。画面の上限、多くは 60 で頭打ちになる） */
    updateStatus(s: SolarState, lit: number, samples: number, backend: Backend, size: { width: number; height: number }, spotOn: number, fps: number, fpsLimit: number, moonOn: number, moonPos: MoonPosition | null = null): void {
      const realMoon = mn.mode === 'real' || mn.mode === 'realFull';
      const { sun, light } = s;
      const windowText = openingsText(openings, room);
      statusEl.textContent = [
        `FPS ${fps.toFixed(1)}（1 フレーム ${(1000 / Math.max(1, fps)).toFixed(1)} ms）${fpsLimit > 0 ? `  上限 ${fpsLimit}fps${fps < fpsLimit - 3 ? '  ※ 上限に届いていない' : ''}` : fps < 55 ? '  ※ 60fps に届いていない' : ''}`,
        clock.format(),
        `太陽  方位 ${sun.azimuth.toFixed(1)}°  高度 ${sun.altitude.toFixed(1)}°`,
        `窓から ${light.entersWindow ? '入る' : '入らない'}  lit ${lit.toFixed(2)}  ${Math.round(kelvinAt(sun.altitude))}K`,
        `視点  正面＝スクリーン（奥の壁）  窓＝${windowText}`,
        `窓の大きさ  ${windowSizeText()}`,
        ...(state.side === configSide ? [] : [`※ 窓の位置は room モードだけの切り替え（設定は${WINDOW_SIDE_LABEL[configSide]}）`]),
        ...(sameAsConfig() || state.side === 'ceiling-left' ? [] : ['※ 窓の大きさは room モードだけの変更（設定ファイルは変わらない）']),
        ...(state.side === 'ceiling' && !openings.right && (settings.seaView || settings.seaRipples) ? ['※ 窓の外の海・水面の反射は、壁の窓のときだけ効く'] : []),
        ...(settings.screen ? [`スクリーン  ${findScene(screen.id).label}`] : []),
        `ライト  ${spot.mode === 'off' ? '消す' : spotOn <= 0 ? '消えている（太陽が出ている）' : `点いている ${Math.round(spotOn * 100)}%`}`,
        `月明かり  ${!mn.on ? '消す' : moonOn > 0 ? `点いている ${Math.round(moonOn * 100)}%` : realMoon && moonPos && moonPos.altitude <= 0 && s.sun.altitude <= 0 ? '消えている（月が出ていない）' : '消えている（太陽が出ている）'}`,
        ...(realMoon && moonPos ? [`本物の月  方位 ${moonPos.azimuth.toFixed(0)}°・高度 ${moonPos.altitude.toFixed(0)}°・照らされている割合 ${Math.round(moonPos.illumination * 100)}%（明るさ 満月の ${Math.round(moonPos.brightness * 100)}%${mn.mode === 'realFull' ? '。いつも満月の明るさで出す' : ''}）`] : []),
        `1 画素あたりの光線 ${samples} 本${samples < 256 ? '（止めておくと増えて、ざらつきが減る）' : ''}`,
        `計算 ${size.width}×${size.height}（${resolution.output === 'view' ? '画面の枠' : `展示の ${EXHIBIT_SIZE.width}×${EXHIBIT_SIZE.height}`} の ${Math.round(resolution.scale * 100)}%、画素数 ${Math.round(resolution.scale * resolution.scale * 100)}%）`,
        `描画 ${BACKEND_LABEL[backend]}  倍率 ${devicePixelRatio}`,
        '',
        resolution.output === 'actual'
          ? 'ドラッグ：視点回転／ホイール：はみ出した分のスクロール／右ドラッグ：平行移動'
          : 'ドラッグ：視点回転／ホイール：ズーム／右ドラッグ：平行移動',
      ].join('\n');
    },
  };
}

const SCALE_PRESETS = [1, 0.75, 0.5, 1 / 3, 0.25];

/**
 * 原寸で見ている間だけ画面の上に出す帯。パネルが隠れるので、倍率の切り替えと戻るボタンをここに置く。
 * 数字キー 1〜5 で倍率（100%・75%・50%・33%・25%）、P で引き伸ばし方、Esc で「縮めて見る」に戻る
 */
function mountActualBar(onScale: (s: number) => void, onBack: () => void, onTogglePixel: () => void) {
  const bar = document.createElement('div');
  bar.id = 'room-actual-bar';
  bar.hidden = true;
  const label = document.createElement('span');
  const buttons = SCALE_PRESETS.map((sc, i) => {
    const b = document.createElement('button');
    b.textContent = `${Math.round(sc * 100)}%`;
    b.title = `計算の解像度 ${Math.round(sc * 100)}%（キー ${i + 1}）`;
    b.onclick = () => onScale(sc);
    return b;
  });
  const pixel = document.createElement('button');
  pixel.title = '引き伸ばし方（キー P）';
  pixel.onclick = onTogglePixel;
  const back = document.createElement('button');
  back.textContent = '戻る（Esc）';
  back.onclick = onBack;
  bar.append(label, ...buttons, pixel, back);
  document.body.appendChild(bar);
  addEventListener('keydown', (e) => {
    if (bar.hidden || e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLInputElement) return;
    const i = Number(e.key) - 1;
    if (Number.isInteger(i) && i >= 0 && i < SCALE_PRESETS.length) onScale(SCALE_PRESETS[i]!);
    else if (e.key === 'p' || e.key === 'P') onTogglePixel();
    else if (e.key === 'Escape' && !document.fullscreenElement) onBack();
  });
  return {
    update(res: RoomResolution, pixelated: boolean): void {
      bar.hidden = res.output !== 'actual';
      const w = Math.round(EXHIBIT_SIZE.width * res.scale), h = Math.round(EXHIBIT_SIZE.height * res.scale);
      label.textContent = `原寸 ${EXHIBIT_SIZE.width}×${EXHIBIT_SIZE.height}（出す 1 画素 = 画面の 1 画素）  計算 ${w}×${h}`;
      buttons.forEach((b, i) => b.classList.toggle('on', Math.abs(SCALE_PRESETS[i]! - res.scale) < 1e-3));
      pixel.textContent = pixelated ? '画素のまま' : 'なめらか';
    },
  };
}

/** パネルの窓の位置の選択肢。天井 = 天井いっぱいの窓、天窓 = 天井の一部の窓（どちらも side は ceiling）、天井＋左 = 天井いっぱい＋左の壁いっぱい */
export const WINDOW_CHOICES = ['left', 'right', 'ceiling', 'skylight', 'ceiling-left'] as const;
export type WindowChoice = (typeof WINDOW_CHOICES)[number];
export const WINDOW_CHOICE_LABEL: Record<WindowChoice, string> = { left: '左', right: '右', ceiling: '天井（天井いっぱい）', skylight: '天窓（天井の一部）', 'ceiling-left': '天井＋左' };
export const choiceSide = (c: WindowChoice): WindowSide => (c === 'skylight' ? 'ceiling' : c);
/** 窓の位置と大きさから、パネルの選択肢を決める（天井の窓は、天井いっぱいなら「天井」、そうでなければ「天窓」） */
export function choiceOf(side: WindowSide, win: WindowGeometry, room: RoomGeometry): WindowChoice {
  if (side !== 'ceiling') return side;
  return win.widthM >= room.widthM - 1e-6 && win.heightM >= room.depthM - 1e-6 ? 'ceiling' : 'skylight';
}

/** 窓の組み合わせから、計算の上の 1 つ目の窓の位置と大きさを決める（天井の窓があれば天井（左もあれば天井＋左）、なければ左 > 右。壁は壁いっぱい） */
export function openingsLayout(o: Openings, room: RoomGeometry, sill: number): { side: WindowSide; window: WindowGeometry } {
  if (o.top !== 'none') {
    const window = o.top === 'full' ? { widthM: room.widthM, heightM: room.depthM, sillHeightM: sill } : { widthM: o.skyWidthM, heightM: o.skyDepthM, sillHeightM: sill };
    return { side: o.left ? 'ceiling-left' : 'ceiling', window };
  }
  return { side: o.left || !o.right ? 'left' : 'right', window: { widthM: room.depthM, heightM: room.heightM, sillHeightM: 0 } };
}
/** 前の窓の位置の選択肢（?window= や保存した窓の位置）を、窓の組み合わせにする（天窓の大きさは、天窓なら窓の大きさ、そうでなければ base のまま） */
export function openingsFromChoice(c: WindowChoice, base: Openings, win?: WindowGeometry): Openings {
  const o: Openings = { ...base, left: c === 'left' || c === 'ceiling-left', right: c === 'right', top: c === 'ceiling' || c === 'ceiling-left' ? 'full' : c === 'skylight' ? 'skylight' : 'none' };
  if (c === 'skylight' && win) { o.skyWidthM = win.widthM; o.skyDepthM = win.heightM; }
  return o;
}
/** 保存した設定の窓の組み合わせ（窓の組み合わせを保存する前のファイルなら、保存した窓の位置と大きさから決める） */
export function openingsOf(saved: unknown, base: ReturnType<typeof codeDefaults>): Openings {
  const has = !!(saved as { render?: { openings?: unknown } } | null)?.render?.openings;
  if (has) return { ...base.render.openings, top: oneOf(base.render.openings.top, WINDOW_TOPS, 'none') };
  const side = oneOf(base.windowSide, WINDOW_SIDES, 'left');
  return openingsFromChoice(choiceOf(side, base.window, base.room), base.render.openings, base.window);
}
/** 窓の組み合わせの説明（状態表示） */
export function openingsText(o: Openings, room: RoomGeometry): string {
  const parts = [
    ...(o.left ? ['左の壁いっぱい'] : []),
    ...(o.right ? ['右の壁いっぱい'] : []),
    ...(o.top === 'full' ? [`天井いっぱい（${room.widthM.toFixed(2)}m × ${room.depthM.toFixed(2)}m）`] : o.top === 'skylight' ? [`天窓 幅 ${o.skyWidthM.toFixed(2)}m × 奥行き ${o.skyDepthM.toFixed(2)}m`] : []),
  ];
  return parts.join(' ＋ ') || 'なし';
}

/** 窓の位置ごとの既定の大きさ。壁の窓は壁いっぱい（壁がない）、天井は天井いっぱい、天窓は天井の一部（幅 40%・奥行き 50%） */
export function defaultWindow(c: WindowChoice, room: RoomGeometry, configWindow: WindowGeometry): WindowGeometry {
  if (c === 'left' || c === 'right' || c === 'ceiling-left') return { widthM: room.depthM, heightM: room.heightM, sillHeightM: 0 };
  if (c === 'ceiling') return { widthM: room.widthM, heightM: room.depthM, sillHeightM: configWindow.sillHeightM };
  return { widthM: Math.round(room.widthM * 0.4 * 20) / 20, heightM: Math.round(room.depthM * 0.5 * 20) / 20, sillHeightM: configWindow.sillHeightM };
}

/**
 * room モードのパネルの既定値（保存したファイルと同じ形）。開いたときの既定：窓は左で壁いっぱい（左の壁がない。天井はある）、
 * 水盤はオン（水盤で跳ね返った光はオフ）、波の強さ 0.3、雲の影はオフ（ROOM_DEFAULTS）
 */
export function codeDefaults(room: RoomGeometry, configWindow: WindowGeometry) {
  return {
    version: 1 as const,
    windowSide: 'left' as string,
    room: { ...room },
    // 既定は左の窓を壁いっぱい（左の壁がない）。天井はある
    window: defaultWindow('left', room, configWindow),
    render: {
      exposure: 2.5, bounces: 3, smooth: true,
      seaView: ROOM_DEFAULTS.seaView as boolean, seaRipples: false, pool: ROOM_DEFAULTS.pool as boolean, poolReflect: ROOM_DEFAULTS.poolReflect as boolean,
      waveAmp: ROOM_DEFAULTS.waveAmp as number, poolDepthM: 0.3, seaLevelM: -1, seaWaves: 'fft' as SeaWaves, seaCompare: false, openings: { left: true, right: false, top: 'none' as WindowTop, skyWidthM: Math.round(room.widthM * 0.4 * 20) / 20, skyDepthM: Math.round(room.depthM * 0.5 * 20) / 20 },
      glass: { right: false, left: false, ceiling: false, front: false, back: false },
      glassSpec: { kind: 'lowIron' as GlassKind, color: '#9ec9d6', transmission: 1, surface: 'flat' as GlassSurface, scaleM: 0.15, depthMM: 0.8, prism: false, prismStrength: 15 }, seaWindMS: 6, seaWaveScale: 1, seaRoughness: 0.004, seaScatter: 0.6,
      clouds: false, cloudShadow: ROOM_DEFAULTS.cloudShadow as boolean, cloudAmount: 0.45, cloudOpacity: 0.8,
      cloudSizeM: 1500, cloudHeightM: 1500, windMS: 30, windFromDeg: 270,
      screenArea: false, screen: false, screenGain: 0.6,
      prism: { ...PRISM_DEFAULTS, streaks: { ...PRISM_DEFAULTS.streaks }, hung: { ...PRISM_DEFAULTS.hung }, panel: { ...PRISM_DEFAULTS.panel }, beams: { ...PRISM_DEFAULTS.beams }, waves: { ...PRISM_DEFAULTS.waves }, organic: { ...PRISM_DEFAULTS.organic }, blobs: { ...PRISM_DEFAULTS.blobs }, shimmer: { ...PRISM_DEFAULTS.shimmer, palette: [...PRISM_DEFAULTS.shimmer.palette] } },
      trails: { ...TRAIL_DEFAULTS },
      moon: { ...MOON_DEFAULTS },
    },
    screenScene: 'light-clouds',
    palette: defaultPalette() as PaletteTable,
    spot: { ...SPOT_DEFAULTS, lights: SPOT_DEFAULTS.lights.map((l) => ({ ...l })) } as SpotSettings,
    // 計算の解像度は 75%（展示 PC の Mac mini（M5 Pro）で 3840×1080・60fps に収まる見込みの倍率。docs/hardware.md 5.6 節）
    resolution: { scale: 0.75, output: 'view' as string, upscale: 'smooth' as string, fps: 0 },
    calibration: defaultCalibration(room) as ViewCalibration,
    guides: { show: false, gridM: 1 } as GuideOptions,
    warp: { tlx: 0, tly: 0, trx: 0, try: 0, brx: 0, bry: 0, blx: 0, bly: 0 },
  };
}
