// 陽炎：日差しで温まった地面付近の空気が揺らぎ、景色が下から揺れる。地面すれすれには空が映る（逃げ水）
import * as THREE from 'three';
import { wrap } from '../shader.ts';
import { bool, num } from '../types.ts';
import { imageScene } from './source.ts';

const glsl = /* glsl */ `
uniform float uStrength, uGround, uHeight, uScale, uMirage, uSun;
uniform vec2 uRise;

vec3 effect(vec2 uv, vec2 p) {
  float aspect = uRes.x / uRes.y;
  vec2 q = vec2(uv.x * aspect, uv.y);

  // 地面付近ほど強く、上へ行くほど弱まる。地面より下（手前）も少し揺れる
  float above = uv.y - uGround;
  float prof = exp(-max(above, 0.0) / uHeight) * smoothstep(-0.25, 0.0, above);
  float amp = uStrength * prof * uSun;

  // 温まった空気の塊が上へのぼる（縦長の揺らぎ）
  vec2 nq = q * vec2(uScale * 1.6, uScale) + uRise;
  vec2 w = vec2(fbm(nq), fbm(nq + 5.2)) - 0.5;
  vec2 duv = w * amp * vec2(0.05 / aspect, 0.04);
  vec3 col = img(uv + duv);

  // 逃げ水：地面すれすれで光が曲がり、上の景色が逆さに映り込む
  if (above < 0.0 && above > -0.08) {
    float k = uMirage * (1.0 - smoothstep(0.0, 0.08, -above)) * uSun;
    col = mix(col, img(vec2(uv.x, uGround - above * 1.5) + duv * 2.0), clamp(k * 0.7, 0.0, 1.0));
  }
  return col;
}
`;

export const heatHaze = imageScene({
  id: 'img-heat-haze',
  label: '画像：陽炎',
  glsl,
  params: {
    strength: { type: 'number', label: '揺らぎの強さ', value: 1.2, min: 0, max: 5, step: 0.05 },
    ground: { type: 'number', label: '地面の高さ', value: 0.28, min: 0, max: 1, step: 0.005 },
    height: { type: 'number', label: '揺らぐ高さ', value: 0.12, min: 0.01, max: 0.6, step: 0.005 },
    scale: { type: 'number', label: '揺らぎの細かさ', value: 14, min: 2, max: 60, step: 0.5 },
    rise: { type: 'number', label: 'のぼる速さ', value: 1, min: 0, max: 5, step: 0.05 },
    mirage: { type: 'number', label: '逃げ水', value: 0.6, min: 0, max: 1, step: 0.01 },
    sunLinked: { type: 'boolean', label: '日差しと太陽高度に連動', value: true },
  },
  uniforms: () => ({
    uStrength: { value: 1.2 },
    uGround: { value: 0.28 },
    uHeight: { value: 0.12 },
    uScale: { value: 14 },
    uMirage: { value: 0.6 },
    uSun: { value: 1 },
    uRise: { value: new THREE.Vector2() },
  }),
  update(u, input, params) {
    u.uStrength.value = num(params, 'strength');
    u.uGround.value = num(params, 'ground');
    u.uHeight.value = num(params, 'height');
    u.uScale.value = num(params, 'scale');
    u.uMirage.value = num(params, 'mirage');
    // 太陽が高く、日差しが入るほど地面が温まって強く揺らぐ
    const sunHigh = Math.sqrt(Math.max(0, Math.sin((input.sun.altitude * Math.PI) / 180)));
    u.uSun.value = bool(params, 'sunLinked') ? 0.25 + 0.75 * sunHigh * (0.4 + 0.6 * input.lit) : 1;
    u.uRise.value.set(0, -wrap(input.time * 0.3 * num(params, 'rise')));
  },
});
