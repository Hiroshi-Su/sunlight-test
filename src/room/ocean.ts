// 窓の外の海の波を FFT で作る（Tessendorf「Simulating Ocean Water」2001）。
// 海の波の統計（波のスペクトル。風速から、どの長さ・向きの波がどれくらいの大きさで出るか）から、数万本の波の重なった海面を
// 毎フレーム GPU で作り、高さと傾きの画像（繰り返し模様）にする。窓の外の海は、この画像を読むだけで描ける。
// 大きさの違う 2 枚（160m 四方と 17m 四方）を重ねて、うねりから細かいさざ波までを出す。WebGPU のときだけ使う（WebGL2 は正弦波の海のまま）
import { angularFrequency } from './water.ts';

/** 1 枚の画像の大きさ（画素）。FFT は 2 の累乗の大きさで行う */
export const OCEAN_N = 256;
/** 2 枚の海面の 1 辺（m）と、それぞれが受け持つ波数の範囲（1/m）。大きい方は長い波、小さい方は短い波だけを持つ（重ねても二重にならない） */
export const OCEAN_CASCADES = [
  { sizeM: 160, kMin: 0, kMax: 2.5 },
  { sizeM: 17, kMin: 2.5, kMax: 30 },
] as const;
/** ミップマップの段の数（256 → 1） */
export const OCEAN_LODS = Math.log2(OCEAN_N) + 1;
/** 海面が繰り返す周期（秒）。波の角振動数をこの周期の倍数にそろえて、時間を巻き戻しても途切れないようにする */
export const OCEAN_PERIOD_S = 200;

const G = 9.81;

export interface OceanParams {
  /** 海面の上の風速（m/s） */
  windMS: number;
  /** 風下の向き（部屋の座標の x・z） */
  dirX: number;
  dirZ: number;
  /** 波の高さの倍率（1 で、その風速で十分に発達した海の高さ） */
  heightScale: number;
}

export interface OceanSpectrum {
  /** 2 枚ぶん、画素ごとに (h0(k) の実部・虚部, conj(h0(−k)) の実部・虚部) */
  h0: Float32Array;
  /** 2 枚ぶん、画素ごとの角振動数（周期 OCEAN_PERIOD_S の倍数にそろえた値） */
  omega: Float32Array;
  /** 2 枚ぶん、ミップマップの段ごとの「描ききれない波の傾きの 2 乗平均」（段 lod の画像では、その段より細かい波が平均されて消える） */
  unresolvedMss: Float32Array;
  /** 海面の高さの標準偏差（m） */
  rmsHeight: number;
}

