// 検証用の 2D 図。平面図（北が上）と 1 日の高度グラフ、スクリーン上の光ベクトル矢印。

import type { Site, SolarState } from './solar.ts';

export interface PathPoint { min: number; az: number; alt: number; enters: boolean }
type Pt = [number, number];

const RAD = Math.PI / 180;

function setupCanvas(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: width, h: height };
}

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, head = 10): void {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(a - 0.4), y1 - head * Math.sin(a - 0.4));
  ctx.lineTo(x1 - head * Math.cos(a + 0.4), y1 - head * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
}

// 平面図：中心 = 鑑賞者。太陽は天頂=中心、地平線=外周の極座標
export function drawPlan(canvas: HTMLCanvasElement, site: Site, state: SolarState, path: PathPoint[], declination: number): void {
  const { ctx, w, h } = setupCanvas(canvas);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 26;
  const pt = (az: number, r: number): Pt => [cx + r * Math.sin(az * RAD), cy - r * Math.cos(az * RAD)];
  const fg = css('--fg'), muted = css('--muted'), line = css('--line');
  ctx.clearRect(0, 0, w, h);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  for (const f of [1, 2 / 3, 1 / 3]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = muted;
  ([['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const).forEach(([t, a]) => {
    const [x, y] = pt(a, R + 14);
    ctx.fillText(t, x, y);
  });
  // 磁北
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = muted;
  const [mx, my] = pt(-declination, R);
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(mx, my); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillText('磁北', ...pt(-declination - 7, R - 10));

  // スクリーンと窓（鑑賞者からの距離 0.5R の壁として描く）
  const wall = (az: number, color: string, label: string, width: number): void => {
    const [x, y] = pt(az, R * 0.5);
    const [ax, ay] = pt(az + 90, R * 0.34);
    const dx = ax - cx, dy = ay - cy;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(label, ...pt(az, R * 0.5 + 16));
  };
  wall(site.facingAzimuth, css('--screen'), 'スクリーン', 5);
  if (site.windowSide === 'ceiling') {
    // 天窓：鑑賞者の真上に四角で示す
    const s = R * 0.12;
    ctx.strokeStyle = ctx.fillStyle = css('--window');
    ctx.lineWidth = 3;
    ctx.strokeRect(cx - s, cy - s, s * 2, s * 2);
    ctx.fillText('天窓', cx + s + 4, cy - s);
  } else {
    wall(site.windowAzimuth, css('--window'), '窓', 3);
  }

  ctx.strokeStyle = css('--screen');
  ctx.fillStyle = css('--screen');
  ctx.lineWidth = 2;
  arrow(ctx, cx, cy, ...pt(site.facingAzimuth, R * 0.32), 8);

  // 太陽の軌跡
  ctx.lineWidth = 2;
  let prev: Pt | null = null;
  for (const p of path) {
    if (p.alt <= 0) { prev = null; continue; }
    const cur = pt(p.az, R * (1 - p.alt / 90));
    if (prev) {
      ctx.strokeStyle = p.enters ? css('--sun') : line;
      ctx.beginPath(); ctx.moveTo(...prev); ctx.lineTo(...cur); ctx.stroke();
    }
    prev = cur;
  }

  const { sun, light } = state;
  if (sun.altitude > 0) {
    const [sx, sy] = pt(sun.azimuth, R * (1 - sun.altitude / 90));
    if (light.entersWindow) {
      ctx.strokeStyle = css('--sun');
      ctx.fillStyle = css('--sun');
      ctx.lineWidth = 1.5;
      arrow(ctx, sx, sy, cx + (sx - cx) * 0.12, cy + (sy - cy) * 0.12, 8);
    }
    ctx.fillStyle = light.entersWindow ? css('--sun') : muted;
    ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = fg;
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
}

// 1 日の高度グラフ。金色の帯 = 窓から光が入る時間
export function drawDayChart(canvas: HTMLCanvasElement, path: PathPoint[], nowMinutes: number): void {
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  const X = (m: number): number => pad.l + (m / 1440) * (w - pad.l - pad.r);
  const Y = (a: number): number => pad.t + (1 - (a + 10) / 90) * (h - pad.t - pad.b);
  const muted = css('--muted'), line = css('--line');
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px system-ui, sans-serif';

  ctx.fillStyle = css('--sun-soft');
  let start: number | null = null;
  path.forEach((p, i) => {
    if (p.enters && start === null) start = p.min;
    if (start !== null && (!p.enters || i === path.length - 1)) {
      ctx.fillRect(X(start), pad.t, X(p.min) - X(start), h - pad.t - pad.b);
      start = null;
    }
  });

  ctx.strokeStyle = line;
  ctx.fillStyle = muted;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const a of [0, 20, 40, 60, 80]) {
    ctx.beginPath(); ctx.moveTo(pad.l, Y(a)); ctx.lineTo(w - pad.r, Y(a)); ctx.stroke();
    ctx.fillText(`${a}°`, pad.l - 5, Y(a));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let hr = 0; hr <= 24; hr += 3) ctx.fillText(`${hr}`, X(hr * 60), h - pad.b + 5);

  ctx.strokeStyle = css('--fg');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  path.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p.min), Y(Math.max(p.alt, -10))));
  ctx.stroke();

  ctx.strokeStyle = css('--screen');
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(nowMinutes), pad.t); ctx.lineTo(X(nowMinutes), h - pad.b); ctx.stroke();
}

