// room モードの UI：時刻操作パネルと、太陽・lit の状態表示
import GUI from 'lil-gui';
import type { Clock } from '../clock.ts';
import { kelvinAt } from '../palette.ts';
import type { SolarState } from '../solar.ts';
import { el } from './dom.ts';
import { mountTimeControls } from './time-controls.ts';

export function mountRoomUi(clock: Clock) {
  const gui = new GUI({ container: el('room-panel', HTMLElement), width: 380, title: 'room' });
  mountTimeControls(gui, clock);

  const statusEl = el('room-status', HTMLElement);
  return {
    updateStatus(s: SolarState, lit: number): void {
      const { sun, light } = s;
      statusEl.textContent = [
        clock.format(),
        `太陽  方位 ${sun.azimuth.toFixed(1)}°  高度 ${sun.altitude.toFixed(1)}°`,
        `窓から ${light.entersWindow ? '入る' : '入らない'}  lit ${lit.toFixed(2)}  ${Math.round(kelvinAt(sun.altitude))}K`,
        '',
        'ドラッグ：視点回転／ホイール：ズーム／右ドラッグ：平行移動',
      ].join('\n');
    },
  };
}
