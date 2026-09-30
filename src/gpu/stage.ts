// 描画の本体（WebGPU）。WebGL2 版（src/stage.ts）と同じく、シーンを半精度の中間バッファに描き、
// 最終パスで出力範囲の制限・外光シミュレーション・ディザをかける
import type { ParamValues } from '../config.ts';
import type { SceneDef, SceneInput, SceneInstance } from '../scenes/types.ts';
import { type FinalOptions, type GpuReport, type StageLike, saveCanvasPng } from '../stage.ts';
import { FULLSCREEN_VS, FullscreenPipeline, type Gpu, GpuTimestamps, configureCanvas, textureCache } from './webgpu.ts';

const INTERMEDIATE: GPUTextureFormat = 'rgba16float';

const FINAL_WGSL = /* wgsl */ `
struct Final {
  outMin: f32,
  outMax: f32,
  wash: f32,
  seed: f32,
  washColor: vec3f,
  height: f32,
}
@group(0) @binding(0) var<uniform> f: Final;
@group(0) @binding(1) var src: texture_2d<f32>;
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
${FULLSCREEN_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var col = textureLoad(src, vec2i(pos.xy), 0).rgb;
  col = clamp(col, vec3f(f.outMin), vec3f(f.outMax));
  // 外光シミュレーション：投影像に外光が重なり、黒が浮いてコントラストと彩度が落ちる見え方
  col = mix(col, f.washColor, f.wash);
  // 8bit 出力のバンディング対策（乱数の座標は WebGL と同じく下から数える）
  col += (hash(vec2f(pos.x, f.height - pos.y) + f.seed * 97.0) - 0.5) / 255.0;
  return vec4f(col, 1.0);
}
`;

export class GpuStage implements StageLike {
  readonly backend = 'webgpu' as const;
  readonly width: number;
  readonly height: number;
  private readonly webgpu: Gpu;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: GPUCanvasContext;
  private readonly target: GPUTexture;
  private readonly targetView: GPUTextureView;
  private readonly finalPipeline: GPURenderPipeline;
  private readonly finalBuffer: GPUBuffer;
  private readonly finalBind: GPUBindGroup;
  private readonly finalData = new Float32Array(8);
  private readonly timer: GpuTimestamps | null;
  private current: { def: SceneDef; instance: SceneInstance; pipeline: FullscreenPipeline } | null = null;

  constructor(canvas: HTMLCanvasElement, width: number, height: number, gpu: Gpu) {
    this.width = width;
    this.height = height;
    this.webgpu = gpu;
    this.canvas = canvas;
    canvas.width = width;
    canvas.height = height;
    this.ctx = configureCanvas(gpu, canvas);
    const device = gpu.device;
    this.target = device.createTexture({
      size: [width, height], format: INTERMEDIATE, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: 'stage-intermediate',
    });
    this.targetView = this.target.createView();
    const module = device.createShaderModule({ code: FINAL_WGSL, label: 'stage-final' });
    this.finalPipeline = device.createRenderPipeline({
      layout: 'auto', label: 'stage-final',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: gpu.format }] },
    });
    this.finalBuffer = device.createBuffer({ size: this.finalData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.finalBind = device.createBindGroup({
      layout: this.finalPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.finalBuffer } }, { binding: 1, resource: this.targetView }],
    });
    this.timer = gpu.timestamps ? new GpuTimestamps(device, ['scene', 'final']) : null;
  }

  get sceneId(): string | null {
    return this.current?.def.id ?? null;
  }

  setScene(def: SceneDef): void {
    if (this.current?.def.id === def.id) return;
    this.current?.instance.dispose();
    this.current?.pipeline.dispose();
    const instance = def.create({ width: this.width, height: this.height });
    const pipeline = new FullscreenPipeline(this.webgpu, instance.pass.wgsl, instance.pass.uniforms, INTERMEDIATE, textureCache(this.webgpu), def.id);
    this.current = { def, instance, pipeline };
  }

  render(input: SceneInput, params: ParamValues, opts: FinalOptions): void {
    if (!this.current) return;
    const { instance, pipeline } = this.current;
    instance.update(input, params);
    const device = this.webgpu.device;
    const timed = this.timer?.begin() ?? false;
    const encoder = device.createCommandEncoder();
    pipeline.encode(encoder, this.targetView, this, timed ? this.timer!.writes('scene') : undefined);

    this.finalData.set([opts.outMin, opts.outMax, opts.wash, Math.random(), ...opts.washColor, this.height]);
    device.queue.writeBuffer(this.finalBuffer, 0, this.finalData);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites: timed ? this.timer!.writes('final') : undefined,
    });
    pass.setPipeline(this.finalPipeline);
    pass.setBindGroup(0, this.finalBind);
    pass.draw(3);
    pass.end();
    if (timed) this.timer!.finish(encoder);
    device.queue.submit([encoder.finish()]);
    if (timed) this.timer!.collect();
  }

  gpu(): GpuReport {
    return {
      supported: this.timer !== null,
      // Apple の GPU は前後のフレームの処理を重ねて進めるので、区間ごとの時刻の差は大きく出る（WebGL と同じ）
      approximate: /apple/i.test(this.webgpu.vendor),
      scene: this.timer?.stats('scene') ?? null,
      final: this.timer?.stats('final') ?? null,
    };
  }

  async benchmark(input: SceneInput, params: ParamValues, opts: FinalOptions, frames = 60): Promise<number> {
    const queue = this.webgpu.device.queue;
    this.render(input, params, opts);
    await queue.onSubmittedWorkDone();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) this.render(input, params, opts);
    await queue.onSubmittedWorkDone();
    return (performance.now() - t0) / frames;
  }

  savePng(filename: string): void {
    saveCanvasPng(this.canvas, filename);
  }
}
