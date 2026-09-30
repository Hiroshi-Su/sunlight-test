// WebGPU の土台：装置の準備、全画面のシェーダーを描く仕組み、画像（テクスチャ）の読み込みとミップマップ、GPU 時間の計測
import * as THREE from 'three';
import { type FieldType, type Layout, buildLayout, writeLayout } from './layout.ts';

export interface Gpu {
  device: GPUDevice;
  /** 画面（canvas）に出すときの色の形式 */
  format: GPUTextureFormat;
  /** GPU の時間を計れるか（timestamp-query） */
  timestamps: boolean;
  /** GPU の製造元（apple・nvidia など） */
  vendor: string;
}

/** WebGPU を使えるようにする。使えない環境では null（WebGL2 で描く） */
export async function initWebGpu(): Promise<Gpu | null> {
  if (!('gpu' in navigator) || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const timestamps = adapter.features.has('timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });
    return { device, format: navigator.gpu.getPreferredCanvasFormat(), timestamps, vendor: adapter.info?.vendor ?? '' };
  } catch {
    return null;
  }
}

export function configureCanvas(gpu: Gpu, canvas: HTMLCanvasElement): GPUCanvasContext {
  const ctx = canvas.getContext('webgpu');
  if (!ctx) throw new Error('webgpu のキャンバスを作れません');
  ctx.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });
  return ctx;
}

/** 全画面を覆う三角形 1 枚の頂点（頂点のデータは使わず、番号から位置を作る） */
export const FULLSCREEN_VS = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(select(-1.0, 3.0, i == 1u), select(-1.0, 3.0, i == 2u));
  return vec4f(p, 0.0, 1.0);
}
`;

type Uniforms = Record<string, { value: unknown }>;

/**
 * 映像 1 枚ぶんの描き方。body は `fn frag(p: vec2f) -> vec3f` を定義する WGSL。
 * p は WebGL と同じ向きのピクセル座標（左下が原点、画素の中心は 0.5）で、値は `u.名前` で読める。
 * 画像の値（THREE.Texture）は `名前`（texture_2d）と `名前_s`（sampler）で読める
 */
export class FullscreenPipeline {
  private readonly gpu: Gpu;
  private readonly uniforms: Uniforms;
  private readonly layout: Layout;
  private readonly data: Float32Array;
  private readonly buffer: GPUBuffer;
  private readonly pipeline: GPURenderPipeline;
  private readonly textures: TextureCache;
  private bindGroup: GPUBindGroup | null = null;
  private boundKey = '';

  constructor(gpu: Gpu, body: string, uniforms: Uniforms, format: GPUTextureFormat, textures: TextureCache, label = 'fullscreen') {
    this.gpu = gpu;
    this.uniforms = uniforms;
    this.textures = textures;
    const extra: Record<string, FieldType> = { viewSize: 'vec2f' };
    this.layout = buildLayout(uniforms, 'Params', extra);
    this.data = new Float32Array(this.layout.size / 4);
    this.buffer = gpu.device.createBuffer({ size: this.layout.size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label });
    const texDecl = this.layout.textures.map((name, i) =>
      `@group(0) @binding(${1 + i * 2}) var ${name}: texture_2d<f32>;\n@group(0) @binding(${2 + i * 2}) var ${name}_s: sampler;`).join('\n');
    const code = `${this.layout.wgsl}
