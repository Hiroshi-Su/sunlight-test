// 時刻の操作パネル（lil-gui）。visuals・room の両モードで共通に使う
import type GUI from 'lil-gui';
import type { Clock } from '../clock.ts';

const SPEEDS: Record<string, number> = {
  '1×（実時間）': 1,
  '60×（1分/秒）': 60,
  '600×（10分/秒）': 600,
  '1440×（1日/1分）': 1440,
  '3600×（1時間/秒）': 3600,
};

export function mountTimeControls(gui: GUI, clock: Clock, folderName = '時刻'): GUI {
  const t = {
    get label() { return clock.format(); },
    get live() { return clock.live; },
    set live(v: boolean) { clock.setLive(v); },
    get playing() { return clock.playing; },
    set playing(v: boolean) { clock.setLive(false); clock.playing = v; },
    get speed() { return clock.speed; },
    set speed(v: number) { clock.speed = Number(v); },
    get minutes() { return clock.local().min; },
    set minutes(v: number) { clock.setLocalMinutes(v); },
    get date() { return clock.ymd(); },
    set date(v: string) { clock.setLocalDate(v); },
    fastDay() {
      clock.setLocalMinutes(0);
      clock.speed = 1440;
      clock.playing = true;
    },
  };
  const ft = gui.addFolder(folderName);
  ft.add(t, 'label').name('表示中').disable().listen();
  ft.add(t, 'live').name('現在時刻').listen();
  ft.add(t, 'playing').name('再生').listen();
  ft.add(t, 'speed', SPEEDS).name('速さ').listen();
  ft.add(t, 'minutes', 0, 1439, 1).name('時刻（分）').listen();
  ft.add(t, 'date').name('日付 YYYY-MM-DD').listen();
  ft.add(t, 'fastDay').name('1日を1分で早送り');
  return ft;
}
