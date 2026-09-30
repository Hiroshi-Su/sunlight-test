// 画面上部のモード切り替えスイッチ（検証・visuals・room・展示）
import type { Clock } from '../clock.ts';
import type { AppMode } from '../config.ts';
import { APP_MODES } from '../config.ts';
import { el } from './dom.ts';

const LABEL: Record<AppMode, string> = { verify: '検証', visuals: 'visuals', room: 'room', kiosk: '展示' };
const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * @param setMode アプリ（Electron）ではモードの切り替えを main 側に頼む。ブラウザでは undefined（URL を差し替えて開き直す）
 */
export function mountModeSwitch(current: AppMode, clock: Clock, setMode?: (mode: AppMode) => void): void {
  const bar = el('modeBar', HTMLElement);
  for (const m of APP_MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = LABEL[m];
    b.dataset['mode'] = m;
    b.setAttribute('aria-pressed', String(m === current));
    if (m === current) b.classList.add('on');
    b.addEventListener('click', () => {
      if (m === current) return;
      if (setMode) { setMode(m); return; }
      const url = new URL(location.href);
      url.searchParams.set('mode', m);
      // 時刻を指定して見ているときは、その時刻を引き継ぐ（現在時刻に追従しているときは付けない）
      if (!clock.live) {
        const p = clock.local();
        url.searchParams.set('t', `${clock.ymd()}T${pad(Math.floor(p.min / 60))}:${pad(p.min % 60)}`);
      }
      location.href = url.toString();
    });
    bar.append(b);
  }
}
