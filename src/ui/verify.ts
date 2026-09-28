// 検証モードの UI：平面図・1 日の高度グラフ・計算値・時刻操作
import type { Clock } from '../clock.ts';
import { type PathPoint, drawDayChart, drawPlan } from '../diagram.ts';
import { kelvinAt } from '../palette.ts';
import { type Site, type SolarState, solarState } from '../solar.ts';
import { el } from './dom.ts';

export interface VerifyHooks {
  setArrow(on: boolean): void;
  setStripes(on: boolean): void;
}

export function mountVerify(clock: Clock, site: Site, declination: number, hooks: VerifyHooks, arrowOn: boolean) {
  const ui = {
    plan: el('plan', HTMLCanvasElement),
    chart: el('chart', HTMLCanvasElement),
    clock: el('clock', HTMLElement),
    values: el('values', HTMLElement),
    now: el('now', HTMLButtonElement),
    play: el('play', HTMLButtonElement),
    speed: el('speed', HTMLSelectElement),
    time: el('time', HTMLInputElement),
    date: el('date', HTMLInputElement),
    showOverlay: el('showOverlay', HTMLInputElement),
    showStripes: el('showStripes', HTMLInputElement),
  };

  let pathDay: string | null = null;
  let path: PathPoint[] = [];
  const dayPath = (): PathPoint[] => {
    const day = clock.ymd();
    if (pathDay === day) return path;
    pathDay = day;
    const { y, mo, d } = clock.local();
    path = [];
    for (let min = 0; min <= 1440; min += 10) {
      const { sun, light } = solarState(new Date(clock.utcFromLocal(y, mo, d, min)), site);
      path.push({ min, az: sun.azimuth, alt: sun.altitude, enters: light.entersWindow });
    }
    return path;
  };

  const syncButtons = (): void => {
    ui.now.classList.toggle('on', clock.live);
    ui.play.textContent = clock.playing ? '❚❚' : '▶';
  };

  ui.now.addEventListener('click', () => { clock.setLive(true); syncButtons(); });
  ui.play.addEventListener('click', () => {
    clock.setLive(false);
    clock.playing = !clock.playing;
    syncButtons();
  });
  ui.speed.addEventListener('change', () => { clock.speed = Number(ui.speed.value); });
  ui.time.addEventListener('input', () => { clock.setLocalMinutes(Number(ui.time.value)); syncButtons(); });
  ui.date.addEventListener('change', () => { if (clock.setLocalDate(ui.date.value)) syncButtons(); });
  ui.showOverlay.checked = arrowOn;
  ui.showOverlay.addEventListener('change', () => hooks.setArrow(ui.showOverlay.checked));
  ui.showStripes.addEventListener('change', () => hooks.setStripes(ui.showStripes.checked));
  clock.speed = Number(ui.speed.value);
  syncButtons();

  return {
    syncArrow(on: boolean): void { ui.showOverlay.checked = on; },
    update(s: SolarState): void {
      const { sun, light } = s;
      const lp = clock.local();
      ui.clock.textContent = clock.format();
      if (document.activeElement !== ui.time) ui.time.value = String(lp.min);
      if (document.activeElement !== ui.date) ui.date.value = clock.ymd();
      syncButtons();

      const p = dayPath();
      drawPlan(ui.plan, site, s, p, declination);
      drawDayChart(ui.chart, p, lp.min);

      const screenAngle = Math.atan2(light.dirY, light.dirX) * 180 / Math.PI;
      const rows: [string, string][] = [
        ['場所', `${site.label}（${site.name}）`],
        ['緯度 / 経度', `${site.latitude.toFixed(5)} / ${site.longitude.toFixed(5)}`],
        ['スクリーン向き（真北）', `${site.facingAzimuth.toFixed(1)}°`],
        ['窓の外向き（真北）', `${site.windowAzimuth.toFixed(1)}°（${site.windowSide === 'right' ? '右' : '左'}）`],
        ['太陽 方位角', `${sun.azimuth.toFixed(2)}°`],
        ['太陽 高度', `${sun.altitude.toFixed(2)}°`],
        ['赤緯', `${sun.declination.toFixed(2)}°`],
        ['均時差', `${sun.equationOfTime.toFixed(2)} 分`],
        ['light x（右+）', light.x.toFixed(3)],
        ['light y（上+）', light.y.toFixed(3)],
        ['light z（奥+）', light.z.toFixed(3)],
        ['画面内の光の角度', `${screenAngle.toFixed(1)}°`],
        ['窓への入射 cos', light.windowIncidence.toFixed(3)],
        ['窓から光が入る', light.entersWindow ? '<span class="yes">入る</span>' : '入らない'],
        ['色温度（目安）', `${Math.round(kelvinAt(sun.altitude))} K`],
      ];
      ui.values.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    },
  };
}
