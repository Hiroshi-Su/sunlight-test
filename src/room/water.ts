// room モードの水面：向きと波長の違う正弦波の重ね合わせ（波の高さと傾き）。
// 波の速さは水の波の分散関係 ω² = g·k + (σ/ρ)·k³ から決める（長い波ほど速い。数 cm 以下のさざ波は表面張力で速くなる）。
// 位相 ω·t は倍精度の CPU 側で 2π で巻き戻してから GPU に渡す（長時間動かしても波がカクつかない）。

const G = 9.81; // 重力加速度（m/s²）
const SIGMA_RHO = 7.28e-5; // 水の表面張力 / 密度（m³/s²）

/** 水の屈折率 */
export const WATER_IOR = 1.333;

/**
 * 水の吸収係数（1/m、R・G・B）。赤い光ほど吸収されやすいので、深いほど青緑になる。
 * 純水の吸収（赤 650nm 付近 約 0.35/m、緑 550nm 約 0.06/m、青 450nm 約 0.01/m）の目安
 */
export const WATER_ABSORPTION = [0.35, 0.06, 0.015] as const;

/** 波数 k（1/m）の水の波の角振動数 ω（rad/s）。ω² = g·k + (σ/ρ)·k³ */
export function angularFrequency(k: number): number {
  return Math.sqrt(G * k + SIGMA_RHO * k ** 3);
}

interface Wave { kx: number; kz: number; amp: number; omega: number }

// 決まった並びの乱数（毎回同じ波になるように）
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 波の組を作る。波長は min〜max の間に対数で並べ、向きは風向きのまわりにばらつかせる。
 * steepness は 1 本あたりの「振幅 × 波数」（波の傾きの大きさ）
 */
function makeWaves(count: number, lambdaMin: number, lambdaMax: number, steepness: number, windDeg: number, spreadDeg: number, seed: number): Wave[] {
  const rnd = seeded(seed);
  const out: Wave[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const lambda = lambdaMin * (lambdaMax / lambdaMin) ** t;
    const k = (2 * Math.PI) / lambda;
    const a = ((windDeg + spreadDeg * (rnd() * 2 - 1)) * Math.PI) / 180;
    out.push({
      kx: k * Math.cos(a),
      kz: k * Math.sin(a),
      amp: (steepness / k) * (0.6 + 0.8 * rnd()),
      omega: angularFrequency(k),
    });
  }
  return out;
}

// 水盤（床の浅い水）：波長 5〜60cm のさざ波。向きは全方向にばらつかせる（規則的な模様にならないように）
const POOL = makeWaves(16, 0.05, 0.6, 0.012, 35, 180, 11);
// 窓の外の水面（海・川）：波長 0.5〜6m の波
const SEA = makeWaves(12, 0.5, 6.0, 0.013, -20, 60, 23);
// 海のきらめき用の細かい波（窓から見える海の見た目だけに使う。光の揺らぎの計算には使わない）
const FINE = makeWaves(8, 0.05, 0.35, 0.02, -10, 80, 37);

const glslSet = (name: string, waves: Wave[]): string => {
  const n = waves.length;
  const list = waves.map((w) => `vec3(${w.kx.toFixed(5)}, ${w.kz.toFixed(5)}, ${w.amp.toExponential(5)})`).join(',\n  ');
  return `
const vec3 ${name}_W[${n}] = vec3[${n}](
  ${list}
);
uniform float u${name}Ph[${n}];
// 高さと、x・z 方向の傾き（vec3(h, dh/dx, dh/dz)）
vec3 ${name.toLowerCase()}Wave(vec2 p) {
  vec3 r = vec3(0.0);
  for (int i = 0; i < ${n}; i++) {
    vec3 w = ${name}_W[i];
    float a = dot(w.xy, p) - u${name}Ph[i];
    r += w.z * vec3(sin(a), w.x * cos(a), w.y * cos(a));
  }
  return r * uWaveAmp;
}`;
};

/** 波の GLSL（uWaveAmp：波の強さの倍率、u*Ph：各波の位相） */
export const WATER_GLSL = /* glsl */ `
uniform float uWaveAmp;
${glslSet('POOL', POOL)}
${glslSet('SEA', SEA)}
${glslSet('FINE', FINE)}

vec3 waveNormal(vec3 hw) { return normalize(vec3(-hw.y, 1.0, -hw.z)); }

// 水面での反射の割合（フレネル反射、Schlick の近似。真上から約 2%、水平に近いほど 100% に近づく）
float fresnelWater(float cosI) {
  float f0 = ${(((WATER_IOR - 1) / (WATER_IOR + 1)) ** 2).toFixed(5)};
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosI, 0.0, 1.0), 5.0);
}
`;

/** 時刻 t（秒）での各波の位相。ω·t を 2π で巻き戻す */
export function wavePhases(t: number): { pool: Float32Array; sea: Float32Array; fine: Float32Array } {
  const ph = (ws: Wave[]): Float32Array => Float32Array.from(ws, (w) => (w.omega * t) % (2 * Math.PI));
  return { pool: ph(POOL), sea: ph(SEA), fine: ph(FINE) };
}

export const WAVE_COUNTS = { pool: POOL.length, sea: SEA.length, fine: FINE.length };
