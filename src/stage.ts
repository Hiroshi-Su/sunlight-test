// 描画の本体。シーンを半精度の中間バッファに描き、最終パスで出力範囲の制限・外光シミュレーション・ディザをかける
import * as THREE from 'three';
import type { ParamValues } from './config.ts';
import { fullscreenShader } from './scenes/shader.ts';
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

export class Stage {
  readonly width: number;
  readonly height: number;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly final;
  private current: { def: SceneDef; instance: SceneInstance } | null = null;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.width = width;
    this.height = height;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false });
    this.final = fullscreenShader(FINAL_FRAG, {
      tSrc: { value: this.target.texture },
      uRes: { value: new THREE.Vector2(width, height) },
      uOutMin: { value: 0.05 },
      uOutMax: { value: 0.93 },
      uWash: { value: 0 },
      uWashColor: { value: new THREE.Vector3(0.9, 0.9, 0.88) },
      uSeed: { value: 0 },
    });
  }

  get sceneId(): string | null {
    return this.current?.def.id ?? null;
  }

  setScene(def: SceneDef): void {
    if (this.current?.def.id === def.id) return;
    this.current?.instance.dispose();
    this.current = { def, instance: def.create({ width: this.width, height: this.height }) };
  }

  render(input: SceneInput, params: ParamValues, opts: FinalOptions): void {
    if (!this.current) return;
    const { instance } = this.current;
    instance.update(input, params);
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(instance.scene, instance.camera);
    this.renderer.setRenderTarget(null);
    const u = this.final.uniforms;
    u.uOutMin.value = opts.outMin;
    u.uOutMax.value = opts.outMax;
    u.uWash.value = opts.wash;
    u.uWashColor.value.set(...opts.washColor);
    u.uSeed.value = Math.random();
    this.renderer.render(this.final.scene, this.final.camera);
  }

  /** 直前に描いたフレームを PNG で保存する（描画直後の同じタスク内で呼ぶこと） */
  savePng(filename: string): void {
    this.renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }
}
