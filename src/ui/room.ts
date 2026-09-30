// room モードの UI：時刻操作・窓の位置の切り替えパネルと、太陽・lit の状態表示
import GUI from 'lil-gui';
import type { Clock } from '../clock.ts';
import { WINDOW_SIDES, WINDOW_SIDE_LABEL, type WindowSide } from '../config.ts';
import { kelvinAt } from '../palette.ts';
import type { RoomRenderSettings } from '../room/scene.ts';
import type { SolarState } from '../solar.ts';
import { el } from './dom.ts';
import { mountTimeControls } from './time-controls.ts';

/**
 * @param configSide config/site.json の窓の位置（初期値）
 * @param initialSide 最初に表示する窓の位置（URL の ?window= で指定されたとき）
 * @param onWindowSide 窓の位置を切り替えたとき。room モードの表示と光の計算だけに効き、設定ファイルは変えない
 */
export function mountRoomUi(clock: Clock, configSide: WindowSide, initialSide: WindowSide, onWindowSide: (side: WindowSide) => void) {
  const gui = new GUI({ container: el('room-panel', HTMLElement), width: 380, title: 'room' });

  // 窓の位置の切り替えスイッチ（パネルのいちばん上）
  const state = { side: initialSide };
  const options = Object.fromEntries(
    WINDOW_SIDES.map((s) => [`${WINDOW_SIDE_LABEL[s]}${s === configSide ? '（設定どおり）' : ''}`, s]),
  );
  const fr = gui.addFolder('部屋');
  fr.add(state, 'side', options).name('窓の位置').onChange((v: WindowSide) => onWindowSide(v));

  // 画面の設定。照り返しを 0 にすると、窓から直接届く光だけになる（照り返しの効果を見比べられる）
  // 水は ?sea=1（海）・?ripples=1（水面の反射の揺らぎ）・?pool=1（水盤）で最初からオンにできる
  const q = new URLSearchParams(location.search);
  const on = (k: string): boolean => q.get(k) === '1';
  const settings: RoomRenderSettings = {
    exposure: 2.5, bounces: 3, smooth: true,
    seaView: on('sea'), seaRipples: on('ripples'), pool: on('pool'),
    waveAmp: 1, poolDepthM: 0.3, seaLevelM: -1,
  };
  const fv = gui.addFolder('光の計算');
  fv.add(settings, 'bounces', 0, 6, 1).name('照り返しの回数');
  fv.add(settings, 'smooth').name('照り返しのざらつきをならす');
  fv.add(settings, 'exposure', 0.1, 8, 0.05).name('露出（明るさ）');

  // 水：3 つはそれぞれ独立に出し消しできる（窓の外の 2 つは、壁の窓のときだけ効く）
  const fw = gui.addFolder('水');
  fw.add(settings, 'seaView').name('窓の外の海');
  fw.add(settings, 'seaRipples').name('窓の外の水面の反射（天井・壁の揺らぎ）');
  fw.add(settings, 'pool').name('床の水盤');
  fw.add(settings, 'waveAmp', 0, 3, 0.05).name('波の強さ');
  fw.add(settings, 'poolDepthM', 0.02, 1.5, 0.01).name('水盤の深さ（m）');
  fw.add(settings, 'seaLevelM', -5, 0, 0.05).name('窓の外の水面の高さ（床から m）');

  mountTimeControls(gui, clock);

  const statusEl = el('room-status', HTMLElement);
  return {
    settings,
    updateStatus(s: SolarState, lit: number, samples: number): void {
      const { sun, light } = s;
      const windowText = state.side === 'ceiling' ? '天井（天窓）' : WINDOW_SIDE_LABEL[state.side];
      statusEl.textContent = [
        clock.format(),
        `太陽  方位 ${sun.azimuth.toFixed(1)}°  高度 ${sun.altitude.toFixed(1)}°`,
        `窓から ${light.entersWindow ? '入る' : '入らない'}  lit ${lit.toFixed(2)}  ${Math.round(kelvinAt(sun.altitude))}K`,
        `視点  正面＝スクリーン（奥の壁）  窓＝${windowText}`,
        ...(state.side === configSide ? [] : [`※ 窓の位置は room モードだけの切り替え（設定は${WINDOW_SIDE_LABEL[configSide]}）`]),
        ...(state.side === 'ceiling' && (settings.seaView || settings.seaRipples) ? ['※ 窓の外の海・水面の反射は、壁の窓のときだけ効く'] : []),
        `1 画素あたりの光線 ${samples} 本${samples < 256 ? '（止めておくと増えて、ざらつきが減る）' : ''}`,
        '',
        'ドラッグ：視点回転／ホイール：ズーム／右ドラッグ：平行移動',
      ].join('\n');
    },
  };
}
