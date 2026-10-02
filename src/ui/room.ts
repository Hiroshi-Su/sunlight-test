// room モードの UI：時刻操作・窓の位置と大きさの切り替えパネルと、太陽・lit の状態表示
import GUI from 'lil-gui';
import type { Clock } from '../clock.ts';
import { WINDOW_SIDES, WINDOW_SIDE_LABEL, type WindowSide } from '../config.ts';
import { kelvinAt } from '../palette.ts';
import { EXHIBIT_SIZE, type GuideOptions, MAX_SPOTS, SPOT_MODES, TRAIL_COLOR_MODES, type TrailSettings, type RoomGeometry, type RoomOutput, type RoomRenderSettings, type RoomResolution, type SpotLight, type SpotMode, type SpotSettings, type ViewCalibration, type WindowGeometry, defaultCalibration } from '../room/scene.ts';
import { SCENES, findScene } from '../scenes/index.ts';
import type { SceneDef } from '../scenes/types.ts';
import type { SolarState } from '../solar.ts';
import type { Backend } from '../stage.ts';
import { BACKEND_LABEL } from './perf.ts';
import { el, ignoreSliderWheel } from './dom.ts';
import { type WarpCorners, warpCss } from './warp.ts';
import { type RoomSettingsFile, mergeKnown, oneOf } from '../room/settings-file.ts';
import { mountTimeControls } from './time-controls.ts';

/**
 * room モードを開いたときの既定値（URL で上書きできる）。時刻は現在時刻、窓の位置は天窓（src/main.ts）
 * - 水盤はオン、波の強さは 0.3。水盤で跳ね返った光（壁・天井の揺らぎ）はオフ（窓の外の水面の反射と見分けやすいように、別に出し消しする）
 * - 雲が日差しをさえぎる（雲の影）はオフ
 * - 天窓の大きさは天井いっぱい（天井の面が消える大きさ）。URL の ?winW= ?winH= を指定したときはその値
 */
export const ROOM_DEFAULTS = { pool: true, poolReflect: false, waveAmp: 0.3, fullCeiling: true, cloudShadow: false } as const;

/**
 * スポットライト 1 台の既定（鑑賞者の頭上：手前の端から 0.6m、天井から 0.15m。真下から奥へ 35° 傾ける）。
 * 2 台目以降は左右に並べ、4 台目は少し奥に置く
 */
