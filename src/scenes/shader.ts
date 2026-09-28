// 全画面シェーダー 1 枚で描くシーン用の共通部品
import * as THREE from 'three';

/** 格子を NOISE_PERIOD で繰り返すタイル化ノイズ。流す量を wrap() で巻き戻しても継ぎ目が出ない */
export const NOISE_PERIOD = 256;

export const GLSL_NOISE = /* glsl */ `
const float NOISE_PERIOD = ${NOISE_PERIOD.toFixed(1)};
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float hashTiled(vec2 i) { return hash(mod(i, NOISE_PERIOD)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashTiled(i), hashTiled(i + vec2(1, 0)), u.x), mix(hashTiled(i + vec2(0, 1)), hashTiled(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; } return v; }
`;

/** 長時間稼働で GPU の float 精度が落ちないよう、流す量を周期内に巻き戻す（CPU 側の倍精度で計算） */
export const wrap = (value: number, period = NOISE_PERIOD): number => ((value % period) + period) % period;

const VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export function fullscreenShader<U extends Record<string, THREE.IUniform>>(fragmentShader: string, uniforms: U) {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms });
  scene.add(new THREE.Mesh(geometry, material));
  return {
    scene,
    camera,
    uniforms,
    dispose(): void { geometry.dispose(); material.dispose(); },
  };
}

export const hexToVec3 = (hex: string): THREE.Vector3 => {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
};