// ---- スクリーン上に重ねる表示（3840×1080 の実座標で描く。消去は呼び出し側）----

export function drawLightArrow(ctx: CanvasRenderingContext2D, site: Site, state: SolarState): void {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const { light } = state;
  const cx = w / 2, cy = h / 2, L = 320;
  ctx.lineWidth = 8;
  ctx.strokeStyle = ctx.fillStyle = light.entersWindow ? 'rgba(40,30,10,0.85)' : 'rgba(40,40,60,0.45)';
  arrow(ctx, cx - light.dirX * L, cy + light.dirY * L, cx + light.dirX * L, cy - light.dirY * L, 48);

  ctx.font = '600 56px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(30,30,50,0.7)';
  const winText = '窓';
  if (site.windowSide === 'right') { ctx.textAlign = 'right'; ctx.fillText(`${winText} ▶`, w - 40, 70); }
  else if (site.windowSide === 'left') { ctx.textAlign = 'left'; ctx.fillText(`◀ ${winText}`, 40, 70); }
  else { ctx.textAlign = 'center'; ctx.fillText(`▲ ${winText}（天井）`, w / 2, 70); }
  ctx.textAlign = 'left';
  ctx.font = '40px system-ui, sans-serif';
  ctx.fillText(`light = (${light.x.toFixed(3)}, ${light.y.toFixed(3)}, ${light.z.toFixed(3)})`, 40, h - 60);
}

export interface GuideOptions { seamSpacingPx: number; seamOffsetPx: number; overlapPx: number }

/** ガラスの継ぎ目（縦線）と、2 台のプロジェクターが重なる範囲（中央の帯） */
export function drawGuides(ctx: CanvasRenderingContext2D, g: GuideOptions): void {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.save();
  if (g.overlapPx > 0) {
    const x0 = (w - g.overlapPx) / 2;
    ctx.fillStyle = 'rgba(220, 60, 160, 0.16)';
    ctx.fillRect(x0, 0, g.overlapPx, h);
    ctx.strokeStyle = 'rgba(220, 60, 160, 0.8)';
    ctx.lineWidth = 3;
    ctx.strokeRect(x0, 0, g.overlapPx, h);
    ctx.fillStyle = 'rgba(220, 60, 160, 0.9)';
    ctx.font = '600 36px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`重なり ${g.overlapPx}px`, w / 2, h - 40);
  }
  if (g.seamSpacingPx > 0) {
    ctx.strokeStyle = 'rgba(20, 170, 190, 0.85)';
    ctx.lineWidth = 3;
    ctx.setLineDash([24, 16]);
    const start = ((g.seamOffsetPx % g.seamSpacingPx) + g.seamSpacingPx) % g.seamSpacingPx;
    for (let x = start; x <= w; x += g.seamSpacingPx) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }
  ctx.restore();
}
