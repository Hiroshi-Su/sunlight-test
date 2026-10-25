// パース調整モード（room モードの中の切り替え）。現地で、投影した映像を見ながらパースを合わせるための画面。
// 入ると、視点を「現地に合わせた視点（固定）」にし、合わせるための線を出し、パネルを調整の項目（部屋・視点・パース合わせ）だけにする。
// 映像の上に、選んでいる項目と値・キーの説明を出す（全画面にしてパネルが見えなくても、キーボードだけで合わせられる）
//
// キー（パース調整モードの間だけ）：
//   1〜4 四隅（左上・右上・右下・左下）、5 目の位置、6 投影面、7 部屋の寸法 を選ぶ
//   ← → ↑ ↓ 選んだものを動かす（Shift で 10 倍）。+ − は距離・幅・奥行き、[ ] は投影面の高さ
//   G 合わせるための線、F 全画面、H この表示を隠す、S 保存、C パース調整モードを終わる
import type GUI from 'lil-gui';
import type { GuideOptions, RoomGeometry, ViewCalibration } from '../room/scene.ts';

export type WarpPct = Record<'tlx' | 'tly' | 'trx' | 'try' | 'brx' | 'bry' | 'blx' | 'bly', number>;

export interface CalibModeOptions {
  gui: GUI;
  /** パース調整モードでも出しておくフォルダ（部屋・視点・パース合わせ） */
  keep: GUI[];
  /** 全画面にする枠（映像の枠）。説明の表示もこの中に置く */
  view: HTMLElement;
  calib: ViewCalibration;
  room: RoomGeometry;
  warp: WarpPct;
  guides: GuideOptions;
  onCalibration(): void;
  /** 部屋の寸法を変えたとき（部屋を作り直す。キーを続けて押す間は待つ） */
  onRoomSize(): void;
  onWarp(): void;
  onGuides(): void;
  save(): Promise<string>;
}

type Item = 'tl' | 'tr' | 'br' | 'bl' | 'eye' | 'plane' | 'room';
const ITEMS: Item[] = ['tl', 'tr', 'br', 'bl', 'eye', 'plane', 'room'];
const ITEM_LABEL: Record<Item, string> = {
  tl: '左上の角', tr: '右上の角', br: '右下の角', bl: '左下の角', eye: '目の位置', plane: '投影面', room: '部屋の寸法',
};

