// 水面：波立つ水面に景色が映り込み、縦に伸びた光の筋になる。オフにすると水越しに見た屈折の揺れ
import * as THREE from 'three';
import { hexToVec3, wrap } from '../shader.ts';
import { bool, color, num } from '../types.ts';
import { imageScene } from './source.ts';

const glsl = /* glsl */ `
uniform float uHorizon, uWind, uWaveScale, uStreak, uReflect, uDarken, uReflectMode;
uniform vec2 uFlow;
uniform vec3 uWaterColor;

vec3 effect(vec2 uv, vec2 p) {
  float aspect = uRes.x / uRes.y;

  if (uReflectMode < 0.5) {
    // 水越しに見る：水面の屈折で景色が揺れる
    vec2 q = vec2(uv.x * aspect, uv.y) * uWaveScale;
    vec2 w = vec2(fbm(q + uFlow), fbm(q * 1.3 + uFlow.yx + 4.0)) - 0.5;
    return img(uv + w * uWind * 0.04 * vec2(1.0 / aspect, 1.0));
  }

  if (uv.y >= uHorizon) return img(uv);

  // 水平線から手前へ行くほど、波は大きく粗く見える（遠近）
  float depth = uHorizon - uv.y;
  float persp = 1.0 / (depth * 6.0 + 0.08);
  vec2 wq = vec2(uv.x * aspect * persp * 2.0, persp * 6.0) * uWaveScale;
  float wx = fbm(wq + uFlow) - 0.5;
  float wy = fbm(wq * vec2(1.0, 2.0) + uFlow.yx + 7.0) - 0.5;
  float dd = pow(depth, 0.6) * 0.5;
  vec2 ruv = vec2(uv.x + wx * uWind * 0.3 * dd, uHorizon + depth * 0.9 + wy * uWind * 0.35 * dd);

  // 波の斜面ごとに少しずつ違う場所が映るので、映り込みは縦に伸びた筋になる
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float o = (float(i) / 9.0 - 0.3) * uStreak * depth;
    acc += imgLod(ruv + vec2(0.0, o), 1.0);
  }
  vec3 refl = acc / 10.0;

  // 水平線近く（斜めから見る所）ほど強く映る（フレネル）
  float fres = mix(0.35, 1.0, pow(1.0 - clamp(depth * 2.0, 0.0, 1.0), 3.0)) * uReflect;
  vec3 water = mix(uWaterColor, refl, fres);
  // 波の斜面の向きで空の明るい所・暗い所が映り、水面に明暗の縞ができる
  float slope = fbm(wq * vec2(1.0, 2.5) + uFlow * 1.3 + 3.0) - 0.5;
  water *= 1.0 + slope * uWind * 0.6 * smoothstep(0.0, 0.03, depth);
  return water * (1.0 - uDarken * clamp(depth * 2.0, 0.0, 1.0));
}
`;

// 上と同じもの（WebGPU 用）
const wgsl = /* wgsl */ `
fn effect(uv: vec2f, p: vec2f) -> vec3f {
  let aspect = u.uRes.x / u.uRes.y;
  if (u.uReflectMode < 0.5) {
    let q = vec2f(uv.x * aspect, uv.y) * u.uWaveScale;
    let w = vec2f(fbm(q + u.uFlow), fbm(q * 1.3 + u.uFlow.yx + 4.0)) - 0.5;
    return img(uv + w * u.uWind * 0.04 * vec2f(1.0 / aspect, 1.0));
  }
  if (uv.y >= u.uHorizon) { return img(uv); }
  let depth = u.uHorizon - uv.y;
  let persp = 1.0 / (depth * 6.0 + 0.08);
  let wq = vec2f(uv.x * aspect * persp * 2.0, persp * 6.0) * u.uWaveScale;
  let wx = fbm(wq + u.uFlow) - 0.5;
  let wy = fbm(wq * vec2f(1.0, 2.0) + u.uFlow.yx + 7.0) - 0.5;
  let dd = pow(depth, 0.6) * 0.5;
  let ruv = vec2f(uv.x + wx * u.uWind * 0.3 * dd, u.uHorizon + depth * 0.9 + wy * u.uWind * 0.35 * dd);
  var acc = vec3f(0.0);
  for (var i = 0; i < 10; i++) {
    let o = (f32(i) / 9.0 - 0.3) * u.uStreak * depth;
    acc += imgLod(ruv + vec2f(0.0, o), 1.0);
  }
  let refl = acc / 10.0;
  let fres = mix(0.35, 1.0, pow(1.0 - clamp(depth * 2.0, 0.0, 1.0), 3.0)) * u.uReflect;
  var water = mix(u.uWaterColor, refl, fres);
  let slope = fbm(wq * vec2f(1.0, 2.5) + u.uFlow * 1.3 + 3.0) - 0.5;
  water *= 1.0 + slope * u.uWind * 0.6 * smoothstep(0.0, 0.03, depth);
  return water * (1.0 - u.uDarken * clamp(depth * 2.0, 0.0, 1.0));
}
`;

export const water = imageScene({
  id: 'img-water',
  label: '画像：水面',
  glsl,
  wgsl,
  params: {
    reflectMode: { type: 'boolean', label: '映り込み（オフで水越しの屈折）', value: true },
    horizon: { type: 'number', label: '水平線の高さ', value: 0.3, min: 0.05, max: 0.95, step: 0.005 },
    wind: { type: 'number', label: '波の強さ（風）', value: 1.5, min: 0, max: 4, step: 0.05 },
    waveScale: { type: 'number', label: '波の細かさ', value: 1, min: 0.2, max: 4, step: 0.05 },
    flow: { type: 'number', label: '波の速さ', value: 1, min: 0, max: 5, step: 0.05 },
    streak: { type: 'number', label: '光の筋の長さ', value: 0.35, min: 0, max: 2, step: 0.01 },
    reflect: { type: 'number', label: '映り込みの強さ', value: 0.9, min: 0, max: 1, step: 0.01 },
    darken: { type: 'number', label: '手前の暗さ', value: 0.3, min: 0, max: 1, step: 0.01 },
    waterColor: { type: 'color', label: '水の色', value: '#34506a' },
  },
  uniforms: () => ({
    uHorizon: { value: 0.3 },
    uWind: { value: 1 },
    uWaveScale: { value: 1 },
    uStreak: { value: 0.6 },
    uReflect: { value: 0.9 },
    uDarken: { value: 0.3 },
    uReflectMode: { value: 1 },
    uFlow: { value: new THREE.Vector2() },
    uWaterColor: { value: new THREE.Vector3() },
  }),
  update(u, input, params) {
    const flow = num(params, 'flow');
    u.uHorizon.value = num(params, 'horizon');
    u.uWind.value = num(params, 'wind');
    u.uWaveScale.value = num(params, 'waveScale');
    u.uStreak.value = num(params, 'streak');
    u.uReflect.value = num(params, 'reflect');
    u.uDarken.value = num(params, 'darken');
    u.uReflectMode.value = bool(params, 'reflectMode') ? 1 : 0;
    u.uFlow.value.set(wrap(input.time * 0.05 * flow), wrap(input.time * 0.03 * flow));
    u.uWaterColor.value.copy(hexToVec3(color(params, 'waterColor')));
  },
});