@group(0) @binding(0) var<storage, read> u: Params;
${texDecl}
${body}
${FULLSCREEN_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(frag(vec2f(pos.x, u.viewSize.y - pos.y)), 1.0);
}
`;
    const module = gpu.device.createShaderModule({ code, label });
    this.pipeline = gpu.device.createRenderPipeline({
      label,
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /** 今の値を書き込み、描く命令を積む */
  encode(encoder: GPUCommandEncoder, view: GPUTextureView, size: { width: number; height: number }, timestampWrites?: GPURenderPassTimestampWrites): void {
    writeLayout(this.layout, this.uniforms, this.data, { viewSize: [size.width, size.height] });
    this.gpu.device.queue.writeBuffer(this.buffer, 0, this.data);
    const bindGroup = this.currentBindGroup();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites,
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  // 画像が読み込み終わったら結び付け直す
  private currentBindGroup(): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: this.buffer } }];
    const keys: string[] = [];
    this.layout.textures.forEach((name, i) => {
      const t = this.textures.get(this.uniforms[name]!.value as THREE.Texture | null);
      entries.push({ binding: 1 + i * 2, resource: t.view }, { binding: 2 + i * 2, resource: t.sampler });
      keys.push(t.id);
    });
    const key = keys.join();
    if (!this.bindGroup || key !== this.boundKey) {
      this.bindGroup = this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries });
      this.boundKey = key;
    }
    return this.bindGroup;
  }

  dispose(): void {
    this.buffer.destroy();
  }
}

interface GpuTex {
  id: string;
  view: GPUTextureView;
  sampler: GPUSampler;
}

/**
 * three.js の画像（THREE.Texture）を WebGPU の画像にする。読み込み中は 1 画素の仮の画像を返す。
 * three.js（WebGL）と同じく上下を反転して載せる（flipY）ので、読む座標は WebGL と同じ（下が 0）。
 * 載せ方をそろえないと、ミップマップの段の大きさが奇数になるところで 2×2 の組み方がずれて、ぼかした画像がわずかにずれる
 */
export class TextureCache {
  private readonly gpu: Gpu;
  private readonly cache = new Map<THREE.Texture, GpuTex>();
  private readonly loading = new Set<THREE.Texture>();
  private readonly placeholder: GpuTex;
  private readonly mips: MipGenerator;
  private seq = 0;

  constructor(gpu: Gpu) {
    this.gpu = gpu;
    this.mips = new MipGenerator(gpu.device);
    const tex = gpu.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    gpu.device.queue.writeTexture({ texture: tex }, new Uint8Array([128, 128, 128, 255]), {}, [1, 1]);
    this.placeholder = { id: 'placeholder', view: tex.createView(), sampler: gpu.device.createSampler() };
  }

  get(t: THREE.Texture | null): GpuTex {
    if (!t) return this.placeholder;
    const hit = this.cache.get(t);
    if (hit) return hit;
    const img = t.image as HTMLImageElement | undefined;
    if (img && img.complete && img.naturalWidth > 0 && !this.loading.has(t)) {
      this.loading.add(t);
      void createImageBitmap(img).then((bmp) => {
        this.cache.set(t, this.upload(bmp, t));
        this.loading.delete(t);
      });
    }
    return this.placeholder;
  }

  private upload(bmp: ImageBitmap, t: THREE.Texture): GpuTex {
    const device = this.gpu.device;
    const levels = Math.floor(Math.log2(Math.max(bmp.width, bmp.height))) + 1;
    const tex = device.createTexture({
      size: [bmp.width, bmp.height],
      format: 'rgba8unorm',
      mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: bmp, flipY: t.flipY }, { texture: tex }, [bmp.width, bmp.height]);
    this.mips.generate(tex);
    const mode = (w: THREE.Wrapping): GPUAddressMode =>
      w === THREE.MirroredRepeatWrapping ? 'mirror-repeat' : w === THREE.RepeatWrapping ? 'repeat' : 'clamp-to-edge';
    const sampler = device.createSampler({
      addressModeU: mode(t.wrapS), addressModeV: mode(t.wrapT),
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      maxAnisotropy: Math.max(1, Math.min(16, t.anisotropy)),
    });
    return { id: `tex${this.seq++}`, view: tex.createView(), sampler };
  }
}

const caches = new WeakMap<GPUDevice, TextureCache>();
/** 装置ごとに 1 つの画像の置き場（映像を切り替えても、同じ画像を読み込み直さない） */
export function textureCache(gpu: Gpu): TextureCache {
  let c = caches.get(gpu.device);
  if (!c) caches.set(gpu.device, (c = new TextureCache(gpu)));
  return c;
}

/** ミップマップ（縮小した画像の段）を、1 段ずつ前の段を縮小して作る */
export class MipGenerator {
  private readonly device: GPUDevice;
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private readonly sampler: GPUSampler;

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  private pipeline(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.pipelines.get(format);
    if (p) return p;
    const module = this.device.createShaderModule({
      code: `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