export function mountCalibMode(o: CalibModeOptions) {
  const hud = document.createElement('div');
  hud.id = 'room-calib-hud';
  Object.assign(hud.style, {
    position: 'absolute', left: '12px', top: '12px', zIndex: '20', maxWidth: 'min(560px, calc(100% - 24px))',
    padding: '10px 12px', borderRadius: '6px', background: 'rgba(0, 0, 0, 0.72)', color: '#f2f2f2',
    font: '12px/1.6 "Hiragino Sans", system-ui, sans-serif', whiteSpace: 'pre-wrap', pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  hud.hidden = true;
  if (getComputedStyle(o.view).position === 'static') o.view.style.position = 'relative';
  o.view.append(hud);

  let active = false;
  let item: Item = 'eye';
  let hudOn = true;
  let message = '';
  let guidesBefore = o.guides.show;
  let roomTimer = 0;

  const refreshPanel = (): void => { o.gui.controllersRecursive().forEach((c) => c.updateDisplay()); };
  const f2 = (v: number): string => v.toFixed(2);
  const values = (): string => {
    const c = o.calib, w = o.warp;
    switch (item) {
      case 'tl': return `横 ${f2(w.tlx)}%  縦 ${f2(w.tly)}%`;
      case 'tr': return `横 ${f2(w.trx)}%  縦 ${f2(w.try)}%`;
      case 'br': return `横 ${f2(w.brx)}%  縦 ${f2(w.bry)}%`;
      case 'bl': return `横 ${f2(w.blx)}%  縦 ${f2(w.bly)}%`;
      case 'eye': return `左右 ${f2(c.eyeXM)}m（← →）  高さ ${f2(c.eyeHeightM)}m（↑ ↓）  投影面からの距離 ${f2(c.eyeDistM)}m（+ −）`;
      case 'plane': return `左右のずれ ${f2(c.planeXM)}m（← →）  下端の高さ ${f2(c.planeBottomM)}m（↑ ↓）  幅 ${f2(c.planeWidthM)}m（+ −）  高さ ${c.planeHeightM > 0 ? `${f2(c.planeHeightM)}m` : '画面の縦横比から'}（[ ]）`;
      case 'room': return `幅 ${f2(o.room.widthM)}m（← →）  高さ ${f2(o.room.heightM)}m（↑ ↓）  奥行き ${f2(o.room.depthM)}m（+ −）`;
    }
  };
  const render = (): void => {
    hud.hidden = !active || !hudOn;
    if (hud.hidden) return;
    hud.textContent = [
      'パース調整モード（C で終わる）',
      `選んでいるもの：${ITEM_LABEL[item]}　${values()}`,
      '1〜4 四隅（左上・右上・右下・左下）　5 目の位置　6 投影面　7 部屋の寸法',
      '← → ↑ ↓ で動かす（Shift で 10 倍）　+ − 距離・幅・奥行き　[ ] 投影面の高さ',
      `G 合わせるための線（${o.guides.show ? '出している' : '消している'}）　F 全画面　H この表示を隠す　S 保存`,
      ...(message ? [message] : []),
    ].join('\n');
  };

  const enter = (): void => {
    if (active) return;
    active = true;
    o.calib.mode = 'fixed';
    o.onCalibration();
    guidesBefore = o.guides.show;
    o.guides.show = true;
    o.onGuides();
    for (const f of o.gui.folders) f.show(o.keep.includes(f));
    for (const f of o.keep) f.open();
    refreshPanel();
    render();
  };
  const exit = (): void => {
    if (!active) return;
    active = false;
    o.guides.show = guidesBefore;
    o.onGuides();
    for (const f of o.gui.folders) f.show();
    refreshPanel();
    render();
  };

  // 値を動かす。dx・dy は矢印（右・上が正）、dz は + −、dh は [ ]
  const nudge = (dx: number, dy: number, dz: number, dh: number, big: boolean): void => {
    const c = o.calib, w = o.warp;
    const m = big ? 0.1 : 0.01; // m
    const p = big ? 0.5 : 0.05; // %
    const corner = (kx: keyof WarpPct, ky: keyof WarpPct): void => {
      w[kx] = Math.min(25, Math.max(-25, w[kx] + dx * p));
      w[ky] = Math.min(25, Math.max(-25, w[ky] - dy * p)); // 画面の縦は下が正。↑ で上へ
      o.onWarp();
    };
    switch (item) {
      case 'tl': corner('tlx', 'tly'); break;
      case 'tr': corner('trx', 'try'); break;
      case 'br': corner('brx', 'bry'); break;
      case 'bl': corner('blx', 'bly'); break;
      case 'eye':
        c.eyeXM += dx * m;
        c.eyeHeightM = Math.max(0, c.eyeHeightM + dy * m);
        c.eyeDistM = Math.max(0.3, c.eyeDistM + dz * m);
        o.onCalibration();
        break;
      case 'plane':
        c.planeXM += dx * m;
        c.planeBottomM += dy * m;
        c.planeWidthM = Math.max(0.5, c.planeWidthM + dz * m);
        if (dh) c.planeHeightM = Math.max(0, (c.planeHeightM > 0 ? c.planeHeightM : 0) + dh * m);
        o.onCalibration();
        break;
      case 'room':
        o.room.widthM = Math.max(2, o.room.widthM + dx * m);
        o.room.heightM = Math.max(2, o.room.heightM + dy * m);
        o.room.depthM = Math.max(2, o.room.depthM + dz * m);
        // 部屋を作り直すのは重いので、キーを離して少し待ってから
        clearTimeout(roomTimer);
        roomTimer = window.setTimeout(() => o.onRoomSize(), 350);
        break;
    }
    message = '';
    refreshPanel();
    render();
  };

  // 他のキー操作（原寸で見るときの 1〜5 など）より先に受け取る（捕捉の段階で受け取り、他へ渡さない）
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (!active) return;
    const k = e.key;
    const i = Number(k) - 1;
    let used = true;
    if (Number.isInteger(i) && i >= 0 && i < ITEMS.length) { item = ITEMS[i]!; message = ''; render(); }
    else if (k === 'ArrowLeft') nudge(-1, 0, 0, 0, e.shiftKey);
    else if (k === 'ArrowRight') nudge(1, 0, 0, 0, e.shiftKey);
    else if (k === 'ArrowUp') nudge(0, 1, 0, 0, e.shiftKey);
    else if (k === 'ArrowDown') nudge(0, -1, 0, 0, e.shiftKey);
    else if (k === '+' || k === '=' || k === ';') nudge(0, 0, 1, 0, e.shiftKey);
    else if (k === '-' || k === '_') nudge(0, 0, -1, 0, e.shiftKey);
    else if (k === ']' || k === '}') nudge(0, 0, 0, 1, e.shiftKey);
    else if (k === '[' || k === '{') nudge(0, 0, 0, -1, e.shiftKey);
    else if (k === 'g' || k === 'G') { o.guides.show = !o.guides.show; o.onGuides(); refreshPanel(); render(); }
    else if (k === 'f' || k === 'F') { if (document.fullscreenElement) void document.exitFullscreen(); else void o.view.requestFullscreen?.(); }
    else if (k === 'h' || k === 'H') { hudOn = !hudOn; render(); }
    else if (k === 's' || k === 'S') {
      message = '保存中…';
      render();
      void o.save().then((text) => { message = text; render(); });
    } else if (k === 'c' || k === 'C') exit();
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  // 全画面の出入りで、説明の表示も一緒に動く（枠の中にあるので何もしなくてよい）。終わったときに表示を整える
  addEventListener('fullscreenchange', render);

  return {
    get active(): boolean { return active; },
    enter,
    exit,
    toggle(): void { if (active) exit(); else enter(); },
  };
}
