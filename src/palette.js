// 太陽高度 → 色。演出上の目安（案件メモ 4.6）。現地で追い込む前提の仮値。

const lerp = (a, b, t) => a + (b - a) * t;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

function interpKeys(keys, alt) {
  if (alt <= keys[0][0]) return keys[0].slice(1);
  for (let i = 1; i < keys.length; i++) {
    if (alt <= keys[i][0]) {
      const t = (alt - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
      return keys[i].slice(1).map((v, j) => {
        const a = keys[i - 1][j + 1];
        return Array.isArray(v) ? v.map((c, k) => lerp(a[k], c, t)) : lerp(a, v, t);
      });
    }
  }
  return keys[keys.length - 1].slice(1);
}

// [高度, 空の上, 空の下]  純黒・純白は避ける
const SKY = [
  [-8, hex('#34386e'), hex('#5c4a7e')],
  [0, hex('#4f5896'), hex('#c98a78')],
  [5, hex('#7384bb'), hex('#e6ad80')],
  [20, hex('#86a6d2'), hex('#ecd6b6')],
  [35, hex('#93bbe0'), hex('#dfe6ea')],
];

const KELVIN = [[-8, 2000], [0, 2500], [5, 3500], [20, 5000], [30, 5800]];

export function skyColors(alt) {
  const [top, bottom] = interpKeys(SKY, alt);
  return { top, bottom };
}

export function kelvinAt(alt) {
  return interpKeys(KELVIN, alt)[0];
}

// Tanner Helland の近似。0..1 の RGB
export function kelvinToRgb(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((v) => Math.min(255, Math.max(0, v)) / 255);
}
