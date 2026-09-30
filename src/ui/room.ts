// room モードの UI：時刻操作・窓の位置の切り替えパネルと、太陽・lit の状態表示
import GUI from 'lil-gui';
import type { Clock } from '../clock.ts';
import { WINDOW_SIDES, WINDOW_SIDE_LABEL, type WindowSide } from '../config.ts';
import { kelvinAt } from '../palette.ts';
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

  mountTimeControls(gui, clock);

  const statusEl = el('room-status', HTMLElement);
  return {
    updateStatus(s: SolarState, lit: number): void {
      const { sun, light } = s;
      const windowText = state.side === 'ceiling' ? '天井（天窓）' : WINDOW_SIDE_LABEL[state.side];
      statusEl.textContent = [
        clock.format(),
        `太陽  方位 ${sun.azimuth.toFixed(1)}°  高度 ${sun.altitude.toFixed(1)}°`,
        `窓から ${light.entersWindow ? '入る' : '入らない'}  lit ${lit.toFixed(2)}  ${Math.round(kelvinAt(sun.altitude))}K`,
        `視点  正面＝スクリーン（奥の壁）  窓＝${windowText}`,
        ...(state.side === configSide ? [] : [`※ 窓の位置は room モードだけの切り替え（設定は${WINDOW_SIDE_LABEL[configSide]}）`]),
        '',
        'ドラッグ：視点回転／ホイール：ズーム／右ドラッグ：平行移動',
      ].join('\n');
    },
  };
}