// 決まった並びの乱数（毎回同じ海になるように）
function gaussian(seed: number): () => number {
  let s = seed >>> 0;
  const u = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** 画素の番号 i（0〜N−1）の波数の成分。N/2 以上は負の波数（FFT の並び） */
const waveIndex = (i: number): number => (i < OCEAN_N / 2 ? i : i - OCEAN_N);

/**
 * 波のスペクトル（Phillips スペクトル）から、各画素の波の初めの振幅 h0(k) を作る。
 * P(k) ∝ exp(−1/(k·Lw)²) / k⁴ · (k̂·ŵ)²（Lw = 風速² / g。風下の向きの波ほど大きく、風上へ向かう波は 0.07 倍に弱める）。
 * 全体の大きさは、十分に発達した海の有義波高 Hs ≈ 0.21 × 風速² / g（Pierson–Moskowitz）に合わせる（高さの標準偏差 = Hs / 4）
 */
export function buildOceanSpectrum(p: OceanParams): OceanSpectrum {
  const N = OCEAN_N;
  const n2 = N * N;
  const h0 = new Float32Array(OCEAN_CASCADES.length * n2 * 4);
  const omega = new Float32Array(OCEAN_CASCADES.length * n2);
  const V = Math.max(0.5, p.windMS);
  const Lw = (V * V) / G;
  const wl = Math.hypot(p.dirX, p.dirZ) || 1;
  const wx = p.dirX / wl;
  const wz = p.dirZ / wl;
  const w0 = (2 * Math.PI) / OCEAN_PERIOD_S;
  const rnd = gaussian(4242);

  // まず向きと形だけのスペクトルで振幅を作り（係数 1）、あとで全体の高さを合わせる
  const amp = new Float32Array(OCEAN_CASCADES.length * n2 * 2); // 画素ごとの h0(k) の実部・虚部
  const kAbs = new Float32Array(OCEAN_CASCADES.length * n2);
  OCEAN_CASCADES.forEach((c, ci) => {
    const dk = (2 * Math.PI) / c.sizeM;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = ci * n2 + y * N + x;
        const kx = waveIndex(x) * dk;
        const kz = waveIndex(y) * dk;
        const k = Math.hypot(kx, kz);
        kAbs[i] = k;
        const xr = rnd();
        const xi = rnd();
        if (k <= c.kMin || k > c.kMax || k < 1e-6) continue;
        const cosW = (kx * wx + kz * wz) / k;
        const dirF = cosW * cosW * (cosW < 0 ? 0.07 : 1);
        const P = (Math.exp(-1 / (k * Lw) ** 2) / k ** 4) * dirF;
        const a = Math.sqrt(P / 2) * dk;
        amp[i * 2] = xr * a;
        amp[i * 2 + 1] = xi * a;
        omega[i] = Math.floor(angularFrequency(k) / w0) * w0;
      }
    }
  });

  // 高さの分散 = Σ (|h0(k)|² + |h0(−k)|²)。目標の分散に合わせて全体を拡大・縮小する
  const at = (ci: number, x: number, y: number): number => ci * n2 + y * N + x;
  let variance = 0;
  for (let i = 0; i < amp.length / 2; i++) variance += 2 * (amp[i * 2]! ** 2 + amp[i * 2 + 1]! ** 2);
  const hs = (0.21 * V * V) / G * Math.max(0, p.heightScale);
  const target = (hs / 4) ** 2;
  const scale = variance > 0 ? Math.sqrt(target / variance) : 0;

  const unresolvedMss = new Float32Array(OCEAN_CASCADES.length * OCEAN_LODS);
  OCEAN_CASCADES.forEach((c, ci) => {
    const dx = c.sizeM / N;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = at(ci, x, y);
        const m = at(ci, (N - x) % N, (N - y) % N); // −k の画素
        const re = amp[i * 2]! * scale;
        const im = amp[i * 2 + 1]! * scale;
        const mre = amp[m * 2]! * scale;
        const mim = amp[m * 2 + 1]! * scale;
        h0.set([re, im, mre, -mim], i * 4);
        // この波の傾きの 2 乗平均を、描ききれなくなる段から先に足す（段 lod では 2^lod 画素が平均され、波長がその 2 倍より短い波が消える）
        const k = kAbs[i]!;
        if (k < 1e-6) continue;
        const mss = k * k * (re * re + im * im + mre * mre + mim * mim);
        for (let lod = 0; lod < OCEAN_LODS; lod++) {
          if (k > Math.PI / (dx * 2 ** lod)) unresolvedMss[ci * OCEAN_LODS + lod]! += mss;
        }
      }
    }
  });
  return { h0, omega, unresolvedMss, rmsHeight: Math.sqrt(target) };
}

// ---- GPU：スペクトル → 逆 FFT（行・列）→ 高さと傾きの画像 ----

