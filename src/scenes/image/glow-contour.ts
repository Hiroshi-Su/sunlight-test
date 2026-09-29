// 光のにじみと等高線：明るい所から光があふれて伸び（散乱）、ぼかした明るさの分布を地形図のように色分けする
import * as THREE from 'three';
import { wrap } from '../shader.ts';
import { bool, num } from '../types.ts';
import { imageScene } from './source.ts';

const glsl = /* glsl */ `
uniform float uSmear, uSmearMix, uGlow, uThreshold, uLevels, uContour, uLineWidth, uContourBlur, uRegion, uWobble;
uniform vec2 uSmearDir, uFlow;

// 等高線の色（紺 → 青 → 緑 → 黄 → 赤）
vec3 topoColor(float x) {
  vec3 c = vec3(0.05, 0.10, 0.45);
  c = mix(c, vec3(0.10, 0.45, 0.90), smoothstep(0.0, 0.2, x));
  c = mix(c, vec3(0.10, 0.75, 0.35), smoothstep(0.2, 0.45, x));
  c = mix(c, vec3(0.95, 0.85, 0.20), smoothstep(0.45, 0.7, x));
  return mix(c, vec3(0.90, 0.20, 0.20), smoothstep(0.7, 0.95, x));
}

vec3 effect(vec2 uv, vec2 p) {
  float aspect = uRes.x / uRes.y;

  // 光のにじみ：伸ばす向きに沿って、ぼかしながら重ねる
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int i = 0; i < 12; i++) {
    float t = float(i) / 11.0;
    float w = 1.0 - t * 0.7;
    acc += imgLod(uv - uSmearDir * t * uSmear * vec2(1.0 / aspect, 1.0), 2.0 + t * 3.0) * w;
    ws += w;
  }
  vec3 smear = acc / ws;
  vec3 col = mix(img(uv), smear, uSmearMix);
  col += max(smear - uThreshold, 0.0) * uGlow * 2.0 * mix(vec3(1.0), uLightColor, 0.5);

  // 等高線：ぼかした明るさを高さに見立てて、段ごとに色分けし線を引く
  vec2 q = vec2(uv.x * aspect, uv.y);
  float L = luma(imgLod(uv, uContourBlur)) + (fbm(q * 3.0 + uFlow) - 0.5) * uWobble;
  float band = L * uLevels;
  float fb = fract(band);
  float line = 1.0 - smoothstep(0.0, fwidth(band) * 1.5 * uLineWidth, min(fb, 1.0 - fb));
  vec3 topo = mix(topoColor(floor(band) / uLevels), vec3(0.9, 0.2, 0.2), line);
  // 暗い所（明るさがしきい値より低い所）だけを地形図にする
  float region = 1.0 - smoothstep(uRegion - 0.04, uRegion + 0.04, L);
  return mix(col, topo, uContour * region);
}
`;

export const glowContour = imageScene({
  id: 'img-glow-contour',
  label: '画像：光のにじみと等高線',
  sunLinks: [{ toggle: 'followLight', uses: ['direction'] }, { uses: ['color'] }],
  glsl,
  params: {
    smear: { type: 'number', label: 'にじみの長さ', value: 0.35, min: 0, max: 1.5, step: 0.01 },
    smearMix: { type: 'number', label: 'にじみの混ざり', value: 0.7, min: 0, max: 1, step: 0.01 },
    followLight: { type: 'boolean', label: '光の向きににじむ（オフで下へ）', value: false },
    glow: { type: 'number', label: '光のあふれ', value: 0.6, min: 0, max: 2, step: 0.01 },
    threshold: { type: 'number', label: 'あふれる明るさ', value: 0.55, min: 0, max: 1, step: 0.01 },
    contour: { type: 'number', label: '等高線の強さ', value: 0.9, min: 0, max: 1, step: 0.01 },
    region: { type: 'number', label: '等高線にする暗さ', value: 0.35, min: 0, max: 1, step: 0.01 },
    levels: { type: 'number', label: '等高線の段数', value: 10, min: 2, max: 40, step: 1 },
    lineWidth: { type: 'number', label: '線の太さ', value: 1.5, min: 0.3, max: 6, step: 0.1 },
    contourBlur: { type: 'number', label: '地形のなめらかさ', value: 5, min: 0, max: 9, step: 0.1 },
    wobble: { type: 'number', label: '等高線の揺らぎ', value: 0.06, min: 0, max: 0.3, step: 0.005 },
    flow: { type: 'number', label: '揺らぎの速さ', value: 0.5, min: 0, max: 3, step: 0.05 },
  },
  uniforms: () => ({
    uSmear: { value: 0.35 },
    uSmearMix: { value: 0.7 },
    uGlow: { value: 0.6 },
    uThreshold: { value: 0.55 },
    uLevels: { value: 10 },
    uContour: { value: 0.9 },
    uLineWidth: { value: 1.5 },
    uContourBlur: { value: 5 },
    uRegion: { value: 0.35 },
    uWobble: { value: 0.06 },
    uSmearDir: { value: new THREE.Vector2(0, -1) },
    uFlow: { value: new THREE.Vector2() },
  }),
  update(u, input, params) {
    const flow = num(params, 'flow');
    u.uSmear.value = num(params, 'smear');
    u.uSmearMix.value = num(params, 'smearMix');
    u.uGlow.value = num(params, 'glow');
    u.uThreshold.value = num(params, 'threshold');
    u.uLevels.value = num(params, 'levels');
    u.uContour.value = num(params, 'contour');
    u.uLineWidth.value = num(params, 'lineWidth');
    u.uContourBlur.value = num(params, 'contourBlur');
    u.uRegion.value = num(params, 'region');
    u.uWobble.value = num(params, 'wobble');
    // uSmearDir はにじみが伸びる向き。シェーダーはその上流をたどって色を集める
    if (bool(params, 'followLight')) u.uSmearDir.value.set(input.light.dirX, input.light.dirY);
    else u.uSmearDir.value.set(0, -1);
    u.uFlow.value.set(wrap(input.time * 0.01 * flow), wrap(input.time * 0.007 * flow));
  },
});
