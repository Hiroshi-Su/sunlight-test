// 月の位置と満ち欠け（three.js 非依存）。Meeus『Astronomical Algorithms』47 章・48 章の主な項だけを使う簡易式（位置の誤差はおよそ 0.3°）。
// 太陽の位置（src/solar.ts）と同じく、方位は北 = 0°・東 = 90°（時計回り）、高度は水平 = 0°。

export interface MoonPosition {
  /** 方位（度、北 0・東 90） */
  azimuth: number;
  /** 高度（度、見る場所から見た値。地球の半径の分のずれ（視差）を直したもの。大気差は直さない） */
  altitude: number;
  /** 照らされている割合（0 = 新月、1 = 満月） */
  illumination: number;
  /** 位相角（度、0 = 満月、180 = 新月）。月の明るさは位相角で急に変わる（半月で満月の約 1/10） */
  phaseAngle: number;
  /** 満月を 1 とした、地上を照らす明るさの割合（位相角から。Allen の式 10^(−0.4·(0.026|i| + 4×10⁻⁹·i⁴))） */
  brightness: number;
  /** 地球からの距離（km） */
  distanceKm: number;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const norm360 = (a: number): number => ((a % 360) + 360) % 360;
const sin = (d: number): number => Math.sin(d * RAD);
const cos = (d: number): number => Math.cos(d * RAD);

/** 月の黄経・黄緯（度）と距離（km）。d は 2000 年 1 月 1.5 日（J2000.0）からの日数 */
export function moonEcliptic(d: number): { lambda: number; beta: number; distanceKm: number; D: number; M: number; Mp: number } {
  const Lp = norm360(218.3164477 + 13.17639648 * d); // 月の平均黄経
  const D = norm360(297.8501921 + 12.19074912 * d); // 月と太陽の平均離角
  const M = norm360(357.5291092 + 0.98560028 * d); // 太陽の平均近点角
  const Mp = norm360(134.9633964 + 13.06499295 * d); // 月の平均近点角
  const F = norm360(93.272095 + 13.22935024 * d); // 月の昇交点からの角度
  const lambda = norm360(Lp + 6.289 * sin(Mp) + 1.274 * sin(2 * D - Mp) + 0.658 * sin(2 * D) + 0.214 * sin(2 * Mp)
    - 0.186 * sin(M) - 0.114 * sin(2 * F) + 0.059 * sin(2 * D - 2 * Mp) + 0.057 * sin(2 * D - M - Mp)
    + 0.053 * sin(2 * D + Mp) + 0.046 * sin(2 * D - M) - 0.041 * sin(M - Mp) - 0.035 * sin(D) - 0.031 * sin(M + Mp));
  const beta = 5.128 * sin(F) + 0.281 * sin(Mp + F) + 0.278 * sin(Mp - F) + 0.173 * sin(2 * D - F)
    + 0.055 * sin(2 * D - Mp + F) + 0.046 * sin(2 * D - Mp - F) + 0.033 * sin(2 * D + F);
  const distanceKm = 385001 - 20905 * cos(Mp) - 3699 * cos(2 * D - Mp) - 2956 * cos(2 * D) - 570 * cos(2 * Mp);
  return { lambda, beta, distanceKm, D, M, Mp };
}

/** 日時 date に、緯度 lat・経度 lon（度、東が正）から見た月 */
export function moonPosition(date: Date, lat: number, lon: number): MoonPosition {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const { lambda, beta, distanceKm, D, M, Mp } = moonEcliptic(d);
  // 黄道座標 → 赤道座標（赤経 ra・赤緯 dec）
  const eps = 23.4393 - 3.563e-7 * d;
  const ra = norm360(Math.atan2(sin(lambda) * cos(eps) - Math.tan(beta * RAD) * sin(eps), cos(lambda)) * DEG);
  const dec = Math.asin(sin(beta) * cos(eps) + cos(beta) * sin(eps) * sin(lambda)) * DEG;
  // 時角（地方恒星時 − 赤経）
  const gmst = norm360(280.46061837 + 360.98564736629 * d);
  const ha = norm360(gmst + lon - ra);
  const altGeo = Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(ha)) * DEG;
  const azimuth = norm360(Math.atan2(sin(ha), cos(ha) * sin(lat) - Math.tan(dec * RAD) * cos(lat)) * DEG + 180);
  // 視差：地球の表面から見ると、中心から見るより月が低く見える（地平線の近くで約 1°）
  const altitude = altGeo - Math.asin((6378.14 / distanceKm) * cos(altGeo)) * DEG;
  // 位相角（Meeus 48.4 の近似）と照らされている割合
  const i = norm360(180 - D - 6.289 * sin(Mp) + 2.1 * sin(M) - 1.274 * sin(2 * D - Mp) - 0.658 * sin(2 * D) - 0.214 * sin(2 * Mp) - 0.11 * sin(D));
  const phaseAngle = i > 180 ? 360 - i : i;
  const illumination = (1 + cos(phaseAngle)) / 2;
  const brightness = 10 ** (-0.4 * (0.026 * phaseAngle + 4e-9 * phaseAngle ** 4));
  return { azimuth, altitude, illumination, phaseAngle, brightness, distanceKm };
}
