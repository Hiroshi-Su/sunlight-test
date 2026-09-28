// 分光：型板ガラス・リブガラス越しの屈折で、光が波長ごとにずれて虹色に分かれる（分散）。日差しの向きにも分かれる
import { num, bool } from '../types.ts';
import { wrap } from '../shader.ts';
import * as THREE from 'three';
import { imageScene } from './source.ts';

const glsl = /* glsl */ `
uniform float uStrength, uDispersion, uScale, uRibbed, uRibFreq, uSunBias;
uniform vec2 uFlow;

// 波長（x: 0 = 紫 〜 1 = 赤）ごとの RGB の重み（おおまかな等色関数）
vec3 spectrum(float x) {
  return clamp(vec3(
    smoothstep(0.45, 0.75, x) + 0.35 * (1.0 - smoothstep(0.0, 0.18, x)),
    1.0 - abs(x - 0.5) * 2.6,
    1.0 - smoothstep(0.25, 0.55, x)), 0.0, 1.0);
}

vec3 effect(vec2 uv, vec2 p) {
  float aspect = uRes.x / uRes.y;
  vec2 q = vec2(uv.x * aspect, uv.y);
  vec2 d = normalize(uDir);
  vec2 perp = vec2(-d.y, d.x);

  // ガラスの厚みの傾き：有機的なうねり（型板ガラス）と、光の向きに並ぶ縦溝（リブガラス）を混ぜる
  float e = 0.004;
  vec2 qa = q * uScale + uFlow;
  float h0 = fbm(qa);
  vec2 gOrg = vec2(fbm(qa + vec2(e * uScale, 0.0)) - h0, fbm(qa + vec2(0.0, e * uScale)) - h0) / e * 0.02;
  float r = fract(dot(q, perp) * uRibFreq) * 2.0 - 1.0;
  vec2 gRib = perp * (-r / sqrt(max(1.0 - r * r, 0.05))) * 0.02;
  vec2 g = mix(gOrg, gRib, uRibbed);

  // 屈折のずれ。日差しが入るときは光の向きにもずらす（プリズムに光が差す）
  vec2 D = g * uStrength + d * uSunBias * uLit * 0.012;

  // 波長ごとにずれ量を変えて重ねる（分散）。屈折率は波長が短いほど大きい（コーシーの式）ので、紫ほど大きくずらす。
  // 重みの合計で割るので白は白のまま
  vec3 acc = vec3(0.0), wsum = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    float x = float(i) / 8.0;
    vec3 w = spectrum(x);
    vec2 o = D * (1.0 + uDispersion * (0.5 - x) * 2.0);
    acc += img(uv + o * vec2(1.0 / aspect, 1.0)) * w;
    wsum += w;
  }
  return acc / wsum;
}
`;

export const prism = imageScene({
  id: 'img-prism',
  label: '画像：分光（プリズム）',
  glsl,
  params: {
    strength: { type: 'number', label: '屈折の強さ', value: 0.5, min: 0, max: 4, step: 0.05 },
    dispersion: { type: 'number', label: '色の分かれ方', value: 0.8, min: 0, max: 2, step: 0.05 },
    ribbed: { type: 'number', label: 'リブガラスの度合い', value: 0.2, min: 0, max: 1, step: 0.01 },
    ribFreq: { type: 'number', label: 'リブの本数', value: 14, min: 2, max: 60, step: 0.5 },
    scale: { type: 'number', label: 'うねりの大きさ', value: 3, min: 0.5, max: 12, step: 0.1 },
    flow: { type: 'number', label: 'うねりの動き', value: 0.5, min: 0, max: 3, step: 0.05 },
    sunBias: { type: 'number', label: '日差しでの分光', value: 1, min: 0, max: 3, step: 0.05 },
    sunLinked: { type: 'boolean', label: '日差しに連動', value: true },
  },
  uniforms: () => ({
    uStrength: { value: 1 },
    uDispersion: { value: 0.8 },
    uScale: { value: 3 },
    uRibbed: { value: 0.4 },
    uRibFreq: { value: 14 },
    uSunBias: { value: 1 },
    uFlow: { value: new THREE.Vector2() },
  }),
  update(u, input, params) {
    const flow = num(params, 'flow');
    u.uStrength.value = num(params, 'strength') * (bool(params, 'sunLinked') ? 0.5 + 0.5 * input.lit : 1);
    u.uDispersion.value = num(params, 'dispersion');
    u.uScale.value = num(params, 'scale');
    u.uRibbed.value = num(params, 'ribbed');
    u.uRibFreq.value = num(params, 'ribFreq');
    u.uSunBias.value = bool(params, 'sunLinked') ? num(params, 'sunBias') : 0;
    u.uFlow.value.set(wrap(input.time * 0.01 * flow), wrap(input.time * 0.006 * flow));
  },
});
