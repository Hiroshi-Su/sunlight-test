// 太陽高度から、直射日光と空の明るさの目安を求める（three.js 非依存。room モードのパストレーシング用）
const RAD = Math.PI / 180;

/** 太陽の見かけの半径（度）。直径は約 0.53° */
export const SUN_ANGULAR_RADIUS_DEG = 0.2665;

/** 大気の通り道の長さ（天頂 = 1）。Kasten & Young (1989)。太陽が地平線の下なら Infinity */
export function airMass(altDeg: number): number {
  if (altDeg <= 0) return Infinity;
  return 1 / (Math.sin(altDeg * RAD) + 0.50572 * (altDeg + 6.07995) ** -1.6364);
}

/** 直射日光の強さ（大気の外 = 1）。Meinel (1976) の近似 0.7^(AM^0.678)。天頂で約 0.7、高度 10° で約 0.32 */
export function directSunFactor(altDeg: number): number {
  const am = airMass(altDeg);
  return Number.isFinite(am) ? 0.7 ** (am ** 0.678) : 0;
}

/**
 * 空の明るさの目安（天頂付近の昼 = 1）。演出上の近似：
 * 昼は太陽が高いほど明るく、日没後は薄明（高度 -6° まで）で暗くなり、夜は最低限の明るさを残す
 */
export function skyBrightness(altDeg: number): number {
  const NIGHT = 0.01;
  if (altDeg <= -6) return NIGHT;
  if (altDeg <= 0) return NIGHT + (0.15 - NIGHT) * ((altDeg + 6) / 6);
  return 0.15 + 0.85 * Math.sqrt(Math.sin(altDeg * RAD));
}