const COMMON = /* wgsl */ `
const N = ${OCEAN_N}u;
const PI = 3.14159265;
struct Params { time: f32, size0: f32, size1: f32, pad: f32 }
@group(0) @binding(0) var<uniform> P: Params;
// 2 つの複素数をまとめた値（xy = 高さ＋i·x 向きの傾き、zw = z 向きの傾き）。2 枚ぶん（N × N × 2）
@group(0) @binding(1) var<storage, read_write> work: array<vec4f>;
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

// 時刻 t の波：h(k,t) = h0(k)·e^{iωt} + conj(h0(−k))·e^{−iωt}。x・z 向きの傾きは i·kx·h、i·kz·h。
// 高さと x の傾きを 1 つの複素数（h + i·sx）にまとめる（どちらも逆変換すると実数になるので、実部と虚部に分かれて出てくる）
const SPECTRUM = /* wgsl */ `${COMMON}
@group(0) @binding(2) var<storage, read> h0: array<vec4f>;
@group(0) @binding(3) var<storage, read> omega: array<f32>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= N || g.y >= N) { return; }
  let i = g.z * N * N + g.y * N + g.x;
  let size = select(P.size0, P.size1, g.z == 1u);
  let ix = select(f32(g.x), f32(g.x) - f32(N), g.x >= N / 2u);
  let iz = select(f32(g.y), f32(g.y) - f32(N), g.y >= N / 2u);
  let k = vec2f(ix, iz) * (2.0 * PI / size);
  let a = h0[i];
  let ph = omega[i] * P.time;
  let e = vec2f(cos(ph), sin(ph));
  let h = cmul(a.xy, e) + cmul(a.zw, vec2f(e.x, -e.y));
  let ih = vec2f(-h.y, h.x);
  let sx = ih * k.x;
  let sz = ih * k.y;
  work[i] = vec4f(h + vec2f(-sx.y, sx.x), sz);
}
`;

// 逆 FFT（1 行か 1 列を 1 つのワークグループで。共有メモリの中で基数 2 の段を 8 回）。dir = 0 で行、1 で列
const FFT = (dir: 0 | 1): string => /* wgsl */ `${COMMON}
var<workgroup> buf: array<array<vec4f, ${OCEAN_N}>, 2>;
fn rev(i: u32) -> u32 { return reverseBits(i) >> ${32 - Math.log2(OCEAN_N)}u; }
fn at(line: u32, j: u32, layer: u32) -> u32 {
  return layer * N * N + ${dir === 0 ? 'line * N + j' : 'j * N + line'};
}
@compute @workgroup_size(${OCEAN_N})
fn main(@builtin(local_invocation_id) l: vec3u, @builtin(workgroup_id) w: vec3u) {
  let j = l.x;
  buf[0][rev(j)] = work[at(w.x, j, w.y)];
  workgroupBarrier();
  var src = 0u;
  for (var half = 1u; half < N; half = half * 2u) {
    let pos = j % (2u * half);
    let base = j - pos;
    let q = pos % half;
    let a = buf[src][base + q];
    let b = buf[src][base + q + half];
    let ang = PI * f32(q) / f32(half);
    let tw = vec2f(cos(ang), sin(ang));
    let tb = vec4f(cmul(tw, b.xy), cmul(tw, b.zw));
    buf[1u - src][j] = select(a - tb, a + tb, pos < half);
    workgroupBarrier();
    src = 1u - src;
  }
  work[at(w.x, j, w.y)] = buf[src][j];
}
`;

// 画像に書く：(高さ, x の傾き, z の傾き)
const FINALIZE = /* wgsl */ `${COMMON}
@group(0) @binding(2) var out0: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var out1: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= N || g.y >= N) { return; }
  let a = work[g.y * N + g.x];
  let b = work[N * N + g.y * N + g.x];
  textureStore(out0, vec2u(g.x, g.y), vec4f(a.x, a.y, a.z, 1.0));
  textureStore(out1, vec2u(g.x, g.y), vec4f(b.x, b.y, b.z, 1.0));
}
`;

// ミップマップの 1 段：前の段の 2×2 画素の平均（傾きは平均してよい量なので、そのまま平均する）
const MIP = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let size = textureDimensions(dst);
  if (g.x >= size.x || g.y >= size.y) { return; }
  let p = vec2i(g.xy) * 2;
  let s = textureLoad(src, p, 0) + textureLoad(src, p + vec2i(1, 0), 0) + textureLoad(src, p + vec2i(0, 1), 0) + textureLoad(src, p + vec2i(1, 1), 0);
  textureStore(dst, g.xy, s * 0.25);
}
`;

/** WebGPU で海面の画像を作る。画像は 2 枚（大きい海面・小さい海面）で、ミップマップ付き */
export class GpuOcean {
  readonly textures: [GPUTexture, GPUTexture];
  private readonly device: GPUDevice;
  private readonly params: GPUBuffer;
  private readonly h0: GPUBuffer;
  private readonly omega: GPUBuffer;
  private readonly spectrum: { pipeline: GPUComputePipeline; bind: GPUBindGroup };
  private readonly rows: { pipeline: GPUComputePipeline; bind: GPUBindGroup };
  private readonly cols: { pipeline: GPUComputePipeline; bind: GPUBindGroup };
  private readonly finalize: { pipeline: GPUComputePipeline; bind: GPUBindGroup };
  private readonly mip: { pipeline: GPUComputePipeline; binds: { bind: GPUBindGroup; size: number }[] };

