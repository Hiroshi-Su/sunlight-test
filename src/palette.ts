// 太陽高度 → 色。演出上の目安（案件メモ 4.6）。現地で追い込む前提の仮値。

export type RGB = [number, number, number];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpRgb = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

/** keys は高度の昇順。範囲外は端の値 */
function interp<T>(keys: readonly (readonly [number, T])[], alt: number, mix: (a: T, b: T, t: number) => T): T {
  const first = keys[0]!;
  if (alt <= first[0]) return first[1];
  for (let i = 1; i < keys.length; i++) {
    const [a0, v0] = keys[i - 1]!;
    const [a1, v1] = keys[i]!;
    if (alt <= a1) return mix(v0, v1, (alt - a0) / (a1 - a0));
  }
  return keys[keys.length - 1]![1];
}

interface Sky { top: RGB; bottom: RGB }

// 純黒・純白は避ける
const SKY: readonly (readonly [number, Sky])[] = [
  [-8, { top: hex('#34386e'), bottom: hex('#5c4a7e') }],
  [0, { top: hex('#4f5896'), bottom: hex('#c98a78') }],
  [5, { top: hex('#7384bb'), bottom: hex('#e6ad80') }],
  [20, { top: hex('#86a6d2'), bottom: hex('#ecd6b6') }],
  [35, { top: hex('#93bbe0'), bottom: hex('#dfe6ea') }],
];

const KELVIN: readonly (readonly [number, number])[] = [[-8, 2000], [0, 2500], [5, 3500], [20, 5000], [30, 5800]];

export function skyColors(alt: number): Sky {
  return interp(SKY, alt, (a, b, t) => ({ top: lerpRgb(a.top, b.top, t), bottom: lerpRgb(a.bottom, b.bottom, t) }));
}

export function kelvinAt(alt: number): number {
  return interp(KELVIN, alt, lerp);
}

// Tanner Helland の近似。0..1 の RGB
export function kelvinToRgb(k: number): RGB {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v: number): number => Math.min(255, Math.max(0, v)) / 255;
  return [c(r), c(g), c(b)];
}
