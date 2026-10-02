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
const SKY_DEFAULT: readonly (readonly [number, Sky])[] = [
  [-8, { top: hex('#34386e'), bottom: hex('#5c4a7e') }],
  [0, { top: hex('#4f5896'), bottom: hex('#c98a78') }],
  [5, { top: hex('#7384bb'), bottom: hex('#e6ad80') }],
  [20, { top: hex('#86a6d2'), bottom: hex('#ecd6b6') }],
  [35, { top: hex('#93bbe0'), bottom: hex('#dfe6ea') }],
];

const KELVIN_DEFAULT: readonly (readonly [number, number])[] = [[-8, 2000], [0, 2500], [5, 3500], [20, 5000], [30, 5800]];

// 今使っている表（room モードのパネルで変えられる。setPalette）
let SKY: readonly (readonly [number, Sky])[] = SKY_DEFAULT;
let KELVIN: readonly (readonly [number, number])[] = KELVIN_DEFAULT;

/** 表の形（太陽の高度は既定のまま、値だけを変える）。色は #rrggbb */
export interface PaletteTable {
  /** 太陽の高度（度）ごとの日差しの色温度（K）。高度は PALETTE_KELVIN_ALTS の順 */
  kelvin: number[];
  /** 太陽の高度（度）ごとの空の上の色・地平線の近くの色。高度は PALETTE_SKY_ALTS の順 */
  sky: { top: string; bottom: string }[];
}
export const PALETTE_KELVIN_ALTS: readonly number[] = KELVIN_DEFAULT.map(([a]) => a);
export const PALETTE_SKY_ALTS: readonly number[] = SKY_DEFAULT.map(([a]) => a);

const toHex = (c: RGB): string => `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const isHex = (h: string): boolean => /^#[0-9a-f]{6}$/i.test(h);

/** 既定の表（コードに書いた目安の値） */
export function defaultPalette(): PaletteTable {
  return {
    kelvin: KELVIN_DEFAULT.map(([, k]) => k),
    sky: SKY_DEFAULT.map(([, s]) => ({ top: toHex(s.top), bottom: toHex(s.bottom) })),
  };
}

/** 表を差し替える（数が合わない・おかしい値は既定のまま） */
export function setPalette(p: PaletteTable): void {
  KELVIN = KELVIN_DEFAULT.map(([a, k], i) => {
    const v = p.kelvin[i];
    return [a, typeof v === 'number' && Number.isFinite(v) ? Math.min(40000, Math.max(1000, v)) : k] as const;
  });
  SKY = SKY_DEFAULT.map(([a, s], i) => {
    const v = p.sky[i];
    return [a, {
      top: v && isHex(v.top) ? hex(v.top) : s.top,
      bottom: v && isHex(v.bottom) ? hex(v.bottom) : s.bottom,
    }] as const;
  });
}

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
