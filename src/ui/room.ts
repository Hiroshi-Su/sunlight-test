// room モードの UI：時刻操作・窓の位置と大きさの切り替えパネルと、太陽・lit の状態表示
import GUI from 'lil-gui';
import type { Clock } from '../clock.ts';
import { WINDOW_SIDES, WINDOW_SIDE_LABEL, type WindowSide } from '../config.ts';
import { kelvinAt } from '../palette.ts';
import { EXHIBIT_SIZE, MAX_SPOTS, SPOT_MODES, type RoomGeometry, type RoomOutput, type RoomRenderSettings, type RoomResolution, type SpotLight, type SpotMode, type SpotSettings, type WindowGeometry } from '../room/scene.ts';
import { SCENES, findScene } from '../scenes/index.ts';
import type { SceneDef } from '../scenes/types.ts';
import type { SolarState } from '../solar.ts';
import type { Backend } from '../stage.ts';
import { BACKEND_LABEL } from './perf.ts';
import { el, ignoreSliderWheel } from './dom.ts';
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
const SPOT_MODE_LABEL: Record<SpotMode, string> = { auto: '自動（太陽が沈むと点く）', on: '常に点ける', off: '消す' };

/**
 * @param room 部屋の寸法（窓の大きさの上限に使う）
 * @param configWindow config/site.json の窓の大きさ（初期値）
 * @param configSide config/site.json の窓の位置（初期値）
 * @param initialSide 最初に表示する窓の位置（URL の ?window= で指定されたとき）
 * @param onWindowSide 窓の位置を切り替えたとき。room モードの表示と光の計算だけに効き、設定ファイルは変えない
 * @param onResolution 計算の解像度・出す大きさを変えたとき
 */
export function mountRoomUi(
  clock: Clock,
  room: RoomGeometry,
  configWindow: WindowGeometry,
  configSide: WindowSide,
  initialSide: WindowSide,
  onWindowSide: (side: WindowSide) => void,
  benchmark: () => Promise<number | null>,
  onResolution: (res: RoomResolution) => void,
) {
  const gui = new GUI({ container: el('room-panel', HTMLElement), width: 380, title: 'room' });
  ignoreSliderWheel(gui.domElement);

  // 窓の位置の切り替えスイッチ（パネルのいちばん上）
  const state = { side: initialSide };
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
  const q = new URLSearchParams(location.search);
  const on = (k: string, fallback = false): boolean => (q.has(k) ? q.get(k) === '1' : fallback);
  const num = (k: string, fallback: number): number => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const settings: RoomRenderSettings = {
    exposure: 2.5, bounces: 3, smooth: true,
    seaView: on('sea'), seaRipples: on('ripples'), pool: on('pool', ROOM_DEFAULTS.pool), poolReflect: on('poolReflect', ROOM_DEFAULTS.poolReflect),
    waveAmp: num('wave', ROOM_DEFAULTS.waveAmp), poolDepthM: 0.3, seaLevelM: -1,
    window: {
      // 天窓で始めるときは天井いっぱい。壁の窓に切り替えると、その壁に収まる大きさに詰める（fit）
      widthM: num('winW', initialSide === 'ceiling' && ROOM_DEFAULTS.fullCeiling ? room.widthM : configWindow.widthM),
      heightM: num('winH', initialSide === 'ceiling' && ROOM_DEFAULTS.fullCeiling ? room.depthM : configWindow.heightM),
      sillHeightM: num('sill', configWindow.sillHeightM),
    },
    clouds: on('clouds'), cloudShadow: on('cloudShadow', ROOM_DEFAULTS.cloudShadow), cloudAmount: 0.45, cloudOpacity: 0.8,
    cloudSizeM: 1500, cloudHeightM: 1500, windMS: 30, windFromDeg: 270,
    screen: q.has('screen') && q.get('screen') !== '0', screenGain: 0.6,
    // ?spot=on / off / auto でスポットライトの点け方を指定できる
    // ?spotCount=2 で台数を指定できる
    spot: {
      ...SPOT_DEFAULTS,
      mode: SPOT_MODES.find((m) => m === q.get('spot')) ?? SPOT_DEFAULTS.mode,
      count: Math.min(MAX_SPOTS, Math.max(1, Math.round(num('spotCount', SPOT_DEFAULTS.count)))),
      lights: SPOT_DEFAULTS.lights.map((l) => ({ ...l })),
    },
  };
  const screenParam = q.get('screen');
  const screen = { id: SCENES.some((d) => d.id === screenParam) ? screenParam! : 'light-clouds' };

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
  const resolution: RoomResolution = {
    scale: q.has('scale') && scaleParam >= 0.1 && scaleParam <= 1 ? scaleParam : 1,
    output: outParam === 'exhibit' || outParam === 'actual' ? outParam : 'view',
  };
  const look = { upscale: q.get('upscale') === 'pixel' ? 'pixel' : 'smooth' };
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
    /** 計算の解像度・出す大きさ */
    get resolution(): RoomResolution { return { ...resolution }; },
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
