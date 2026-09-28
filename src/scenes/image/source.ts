// 画像を元にした効果の共通部品。効果は「画像を受け取って画像を返す」GLSL 関数 effect() として書き、
// 後で複数の効果を重ねるときは tImage を前の効果の出力に差し替えるだけで済むようにしておく。
import * as THREE from 'three';
import type { ParamValues } from '../../config.ts';
import { GLSL_NOISE, fullscreenShader } from '../shader.ts';
import { type ParamSpec, type SceneDef, type SceneInput, num } from '../types.ts';

// Vite がビルド時にアセットとして同梱する（オフラインで動く）
const SOURCE_URL = new URL('../../img/sea.jpg', import.meta.url).href;

/** 時間で繰り返す動きの周期（秒）。周期内の整数回で繰り返せば、巻き戻しても継ぎ目が出ない */
export const TIME_PERIOD = 1200;

let cached: THREE.Texture | null = null;
function sourceTexture(): THREE.Texture {
  if (cached) return cached;
  const tex = new THREE.TextureLoader().load(SOURCE_URL);
  // ゆがませた結果が画像の外にはみ出しても、端で折り返して自然につながるようにする
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
  // シェーダーは sRGB の値のまま扱う（色空間の変換をしない）
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  cached = tex;
  return tex;
}

const HEADER = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform sampler2D tImage;
uniform vec4 uCover;        // 画面の uv → 画像の uv（xy = 拡大, zw = ずらし）
uniform vec2 uDir;          // 画面内の光の進む向き
uniform float uLit, uAlt;   // 窓から光が入る度合い、太陽高度（度）
uniform vec3 uLightColor;
uniform float uT;           // TIME_PERIOD 内の時間（秒）
${GLSL_NOISE}
vec2 coverUv(vec2 uv) { return uv * uCover.xy + uCover.zw; }
vec3 img(vec2 uv) { return texture2D(tImage, coverUv(uv)).rgb; }
// ミップマップを使った安いぼかし（lod を上げるほどぼける）
vec3 imgLod(vec2 uv, float lod) { return textureLod(tImage, coverUv(uv), lod).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

const MAIN = /* glsl */ `
void main() {
  vec2 p = gl_FragCoord.xy;
  gl_FragColor = vec4(effect(p / uRes, p), 1.0);
}
`;

type Uniforms = Record<string, THREE.IUniform>;

export interface ImageEffect<U extends Uniforms> {
  id: string;
  label: string;
  params: Record<string, ParamSpec>;
  /** vec3 effect(vec2 uv, vec2 p) を定義する GLSL。uv は 0..1、p はピクセル座標 */
  glsl: string;
  uniforms(): U;
  update(u: U, input: SceneInput, params: ParamValues): void;
}

const COMMON_PARAMS: Record<string, ParamSpec> = {
  imageY: { type: 'number', label: '画像の表示位置（下 0 〜 上 1）', value: 0.3, min: 0, max: 1, step: 0.01 },
  imageZoom: { type: 'number', label: '画像の拡大', value: 1, min: 1, max: 3, step: 0.01 },
};

export function imageScene<U extends Uniforms>(fx: ImageEffect<U>): SceneDef {
  return {
    id: fx.id,
    label: fx.label,
    params: { ...fx.params, ...COMMON_PARAMS },
    create({ width, height }) {
      const tex = sourceTexture();
      const common = {
        uRes: { value: new THREE.Vector2(width, height) },
        tImage: { value: tex },
        uCover: { value: new THREE.Vector4(1, 1, 0, 0) },
        uDir: { value: new THREE.Vector2(-1, -0.5) },
        uLit: { value: 0 },
        uAlt: { value: 0 },
        uLightColor: { value: new THREE.Vector3(1, 1, 1) },
        uT: { value: 0 },
      };
      const own = fx.uniforms();
      const s = fullscreenShader(HEADER + fx.glsl + MAIN, { ...common, ...own });
      return {
        scene: s.scene,
        camera: s.camera,
        update(input, params) {
          // 画像を画面いっぱいに切り出す（はみ出す方向だけ位置を選べる）
          const im = tex.image as { width?: number; height?: number } | undefined;
          const imgAspect = im?.width && im.height ? im.width / im.height : 4 / 3;
          const screenAspect = width / height;
          const zoom = Math.max(1, num(params, 'imageZoom'));
          let sx = 1 / zoom, sy = 1 / zoom;
          if (screenAspect > imgAspect) sy = imgAspect / screenAspect / zoom;
          else sx = screenAspect / imgAspect / zoom;
          const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
          common.uCover.value.set(sx, sy, clamp(0.5 - sx / 2, 0, 1 - sx), clamp(num(params, 'imageY') - sy / 2, 0, 1 - sy));

          common.uDir.value.set(input.light.dirX, input.light.dirY);
          common.uLit.value = input.lit;
          common.uAlt.value = input.sun.altitude;
          common.uLightColor.value.set(...input.lightColor);
          common.uT.value = input.time % TIME_PERIOD;
          fx.update(own, input, params);
        },
        // 画像のテクスチャはシーン間で共有しているので破棄しない
        dispose: s.dispose,
      };
    },
  };
}
