// 部屋の中央の光の軌跡：線の動きの計算（CPU）。
// three-line-trails（ray-zero3、ライセンスの表記なし）と同じ考え方の演出を、コードは写さずに書き直したもの：
// たくさんの線の先頭が、場所と時間で変わるノイズの流れに乗って漂い、中心へ引き戻される。残りの点は 1 つずつ後ろへずれて軌跡になる。
// 毎フレーム計算するのは線の先頭だけ（既定 1,024 点）なので、GPU ではなく CPU で計算する（WebGPU・WebGL2 で同じ動きになる）

/** 0〜1 の乱数（種を決められる、mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 3 次元のなめらかなノイズ（勾配ノイズ。Perlin の改良版と同じ考え方で、ここで書いたもの）。値はおおよそ -1〜1
 */
export class Noise3 {
  private readonly perm = new Uint8Array(512);
  constructor(seed = 1) {
    const r = rng(seed);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
  }

  noise(x: number, y: number, z: number): number {
    const P = this.perm;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const X = xi & 255, Y = yi & 255, Z = zi & 255;
    x -= xi; y -= yi; z -= zi;
    const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
    const u = fade(x), v = fade(y), w = fade(z);
    // 立方体の 12 本の辺の向きから勾配を選ぶ
    const grad = (h: number, gx: number, gy: number, gz: number): number => {
      const k = h & 15;
      const a = k < 8 ? gx : gy;
      const b = k < 4 ? gy : k === 12 || k === 14 ? gx : gz;
      return ((k & 1) ? -a : a) + ((k & 2) ? -b : b);
    };
    const A = P[X]! + Y, AA = P[A]! + Z, AB = P[A + 1]! + Z, B = P[X + 1]! + Y, BA = P[B]! + Z, BB = P[B + 1]! + Z;
    const lerp = (t: number, a: number, b: number): number => a + t * (b - a);
    return lerp(w,
      lerp(v, lerp(u, grad(P[AA]!, x, y, z), grad(P[BA]!, x - 1, y, z)), lerp(u, grad(P[AB]!, x, y - 1, z), grad(P[BB]!, x - 1, y - 1, z))),
      lerp(v, lerp(u, grad(P[AA + 1]!, x, y, z - 1), grad(P[BA + 1]!, x - 1, y, z - 1)), lerp(u, grad(P[AB + 1]!, x, y - 1, z - 1), grad(P[BB + 1]!, x - 1, y - 1, z - 1))));
  }
}

/** 流れ（カールノイズ）の値を流れの速さに直す倍率。パネルの「速さ」が、おおよそ実際の速さ（m/s）になる */
const FLOW = 0.75;

/** 動きの設定 */
export interface TrailMotion {
  /** 線の本数・1 本あたりの点の数（軌跡の長さ） */
  count: number;
  points: number;
  /** 速さ（m/s の目安） */
  speed: number;
  /** 流れの細かさ（大きいほど細かく曲がる。1/m） */
  turbulence: number;
  /**
   * 線ごとのばらつき（0 で全部の線が同じ流れを読む）。流れだけで動かすと線が少数の流れに集まって束になるので、
   * 線ごとに少しずらした場所の流れを読ませて、ばらけさせる
   */
  spread: number;
  /** 漂う範囲（中心からの半径、m）と中心の位置（three.js の座標） */
  radiusM: number;
  center: { x: number; y: number; z: number };
  /** 高さの範囲（床と天井を越えないように。床より下に行くと水盤の水面の下に見えてしまう） */
  minY: number;
  maxY: number;
}

/**
 * 線の動き。positions は「線 × 点 × xyz」の並び（点 0 が先頭）。
 * 毎フレーム、先頭をノイズの流れで進め、残りを 1 つずつ後ろへずらす
 */
export class TrailSim {
  readonly maxCount: number;
  readonly maxPoints: number;
  readonly positions: Float32Array;
  private readonly vel: Float32Array;
  private readonly noise = new Noise3(7);
  private time = 0;
  private count = 0;
  private points = 0;
  private readonly random = rng(11);

  constructor(maxCount: number, maxPoints: number) {
    this.maxCount = maxCount;
    this.maxPoints = maxPoints;
    this.positions = new Float32Array(maxCount * maxPoints * 3);
    this.vel = new Float32Array(maxCount * 3);
    // 線ごとの、流れを読む場所のずれ（-1〜1）
    this.offset = new Float32Array(maxCount * 3);
    for (let i = 0; i < this.offset.length; i++) this.offset[i] = this.random() * 2 - 1;
  }

  private readonly offset: Float32Array;