const SPOT_LIGHT_BASE: SpotLight = {
  strength: 1, beamDeg: 60, softness: 0.35, tiltDeg: 35, panDeg: 0,
  fromFrontM: 0.6, belowCeilingM: 0.15, xM: 0, colorMode: 'kelvin', kelvin: 3000, color: '#ffd9a8',
};
const SPOT_LIGHT_PLACES: Partial<SpotLight>[] = [{}, { xM: -2.5 }, { xM: 2.5 }, { fromFrontM: 2.0, tiltDeg: 20 }];
export const spotLightDefault = (i: number): SpotLight => ({ ...SPOT_LIGHT_BASE, ...SPOT_LIGHT_PLACES[i % SPOT_LIGHT_PLACES.length] });
export const SPOT_DEFAULTS: SpotSettings = {
  mode: 'auto', count: 1, onAltDeg: 5, fullAltDeg: -4,
  lights: Array.from({ length: MAX_SPOTS }, (_, i) => spotLightDefault(i)),
};
/** 光の軌跡の既定（部屋の中央・目の高さのあたりに、半径 1.2m で 1,024 本） */
export const TRAIL_DEFAULTS: TrailSettings = {
  on: true, count: 1024, points: 48, widthPx: 3, speed: 1.2, turbulence: 0.6, spread: 1.5,
  radiusM: 1.2, centerHeightM: 1.6, centerFromFrontM: 0, brightness: 1,
  colorMode: 'scene', color: '#66ccff', hueSpread: 1,
};
const SPOT_MODE_LABEL: Record<SpotMode, string> = { auto: '自動（太陽が沈むと点く）', on: '常に点ける', off: '消す' };

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
  gui.add({ run: async () => {
    saveState.text = '保存中…';
    try {
      await hooks.save(collect());
      saveState.text = `保存した（${new Date().toLocaleTimeString()}）`;
    } catch (err) {
      saveState.text = `保存できなかった：${err instanceof Error ? err.message : String(err)}`;
    }
  } }, 'run').name('部屋の設定を保存（config/room.json）');
  gui.add(saveState, 'text').name('保存').disable().listen();

  // 窓の位置の切り替えスイッチ。?window=right などで、最初に表示する窓の位置を指定できる（指定がなければ保存した位置、既定は天窓）
  const urlSide = WINDOW_SIDES.find((w) => w === q.get('window'));
  const state = { side: urlSide ?? oneOf(base.windowSide, WINDOW_SIDES, 'ceiling') };
  const options = Object.fromEntries(
    WINDOW_SIDES.map((s) => [`${WINDOW_SIDE_LABEL[s]}${s === configSide ? '（設定どおり）' : ''}`, s]),
  );
  const fr = gui.addFolder('部屋');
  // 窓の位置のスイッチ（いちばん上）。切り替えたら窓の大きさの上限も合わせる（fit は下で定義）
  fr.add(state, 'side', options).name('窓の位置').onChange((v: WindowSide) => { fit(); onWindowSide(v); });

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
  // URL で窓の位置だけを保存した位置から変えたときは、窓の大きさはその位置の既定（天窓なら天井いっぱい、壁なら config/site.json）
  const winBase = urlSide && urlSide !== base.windowSide
    ? (urlSide === 'ceiling' ? { widthM: room.widthM, heightM: room.depthM, sillHeightM: configWindow.sillHeightM } : { ...configWindow })
    : base.window;
  const settings: RoomRenderSettings = {
    ...r0,
    seaView: on('sea', r0.seaView), seaRipples: on('ripples', r0.seaRipples), pool: on('pool', r0.pool), poolReflect: on('poolReflect', r0.poolReflect),
    waveAmp: num('wave', r0.waveAmp),
    window: { widthM: num('winW', winBase.widthM), heightM: num('winH', winBase.heightM), sillHeightM: num('sill', winBase.sillHeightM) },
    clouds: on('clouds', r0.clouds), cloudShadow: on('cloudShadow', r0.cloudShadow),
    screen: q.has('screen') ? q.get('screen') !== '0' : r0.screen,
    // ?trails=0 で光の軌跡を消して開く
    trails: { ...r0.trails, on: on('trails', r0.trails.on), colorMode: oneOf(r0.trails.colorMode, TRAIL_COLOR_MODES, 'scene') },
    // ?spot=on / off / auto でスポットライトの点け方、?spotCount=2 で台数を指定できる
    spot: {
      ...base.spot,
      mode: oneOf(q.get('spot') ?? base.spot.mode, SPOT_MODES, SPOT_DEFAULTS.mode),
      count: Math.min(MAX_SPOTS, Math.max(1, Math.round(num('spotCount', base.spot.count)))),
      lights: base.spot.lights.map((l) => ({ ...l, colorMode: oneOf(l.colorMode, ['kelvin', 'color'] as const, 'kelvin') })),
    },
  };
  const screenParam = q.get('screen') ?? base.screenScene;
  const screen = { id: SCENES.some((d) => d.id === screenParam) ? screenParam : 'light-clouds' };

  // 窓の大きさ。room モードの表示と光の計算だけに効き、設定ファイルは変えない（窓の位置と同じ）
  // 上限は部屋に収まる大きさ。壁の窓は幅＝奥行き方向、天窓は幅＝左右・奥行き＝奥行き方向
  const win = settings.window;
  const cW = fr.add(win, 'widthM', 0.2, 1, 0.05);
  const cH = fr.add(win, 'heightM', 0.2, 1, 0.05);
  const cS = fr.add(win, 'sillHeightM', 0, 1, 0.05).name('窓の下端の高さ（床から m）');
  const fit = (): void => {
    const ceiling = state.side === 'ceiling';
    // 天窓は天井いっぱいまで（天井の面が消える）、壁の窓は壁の 95% まで
    const maxW = ceiling ? room.widthM : room.depthM * 0.95;
    const maxH = ceiling ? room.depthM : room.heightM * 0.98 - 0.2;
    win.widthM = Math.min(win.widthM, maxW);
    win.heightM = Math.min(win.heightM, maxH);
    win.sillHeightM = Math.min(win.sillHeightM, room.heightM * 0.98 - 0.2);
    cW.max(maxW).name(ceiling ? '窓の幅（左右、m）' : '窓の幅（奥行き方向、m）').updateDisplay();
    cH.max(maxH).name(ceiling ? '窓の奥行き（m）' : '窓の高さ（m）').updateDisplay();
    cS.max(room.heightM * 0.98 - 0.2).updateDisplay();
    cS.show(!ceiling); // 天窓では使わない
    cFull.show(ceiling);
  };
  // 壁の窓は、下端 + 高さが天井を超えないように、下端を動かしたら高さを、高さを動かしたら下端を詰める
  cH.onChange(() => {
    if (state.side !== 'ceiling' && win.sillHeightM + win.heightM > room.heightM * 0.98) {
      win.sillHeightM = Math.max(0, room.heightM * 0.98 - win.heightM);
      cS.updateDisplay();
    }
  });
  cS.onChange(() => {
    if (win.sillHeightM + win.heightM > room.heightM * 0.98) {
      win.heightM = Math.max(0.2, room.heightM * 0.98 - win.sillHeightM);
      cH.updateDisplay();
    }
  });
  const reset = { run: (): void => { Object.assign(win, configWindow); fit(); } };
  fr.add(reset, 'run').name('窓の大きさを設定どおりに戻す');
  const full = { run: (): void => { win.widthM = room.widthM; win.heightM = room.depthM; fit(); } };
  const cFull = fr.add(full, 'run').name('天窓を天井いっぱいにする');
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
  fq.add({ run: () => { void view.requestFullscreen?.(); } }, 'run').name('全画面で見る（Esc で戻る）');
  changed();

  // 視点・パース合わせ：現地で投影するとき、見る人の位置から見て、映像の部屋が実際の空間とつながって見えるように合わせる。
  // 投影面（映像が映る面）と目の位置を実寸で入れると、画角とレンズシフトが決まる。最後に四隅の位置合わせで、投影のずれを直す
  // ?view=fixed で、最初から現地に合わせた視点で見る
  const calib: ViewCalibration = { ...base.calibration, mode: oneOf(q.get('view') ?? base.calibration.mode, ['free', 'fixed'] as const, 'free') };
  const calibChanged = (): void => hooks.onCalibration({ ...calib });
  const fp = gui.addFolder('視点・パース合わせ');
  fp.add(calib, 'mode', { 'マウスで自由に動かす': 'free', '現地に合わせた視点（固定）': 'fixed' }).name('視点').onChange(calibChanged);
  const calibCtl = [
    fp.add(calib, 'planeWidthM', 0.5, 40, 0.01).name('投影面：幅（m）'),
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

  // 水：3 つはそれぞれ独立に出し消しできる（窓の外の 2 つは、壁の窓のときだけ効く）
  const fw = gui.addFolder('水');
  fw.add(settings, 'seaView').name('窓の外の海');
  fw.add(settings, 'seaRipples').name('窓の外の水面の反射（天井・壁の揺らぎ）');
  fw.add(settings, 'pool').name('床の水盤');
  fw.add(settings, 'poolReflect').name('床の水盤で跳ね返った光（壁・天井の揺らぎ）');
  fw.add(settings, 'waveAmp', 0, 3, 0.05).name('波の強さ');
  fw.add(settings, 'poolDepthM', 0.02, 1.5, 0.01).name('水盤の深さ（m）');
  fw.add(settings, 'seaLevelM', -5, 0, 0.05).name('窓の外の水面の高さ（床から m）');

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
  fs.add(settings, 'screen').name('スクリーンに映像を映す');
  fs.add(screen, 'id', Object.fromEntries(SCENES.map((d) => [d.label, d.id]))).name('映す映像');
  fs.add(settings, 'screenGain', 0, 3, 0.01).name('プロジェクターの明るさ');

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
  fl.add(spot, 'count', 1, MAX_SPOTS, 1).name('台数').onChange(() => showLights());
  fl.add(spot, 'onAltDeg', -18, 20, 0.5).name('自動：点き始める太陽の高度（度）');
  fl.add(spot, 'fullAltDeg', -18, 20, 0.5).name('自動：最大になる太陽の高度（度）');
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
  const showLights = (): void => lightFolders.forEach((f, i) => f.show(i < spot.count));
  showLights();

  mountTimeControls(gui, clock);

  // 保存する中身（パネルの今の値）
  const collect = (): RoomSettingsFile => {
    const { window: _w, spot: _s, ...render } = settings;
    return {
      version: 1, windowSide: state.side, room: { ...room }, window: { ...win }, render, screenScene: screen.id,
      spot: { ...spot, lights: spot.lights.map((l) => ({ ...l })) },
      resolution: { ...resolution, upscale: look.upscale }, calibration: { ...calib }, guides: { ...guides }, warp: { ...warpPct },
    };
  };

  const statusEl = el('room-status', HTMLElement);
  const sameAsConfig = (): boolean =>
    win.widthM === configWindow.widthM && win.heightM === configWindow.heightM && win.sillHeightM === configWindow.sillHeightM;
  const windowSizeText = (): string => state.side === 'ceiling'
    ? `幅 ${win.widthM.toFixed(2)}m × 奥行き ${win.heightM.toFixed(2)}m（${(win.widthM * win.heightM).toFixed(1)}㎡）`
    : `幅 ${win.widthM.toFixed(2)}m × 高さ ${win.heightM.toFixed(2)}m、床から ${win.sillHeightM.toFixed(2)}m（${(win.widthM * win.heightM).toFixed(1)}㎡）`;
  return {
    settings,
    /** スクリーンに映す映像 */
    get screenScene(): SceneDef { return findScene(screen.id); },
    /** 窓の位置（URL・保存した値・既定から決めたもの。切り替えると onWindowSide） */
    get side(): WindowSide { return state.side; },
    /** 計算の解像度・出す大きさ */
    get resolution(): RoomResolution { return { ...resolution }; },
    /** 部屋の寸法（パネルで変えたもの） */
    get room(): RoomGeometry { return { ...room }; },
    /** パース合わせの視点 */
    get calibration(): ViewCalibration { return { ...calib }; },
    /** 合わせるための線 */
    get guides(): GuideOptions { return { ...guides }; },
    /** 四隅の位置合わせ */
    get warp(): WarpCorners { return corners(); },
    updateStatus(s: SolarState, lit: number, samples: number, backend: Backend, size: { width: number; height: number }, spotOn: number): void {
      const { sun, light } = s;
      const windowText = state.side === 'ceiling' ? '天井（天窓）' : WINDOW_SIDE_LABEL[state.side];
      statusEl.textContent = [
        clock.format(),
        `太陽  方位 ${sun.azimuth.toFixed(1)}°  高度 ${sun.altitude.toFixed(1)}°`,
        `窓から ${light.entersWindow ? '入る' : '入らない'}  lit ${lit.toFixed(2)}  ${Math.round(kelvinAt(sun.altitude))}K`,
        `視点  正面＝スクリーン（奥の壁）  窓＝${windowText}`,
        `窓の大きさ  ${windowSizeText()}`,
        ...(state.side === configSide ? [] : [`※ 窓の位置は room モードだけの切り替え（設定は${WINDOW_SIDE_LABEL[configSide]}）`]),
        ...(sameAsConfig() ? [] : ['※ 窓の大きさは room モードだけの変更（設定ファイルは変わらない）']),
        ...(state.side === 'ceiling' && (settings.seaView || settings.seaRipples) ? ['※ 窓の外の海・水面の反射は、壁の窓のときだけ効く'] : []),
        ...(settings.screen ? [`スクリーン  ${findScene(screen.id).label}`] : []),
        `ライト  ${spot.mode === 'off' ? '消す' : spotOn <= 0 ? '消えている（太陽が出ている）' : `点いている ${Math.round(spotOn * 100)}%`}`,
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

/**
 * room モードのパネルの既定値（保存したファイルと同じ形）。開いたときの既定：窓は天窓で天井いっぱい、
 * 水盤はオン（水盤で跳ね返った光はオフ）、波の強さ 0.3、雲の影はオフ（ROOM_DEFAULTS）
 */
function codeDefaults(room: RoomGeometry, configWindow: WindowGeometry) {
  return {
    version: 1 as const,
    windowSide: 'ceiling' as string,
    room: { ...room },
    window: ROOM_DEFAULTS.fullCeiling
      ? { widthM: room.widthM, heightM: room.depthM, sillHeightM: configWindow.sillHeightM }
      : { ...configWindow },
    render: {
      exposure: 2.5, bounces: 3, smooth: true,
      seaView: false, seaRipples: false, pool: ROOM_DEFAULTS.pool as boolean, poolReflect: ROOM_DEFAULTS.poolReflect as boolean,
      waveAmp: ROOM_DEFAULTS.waveAmp as number, poolDepthM: 0.3, seaLevelM: -1,
      clouds: false, cloudShadow: ROOM_DEFAULTS.cloudShadow as boolean, cloudAmount: 0.45, cloudOpacity: 0.8,
      cloudSizeM: 1500, cloudHeightM: 1500, windMS: 30, windFromDeg: 270,
      screen: false, screenGain: 0.6,
      trails: { ...TRAIL_DEFAULTS },
    },
    screenScene: 'light-clouds',
    spot: { ...SPOT_DEFAULTS, lights: SPOT_DEFAULTS.lights.map((l) => ({ ...l })) } as SpotSettings,
    resolution: { scale: 1, output: 'view' as string, upscale: 'smooth' as string },
    calibration: defaultCalibration(room) as ViewCalibration,
    guides: { show: false, gridM: 1 } as GuideOptions,
    warp: { tlx: 0, tly: 0, trx: 0, try: 0, brx: 0, bry: 0, blx: 0, bly: 0 },
  };
}
