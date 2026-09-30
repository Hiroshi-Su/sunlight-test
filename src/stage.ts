// 描画の本体（WebGL2）。シーンを半精度の中間バッファに描き、最終パスで出力範囲の制限・外光シミュレーション・ディザをかける。
// WebGPU 版は src/gpu/stage.ts。どちらも StageLike の形で使える
import * as THREE from 'three';
import type { ParamValues } from './config.ts';
import { type GpuStats, GpuTimer } from './gpu-timer.ts';
import { glPass } from './scenes/shader.ts';
import type { SceneDef, SceneInput, SceneInstance } from './scenes/types.ts';

const FINAL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uRes;
uniform float uOutMin, uOutMax, uWash, uSeed;
uniform vec3 uWashColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 col = texture2D(tSrc, gl_FragCoord.xy / uRes).rgb;
  col = clamp(col, uOutMin, uOutMax);
  // 外光シミュレーション：投影像に外光が重なり、黒が浮いてコントラストと彩度が落ちる見え方
  col = mix(col, uWashColor, uWash);
  col += (hash(gl_FragCoord.xy + uSeed * 97.0) - 0.5) / 255.0;  // 8bit 出力のバンディング対策
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface FinalOptions {
  outMin: number;
  outMax: number;
  /** 0 で無効。visuals モードのプレビュー専用 */
  wash: number;
  washColor: readonly [number, number, number];
}

/** 描画の方式 */
export type Backend = 'webgl' | 'webgpu';

/** 描画の本体の形（WebGL2 版・WebGPU 版で共通） */
export interface StageLike {
  readonly backend: Backend;
  readonly sceneId: string | null;
  setScene(def: SceneDef): void;
  render(input: SceneInput, params: ParamValues, opts: FinalOptions): void;
  gpu(): GpuReport;
  /** 同じフレームを続けて描き、GPU の処理が終わるまで待って 1 フレームあたりの時間（ms）を測る */
  benchmark(input: SceneInput, params: ParamValues, opts: FinalOptions, frames?: number): Promise<number>;
  /** 直前に描いたフレームを PNG で保存する（描画直後の同じタスク内で呼ぶこと） */
  savePng(filename: string): void;
}

export interface GpuReport {
  supported: boolean;
  /** macOS（Apple の GPU）ではフレームの処理が重なって計測され、値が大きく出る */
  approximate: boolean;
  /** 映像（シーン）の描画 */
  scene: GpuStats | null;
  /** 最終処理（出力範囲の制限・外光シミュレーション・ディザ） */
  final: GpuStats | null;
}

export class Stage implements StageLike {
  readonly backend = 'webgl' as const;
  readonly width: number;
  readonly height: number;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly final;
  private readonly finalUniforms;
  private readonly timer: GpuTimer;
  private current: { def: SceneDef; instance: SceneInstance; gl: ReturnType<typeof glPass> } | null = null;
  private readonly approximate: boolean;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.width = width;
    this.height = height;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.timer = new GpuTimer(gl);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.approximate = /apple/i.test(gpuName);
    this.target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false });
    this.finalUniforms = {
      tSrc: { value: this.target.texture },
      uRes: { value: new THREE.Vector2(width, height) },
      uOutMin: { value: 0.05 },
      uOutMax: { value: 0.93 },
      uWash: { value: 0 },
      uWashColor: { value: new THREE.Vector3(0.9, 0.9, 0.88) },
      uSeed: { value: 0 },
    };
    this.final = glPass({ glsl: FINAL_FRAG, wgsl: '', uniforms: this.finalUniforms });
  }

  get sceneId(): string | null {
    return this.current?.def.id ?? null;
  }

  setScene(def: SceneDef): void {
    if (this.current?.def.id === def.id) return;
    this.current?.instance.dispose();
    this.current?.gl.dispose();
    const instance = def.create({ width: this.width, height: this.height });
    this.current = { def, instance, gl: glPass(instance.pass) };
  }

  render(input: SceneInput, params: ParamValues, opts: FinalOptions): void {
    if (!this.current) return;
    const { instance, gl } = this.current;
    instance.update(input, params);
    this.timer.poll();
    this.renderer.setRenderTarget(this.target);
    this.timer.begin('scene');
    this.renderer.render(gl.scene, gl.camera);
    this.timer.end();
    this.renderer.setRenderTarget(null);
    const u = this.finalUniforms;
    u.uOutMin.value = opts.outMin;
    u.uOutMax.value = opts.outMax;
    u.uWash.value = opts.wash;
    u.uWashColor.value.set(...opts.washColor);
    u.uSeed.value = Math.random();
    this.timer.begin('final');
    this.renderer.render(this.final.scene, this.final.camera);
    this.timer.end();
  }

  /** 直近約 120 フレームの GPU 時間（ms） */
  gpu(): GpuReport {
    return {
      supported: this.timer.supported,
      approximate: this.approximate,
      scene: this.timer.stats('scene'),
      final: this.timer.stats('final'),
    };
  }

  /**
   * 同じフレームを続けて描き、GPU の処理が終わるまで待って 1 フレームあたりの時間（ms）を測る。
   * 計測の遅れや重なりの影響を受けないので、どの環境でも実際の重さが分かる（その間は描画が止まる）
   */
  async benchmark(input: SceneInput, params: ParamValues, opts: FinalOptions, frames = 60): Promise<number> {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const sync = (): void => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.render(input, params, opts);
    sync();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) this.render(input, params, opts);
    sync();
    return (performance.now() - t0) / frames;
  }

  savePng(filename: string): void {
    saveCanvasPng(this.renderer.domElement, filename);
  }
}

/** キャンバスの今の内容を PNG で保存する */
export function saveCanvasPng(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}
