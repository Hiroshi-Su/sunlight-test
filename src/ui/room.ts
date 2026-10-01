// room モードの UI：時刻操作・窓の位置と大きさの切り替えパネルと、太陽・lit の状態表示
import GUI from 'lil-gui';
import type { Clock } from '../clock.ts';
import { WINDOW_SIDES, WINDOW_SIDE_LABEL, type WindowSide } from '../config.ts';
import { kelvinAt } from '../palette.ts';
import { EXHIBIT_SIZE, type RoomGeometry, type RoomRenderSettings, type RoomResolution, type WindowGeometry } from '../room/scene.ts';
import { SCENES, findScene } from '../scenes/index.ts';
import type { SceneDef } from '../scenes/types.ts';
import type { SolarState } from '../solar.ts';
import type { Backend } from '../stage.ts';
import { BACKEND_LABEL } from './perf.ts';
import { el } from './dom.ts';
import { mountTimeControls } from './time-controls.ts';

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
  const on = (k: string): boolean => q.get(k) === '1';
  const num = (k: string, fallback: number): number => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const settings: RoomRenderSettings = {
    exposure: 2.5, bounces: 3, smooth: true,
    seaView: on('sea'), seaRipples: on('ripples'), pool: on('pool'),
    waveAmp: 1, poolDepthM: 0.3, seaLevelM: -1,
    window: {
      widthM: num('winW', configWindow.widthM),
      heightM: num('winH', configWindow.heightM),
      sillHeightM: num('sill', configWindow.sillHeightM),
    },
    clouds: on('clouds'), cloudShadow: true, cloudAmount: 0.45, cloudOpacity: 0.8,
    cloudSizeM: 1500, cloudHeightM: 1500, windMS: 30, windFromDeg: 270,
    screen: q.has('screen') && q.get('screen') !== '0', screenGain: 0.6,
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
    const maxW = (ceiling ? room.widthM : room.depthM) * 0.95;
    const maxH = ceiling ? room.depthM * 0.95 : room.heightM * 0.98 - 0.2;
    win.widthM = Math.min(win.widthM, maxW);
    win.heightM = Math.min(win.heightM, maxH);
    win.sillHeightM = Math.min(win.sillHeightM, room.heightM * 0.98 - 0.2);
    cW.max(maxW).name(ceiling ? '窓の幅（左右、m）' : '窓の幅（奥行き方向、m）').updateDisplay();
    cH.max(maxH).name(ceiling ? '窓の奥行き（m）' : '窓の高さ（m）').updateDisplay();
    cS.max(room.heightM * 0.98 - 0.2).updateDisplay();
    cS.show(!ceiling); // 天窓では使わない
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
  // ?scale=0.5（計算の倍率）・?out=exhibit（展示と同じ 3840×1080）・?upscale=pixel（画素のまま引き伸ばす）で最初の値を指定できる
  const view = el('roomView', HTMLElement);
  const scaleParam = Number(q.get('scale'));
  const resolution: RoomResolution = {
    scale: q.has('scale') && scaleParam >= 0.1 && scaleParam <= 1 ? scaleParam : 1,
    output: q.get('out') === 'exhibit' ? 'exhibit' : 'view',
  };
  const look = { upscale: q.get('upscale') === 'pixel' ? 'pixel' : 'smooth' };
  const applyLook = (): void => {
    view.classList.toggle('exhibit', resolution.output === 'exhibit');
    view.classList.toggle('pixelated', look.upscale === 'pixel');
  };
  const changed = (): void => { applyLook(); onResolution({ ...resolution }); };
  applyLook();
  const fq = gui.addFolder('解像度');
  fq.add(resolution, 'output', { '画面の枠の大きさ': 'view', [`展示と同じ ${EXHIBIT_SIZE.width}×${EXHIBIT_SIZE.height}（32:9）`]: 'exhibit' })
    .name('出す大きさ').onChange(changed);
  fq.add(resolution, 'scale', 0.1, 1, 0.05).name('計算の解像度（倍）').onChange(changed);
  const presets = { p100: '1', p75: '0.75', p50: '0.5', p33: '0.333', p25: '0.25' };
  for (const [key, v] of Object.entries(presets)) {
    fq.add({ [key]: () => { resolution.scale = Number(v); fq.controllers.forEach((c) => c.updateDisplay()); changed(); } }, key)
      .name(`${Math.round(Number(v) * 100)}%`);
  }
  fq.add(look, 'upscale', { 'なめらか（線形補間）': 'smooth', '画素のまま（ドット）': 'pixel' }).name('引き伸ばし方').onChange(applyLook);
  fq.add({ run: () => { void view.requestFullscreen?.(); } }, 'run').name('全画面で見る（Esc で戻る）');

  // 水：3 つはそれぞれ独立に出し消しできる（窓の外の 2 つは、壁の窓のときだけ効く）
  const fw = gui.addFolder('水');
  fw.add(settings, 'seaView').name('窓の外の海');
  fw.add(settings, 'seaRipples').name('窓の外の水面の反射（天井・壁の揺らぎ）');
  fw.add(settings, 'pool').name('床の水盤');
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
    updateStatus(s: SolarState, lit: number, samples: number, backend: Backend, size: { width: number; height: number }): void {
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
        `1 画素あたりの光線 ${samples} 本${samples < 256 ? '（止めておくと増えて、ざらつきが減る）' : ''}`,
        `計算 ${size.width}×${size.height}（${resolution.output === 'exhibit' ? `展示の ${EXHIBIT_SIZE.width}×${EXHIBIT_SIZE.height}` : '画面の枠'} の ${Math.round(resolution.scale * 100)}%、画素数 ${Math.round(resolution.scale * resolution.scale * 100)}%）`,
        `描画 ${BACKEND_LABEL[backend]}`,
        '',
        'ドラッグ：視点回転／ホイール：ズーム／右ドラッグ：平行移動',
      ].join('\n');
    },
  };
}