  constructor(device: GPUDevice) {
    this.device = device;
    const n2 = OCEAN_N * OCEAN_N * OCEAN_CASCADES.length;
    this.params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ocean-params' });
    this.h0 = device.createBuffer({ size: n2 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'ocean-h0' });
    this.omega = device.createBuffer({ size: n2 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'ocean-omega' });
    const work = device.createBuffer({ size: n2 * 16, usage: GPUBufferUsage.STORAGE, label: 'ocean-work' });
    const tex = (i: number): GPUTexture => device.createTexture({
      size: [OCEAN_N, OCEAN_N], format: 'rgba16float', mipLevelCount: OCEAN_LODS,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, label: `ocean-${i}`,
    });
    this.textures = [tex(0), tex(1)];
    // layout: 'auto' では、シェーダーが使わない結び付け（時刻など）は省かれるので、使うものだけを渡す
    const make = (code: string, label: string, extra: GPUBindGroupEntry[], usesParams = false) => {
      const pipeline = device.createComputePipeline({ label, layout: 'auto', compute: { module: device.createShaderModule({ code, label }), entryPoint: 'main' } });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [...(usesParams ? [{ binding: 0, resource: { buffer: this.params } }] : []), { binding: 1, resource: { buffer: work } }, ...extra],
      });
      return { pipeline, bind };
    };
    this.spectrum = make(SPECTRUM, 'ocean-spectrum', [{ binding: 2, resource: { buffer: this.h0 } }, { binding: 3, resource: { buffer: this.omega } }], true);
    this.rows = make(FFT(0), 'ocean-fft-rows', []);
    this.cols = make(FFT(1), 'ocean-fft-cols', []);
    this.finalize = make(FINALIZE, 'ocean-finalize', [
      { binding: 2, resource: this.textures[0].createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
      { binding: 3, resource: this.textures[1].createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
    ]);
    // ミップマップは描画のパスで 1 段ずつ作ると、段の数だけパスが増えて重い（2 枚 × 8 段で約 2ms）。計算のパスの中で作る
    const mipPipeline = device.createComputePipeline({ label: 'ocean-mip', layout: 'auto', compute: { module: device.createShaderModule({ code: MIP, label: 'ocean-mip' }), entryPoint: 'main' } });
    const binds: { bind: GPUBindGroup; size: number }[] = [];
    for (let level = 1; level < OCEAN_LODS; level++) {
      for (const t of this.textures) {
        binds.push({
          size: OCEAN_N >> level,
          bind: device.createBindGroup({
            layout: mipPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: t.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
              { binding: 1, resource: t.createView({ baseMipLevel: level, mipLevelCount: 1 }) },
            ],
          }),
        });
      }
    }
    this.mip = { pipeline: mipPipeline, binds };
  }

  /** 風速などを変えたときに、波の初めの振幅と角振動数を送り直す */
  upload(s: OceanSpectrum): void {
    this.device.queue.writeBuffer(this.h0, 0, s.h0);
    this.device.queue.writeBuffer(this.omega, 0, s.omega);
  }

  /** 時刻 timeS（秒）の海面を作り、縮小した段（ミップマップ）も作る */
  run(encoder: GPUCommandEncoder, timeS: number): void {
    const t = ((timeS % OCEAN_PERIOD_S) + OCEAN_PERIOD_S) % OCEAN_PERIOD_S;
    this.device.queue.writeBuffer(this.params, 0, new Float32Array([t, OCEAN_CASCADES[0].sizeM, OCEAN_CASCADES[1].sizeM, 0]));
    const pass = encoder.beginComputePass({ label: 'ocean' });
    const groups = OCEAN_N / 16;
    pass.setPipeline(this.spectrum.pipeline);
    pass.setBindGroup(0, this.spectrum.bind);
    pass.dispatchWorkgroups(groups, groups, OCEAN_CASCADES.length);
    pass.setPipeline(this.rows.pipeline);
    pass.setBindGroup(0, this.rows.bind);
    pass.dispatchWorkgroups(OCEAN_N, OCEAN_CASCADES.length);
    pass.setPipeline(this.cols.pipeline);
    pass.setBindGroup(0, this.cols.bind);
    pass.dispatchWorkgroups(OCEAN_N, OCEAN_CASCADES.length);
    pass.setPipeline(this.finalize.pipeline);
    pass.setBindGroup(0, this.finalize.bind);
    pass.dispatchWorkgroups(groups, groups);
    pass.setPipeline(this.mip.pipeline);
    for (const m of this.mip.binds) {
      pass.setBindGroup(0, m.bind);
      pass.dispatchWorkgroups(Math.ceil(m.size / 8), Math.ceil(m.size / 8));
    }
    pass.end();
  }
}