${FULLSCREEN_VS}
// 次の段の画素の中心に当たる前の段の位置を、線形補間で読む。大きさが偶数なら 2×2 画素の平均と同じ。
// 奇数（189 → 94 など）では位置が少しずつずれていく。WebGL（Metal）の自動のミップマップと同じ作り方にそろえるため
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dst = floor(vec2f(textureDimensions(src)) * 0.5);
  return textureSampleLevel(src, smp, pos.xy / max(dst, vec2f(1.0)), 0.0);
}`,
    });
    p = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    });
    this.pipelines.set(format, p);
    return p;
  }

  generate(tex: GPUTexture, encoder?: GPUCommandEncoder): void {
    const pipeline = this.pipeline(tex.format);
    const enc = encoder ?? this.device.createCommandEncoder();
    for (let level = 1; level < tex.mipLevelCount; level++) {
      const bind = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: tex.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.sampler },
        ],
      });
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: tex.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    }
    if (!encoder) this.device.queue.submit([enc.finish()]);
  }
}

const WINDOW = 120;

/**
 * GPU が実際に描画にかけた時間を計る（timestamp-query）。区間ごとに始まりと終わりの時刻を書き込み、
 * 数フレーム後に読み出す（描画は止めない）。読み出し用のバッファが空いていないフレームは計らない
 */
export class GpuTimestamps {
  private readonly device: GPUDevice;
  private readonly labels: string[];
  private readonly querySet: GPUQuerySet;
  private readonly resolve: GPUBuffer;
  private readonly readBacks: { buf: GPUBuffer; busy: boolean }[];
  private current: { buf: GPUBuffer; busy: boolean } | null = null;
  private readonly samples = new Map<string, number[]>();

  constructor(device: GPUDevice, labels: string[]) {
    this.device = device;
    this.labels = labels;
    const count = labels.length * 2;
    this.querySet = device.createQuerySet({ type: 'timestamp', count });
    this.resolve = device.createBuffer({ size: count * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.readBacks = [0, 1, 2].map(() => ({ buf: device.createBuffer({ size: count * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), busy: false }));
  }

  /** このフレームで計るか決める（計らないときは undefined を返すので、描くときに渡さなければよい） */
  begin(): boolean {
    this.current = this.readBacks.find((r) => !r.busy) ?? null;
    return this.current !== null;
  }

  writes(label: string): GPURenderPassTimestampWrites | undefined {
    if (!this.current) return undefined;
    const i = this.labels.indexOf(label);
    return { querySet: this.querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }

  /** 描く命令を積み終えたあと、提出の前に呼ぶ */
  finish(encoder: GPUCommandEncoder): void {
    if (!this.current) return;
    encoder.resolveQuerySet(this.querySet, 0, this.labels.length * 2, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, this.current.buf, 0, this.labels.length * 16);
  }

  /** 提出のあとに呼ぶ。結果が届いたら記録する */
  collect(): void {
    const r = this.current;
    if (!r) return;
    this.current = null;
    r.busy = true;
    void r.buf.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigInt64Array(r.buf.getMappedRange().slice(0));
      r.buf.unmap();
      r.busy = false;
      this.labels.forEach((label, i) => {
        const ms = Number(t[i * 2 + 1]! - t[i * 2]!) / 1e6;
        if (!(ms > 0 && ms < 1000)) return;
        const arr = this.samples.get(label) ?? [];
        arr.push(ms);
        if (arr.length > WINDOW) arr.shift();
        this.samples.set(label, arr);
      });
    }).catch(() => { r.busy = false; });
  }

  stats(label: string): { avg: number; max: number } | null {
    const arr = this.samples.get(label);
    if (!arr?.length) return null;
    return { avg: arr.reduce((a, b) => a + b, 0) / arr.length, max: Math.max(...arr) };
  }
}
