// 四隅の位置合わせ（台形補正）：映像の四隅を動かした四角形に、映像全体を写す（射影変換）。
// 画面に出すときに CSS の transform（matrix3d）で変形するので、描く方式（WebGPU・WebGL2）によらず、計算の重さも変わらない

/** 四隅のずらし量。左上・右上・右下・左下の順に [横, 縦]。幅・高さに対する割合（右・下が正） */
export type WarpCorners = [[number, number], [number, number], [number, number], [number, number]];

export const NO_WARP: WarpCorners = [[0, 0], [0, 0], [0, 0], [0, 0]];

/**
 * 単位正方形 (0,0) (1,0) (1,1) (0,1) を、四角形 q0..q3 に写す 3×3 の射影変換（行優先、[a b c; d e f; g h 1]）。
 * Heckbert (1989) の式
 */
export function squareToQuad(q: [number, number][]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q as [[number, number], [number, number], [number, number], [number, number]];
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    // 平行四辺形（アフィン変換）
    return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  }
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

/** 幅 w・高さ h の箱を、四隅をずらした四角形へ変形する CSS の transform（transform-origin は左上） */
export function warpCss(w: number, h: number, c: WarpCorners): string {
  if (c.every(([x, y]) => x === 0 && y === 0)) return '';
  const base: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]];
  const q = base.map(([x, y], i) => [x + c[i]![0] * w, y + c[i]![1] * h] as [number, number]);
  const [a, b, cc, d, e, f, g, hh, i] = squareToQuad(q) as [number, number, number, number, number, number, number, number, number];
  // 箱の座標（px）→ 単位正方形 → 四角形。単位正方形へは 1/w・1/h で縮める
  const m = [a / w, b / h, cc, d / w, e / h, f, g / w, hh / h, i];
  // CSS の matrix3d は列優先の 4×4（z はそのまま）
  return `matrix3d(${[m[0], m[3], 0, m[6], m[1], m[4], 0, m[7], 0, 0, 1, 0, m[2], m[5], 0, m[8]].map((v) => +v!.toFixed(9)).join(',')})`;
}