  /** 線をすべて置き直す（範囲の中に散らし、軌跡は先頭と同じ点に重ねる） */
  reset(m: TrailMotion): void {
    this.count = Math.min(this.maxCount, Math.max(1, Math.round(m.count)));
    this.points = Math.min(this.maxPoints, Math.max(2, Math.round(m.points)));
    for (let i = 0; i < this.maxCount; i++) {
      // 球の中に一様に散らす
      const u = this.random() * 2 - 1, th = this.random() * Math.PI * 2, r = Math.cbrt(this.random()) * m.radiusM;
      const s = Math.sqrt(1 - u * u);
      const x = m.center.x + r * s * Math.cos(th), y = m.center.y + r * u, z = m.center.z + r * s * Math.sin(th);
      for (let k = 0; k < this.maxPoints; k++) this.positions.set([x, y, z], (i * this.maxPoints + k) * 3);
      this.vel.fill(0, i * 3, i * 3 + 3);
    }
  }

  get activeCount(): number { return this.count; }
  get activePoints(): number { return this.points; }

  /**
   * dt 秒ぶん進める。軌跡の点の間隔がフレームの速さで変わらないよう、1/60 秒ずつ進める（1 フレームに最大 4 回）
   */
  step(m: TrailMotion, dt: number): void {
    const count = Math.min(this.maxCount, Math.max(1, Math.round(m.count)));
    const points = Math.min(this.maxPoints, Math.max(2, Math.round(m.points)));
    if (count !== this.count || points !== this.points || this.count === 0) this.reset(m);
    this.pending = Math.min(4 / 60, this.pending + Math.max(0, dt));
    while (this.pending >= 1 / 60) {
      this.pending -= 1 / 60;
      this.tick(m, 1 / 60);
    }
  }

  private pending = 0;

  private tick(m: TrailMotion, d: number): void {
    const count = this.count, points = this.points;
    this.time += d;
    const P = this.positions, V = this.vel, n = this.noise, M = this.maxPoints;
    const f = m.turbulence, t = this.time * 0.15;
    const R = Math.max(0.05, m.radiusM), c = m.center;
    for (let i = 0; i < count; i++) {
      const o = i * M * 3;
      // 1 つずつ後ろへずらす（先頭は下で進める）
      P.copyWithin(o + 3, o, o + (points - 1) * 3);
      const x = P[o]!, y = P[o + 1]!, z = P[o + 2]!;
      // 流れ：3 つの別の場所でノイズを読んで、向きにする（時間でゆっくり変わる）
      const ox = this.offset[i * 3]! * m.spread, oy = this.offset[i * 3 + 1]! * m.spread, oz = this.offset[i * 3 + 2]! * m.spread;
      // 流れ：カールノイズ（3 つのノイズを「ベクトルの場」とみなし、その回転を流れにする）。
      // 吸い込まれる場所・湧き出す場所がない流れなので、全部の線が同じ流れに乗っても 1 つの束にならず、
      // 近くの線どうしは同じ向きに流れる。時間でゆっくり変わる
      const ux = x * f + ox, uy = y * f + oy, uz = z * f + oz;
      const A = (a: number, b: number, c: number): number => n.noise(a + 11.3, b + t, c - 4.1);
      const B = (a: number, b: number, c: number): number => n.noise(a - 7.7, b + 2.9, c + t);
      const C = (a: number, b: number, c: number): number => n.noise(a + t, b - 13.1, c + 5.3);
      const e = 0.05, k2 = 1 / (2 * e);
      const fx = ((C(ux, uy + e, uz) - C(ux, uy - e, uz)) - (B(ux, uy, uz + e) - B(ux, uy, uz - e))) * k2;
      const fy = ((A(ux, uy, uz + e) - A(ux, uy, uz - e)) - (C(ux + e, uy, uz) - C(ux - e, uy, uz))) * k2;
      const fz = ((B(ux + e, uy, uz) - B(ux - e, uy, uz)) - (A(ux, uy + e, uz) - A(ux, uy - e, uz))) * k2;
      // 中心へ引き戻す力（範囲の外ほど強い）
      const dx = x - c.x, dy = y - c.y, dz = z - c.z;
      const dist = Math.hypot(dx, dy, dz);
      const pull = (dist / R) ** 2;
      const vi = i * 3;
      const k = 3 * d; // 速さが流れの向きに追いつく早さ
      V[vi] = V[vi]! + ((fx * FLOW - (dx / R) * pull) * m.speed - V[vi]!) * k;
      V[vi + 1] = V[vi + 1]! + ((fy * FLOW - (dy / R) * pull) * m.speed - V[vi + 1]!) * k;
      V[vi + 2] = V[vi + 2]! + ((fz * FLOW - (dz / R) * pull) * m.speed - V[vi + 2]!) * k;
      P[o] = x + V[vi]! * d;
      P[o + 1] = Math.min(m.maxY, Math.max(m.minY, y + V[vi + 1]! * d));
      P[o + 2] = z + V[vi + 2]! * d;
    }
  }
}
