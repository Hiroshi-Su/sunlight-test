// 光の柱：ガラスの継ぎ目を思わせる縦の光の筋が加算的に輝き、背景には重なるカラーバンド。
// 柱は光の向きに関わらず固定の縦位置（実際の継ぎ目は動かないため）。日差しが入るほど輝きが増す。
import * as THREE from 'three';
import { GLSL_NOISE, fullscreenShader, hexToVec3, wrap } from './shader.ts';
import { type SceneDef, bool, color, num } from './types.ts';

const frag = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform vec2 uDrift;
uniform float uBands, uWobble;
uniform vec3 uC0, uC1, uC2, uC3;
uniform float uColumnSpacing, uColumnJitter, uColumnWidth, uColumnBase, uGlow, uChroma, uFlicker;
${GLSL_NOISE}

// 4 色を周期的に混ぜる（三角基底の重ね合わせ）。phase が 1 増えるごとに次の色へ
vec3 cyclicPalette(float phase, vec3 c0, vec3 c1, vec3 c2, vec3 c3) {
  vec3 cols[4];
  cols[0] = c0; cols[1] = c1; cols[2] = c2; cols[3] = c3;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = phase - float(i);
    d -= floor(d / 4.0 + 0.5) * 4.0;
    float w = max(0.0, 1.0 - abs(d));
    acc += cols[i] * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-4);
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 uv = p / uRes;
  float aspect = uRes.x / uRes.y;

  // 背景：うねる境界を持つカラーバンド
  float wob = (fbm(vec2(uv.x * aspect * 1.5 + uDrift.x, uv.y * 2.0 + uDrift.y)) - 0.5) * uWobble;
  float phase = (uv.y + wob) * uBands;
  vec3 col = cyclicPalette(phase, uC0, uC1, uC2, uC3);
  col *= 0.94 + 0.08 * fbm(uv * vec2(aspect, 1.0) * 3.0 + uDrift * 0.6);

  // 柱：継ぎ目を思わせる固定の縦位置。位置ごとに少しずらして不揃いにする
  float idx = floor(p.x / uColumnSpacing + 0.5);
  float jitter = (hash(vec2(idx, 11.0)) - 0.5) * uColumnJitter * uColumnSpacing;
  float d = p.x - (idx * uColumnSpacing + jitter);

  float ad = abs(d);
  // 芯：ごく細い、白く飛ぶ部分
  float coreW = uColumnWidth * 0.35;
  float core = 1.0 - smoothstep(0.0, coreW, ad);

  // 輪：芯のすぐ外側から立ち上がり、外側でなだらかに消える補色の帯。
  // 色の成分ごとに外径を変えて、輪の外縁に虹色のにじみを作る（分光と同じ考え方）
  float ringInner = uColumnWidth * 0.5;
  float ringOuterR = uColumnWidth * 2.6 * (1.0 + uChroma);
  float ringOuterG = uColumnWidth * 2.6;
  float ringOuterB = uColumnWidth * 2.6 * (1.0 - uChroma);
  vec3 ringOuter = vec3(ringOuterR, ringOuterG, ringOuterB);
  vec3 ringShape = smoothstep(0.0, ringInner, vec3(ad)) * (1.0 - smoothstep(vec3(ringInner), ringOuter, vec3(ad)));

  float shimmer = 1.0 + uFlicker * (noise(vec2(idx * 3.7, uDrift.y * 2.0)) - 0.5) * 2.0;
  float baseGlow = uColumnBase + uGlow * shimmer;
  // 輪は 1 未満で頭打ちにし、白飛びさせず補色の色味をはっきり残す。芯だけ白まで飛ばす
  vec3 haloAmount = clamp(ringShape * (0.35 + baseGlow), 0.0, 0.85);
  float coreAmount = clamp(core * uGlow * shimmer, 0.0, 1.0);
  vec3 envelope = max(haloAmount, vec3(coreAmount));

  // 柱の色は、通過する背景色の補色（RGB反転）。足すと白になる（補色を重ねると白色光になるという色彩理論を利用）
  // envelope が 0〜1 に収まっているので、col + complement * envelope も自動的に 0〜1 に収まる（白飛びしない）
  vec3 complement = vec3(1.0) - col;
  col = col + complement * envelope;

  gl_FragColor = vec4(col, 1.0);
}
`;

export const lightColumns: SceneDef = {
  id: 'light-columns',
  label: '光の柱',
  sunLinks: [
    { toggle: 'useSkyColors', uses: ['color'] },
    { toggle: 'sunGlow', uses: ['lit'] },
  ],
  params: {
    bands: { type: 'number', label: '帯の数', value: 4, min: 1, max: 10, step: 0.1 },
    wobble: { type: 'number', label: '帯のうねり', value: 0.12, min: 0, max: 0.4, step: 0.01 },
    flow: { type: 'number', label: 'うねりの速さ', value: 0.6, min: 0, max: 3, step: 0.05 },
    useSkyColors: { type: 'boolean', label: '時間帯の色を使う', value: false },
    c0: { type: 'color', label: '色 1', value: '#c23b7a' },
    c1: { type: 'color', label: '色 2', value: '#241a66' },
    c2: { type: 'color', label: '色 3', value: '#e0c23a' },
    c3: { type: 'color', label: '色 4', value: '#1f7a6b' },
    columnSpacing: { type: 'number', label: '柱の間隔(px)', value: 480, min: 80, max: 1600, step: 10 },
    columnJitter: { type: 'number', label: '柱の位置のばらつき', value: 0.05, min: 0, max: 0.3, step: 0.01 },
    columnWidth: { type: 'number', label: '柱の太さ(px)', value: 16, min: 4, max: 200, step: 1 },
    chroma: { type: 'number', label: '虹色のにじみ', value: 0.2, min: 0, max: 1, step: 0.01 },
    columnBase: { type: 'number', label: '柱の基本の輝き', value: 0.08, min: 0, max: 1, step: 0.01 },
    sunGlow: { type: 'boolean', label: '日差しで光条が輝く', value: true },
    glowStrength: { type: 'number', label: '輝きの強さ', value: 0.55, min: 0, max: 2, step: 0.01 },
    flicker: { type: 'number', label: '揺らめき', value: 0.2, min: 0, max: 1, step: 0.01 },
    flickerSpeed: { type: 'number', label: '揺らめきの速さ', value: 1, min: 0, max: 5, step: 0.05 },
  },
  create({ width, height }) {
    const s = fullscreenShader(frag, {
      uRes: { value: new THREE.Vector2(width, height) },
      uDrift: { value: new THREE.Vector2() },
      uBands: { value: 4 },
      uWobble: { value: 0.12 },
      uC0: { value: new THREE.Vector3() },
      uC1: { value: new THREE.Vector3() },
      uC2: { value: new THREE.Vector3() },
      uC3: { value: new THREE.Vector3() },
      uColumnSpacing: { value: 480 },
      uColumnJitter: { value: 0.05 },
      uColumnWidth: { value: 16 },
      uColumnBase: { value: 0.08 },
      uGlow: { value: 0 },
      uChroma: { value: 0.2 },
      uFlicker: { value: 0.2 },
    });
    return {
      scene: s.scene,
      camera: s.camera,
      update(input, params) {
        const u = s.uniforms;
        const flow = num(params, 'flow');
        const flicker = num(params, 'flickerSpeed');
        u.uDrift.value.set(wrap(input.time * 0.03 * flow), wrap(input.time * 0.02 * flow));
        u.uBands.value = num(params, 'bands');
        u.uWobble.value = num(params, 'wobble');
        if (bool(params, 'useSkyColors')) {
          const lc = input.lightColor, top = input.sky.top, bottom = input.sky.bottom;
          u.uC0.value.set(lc[0], lc[1] * 0.7, lc[2] * 0.8);
          u.uC1.value.set(...bottom);
          u.uC2.value.set(...top);
          u.uC3.value.set((top[0] + bottom[0]) / 2, (top[1] + bottom[1]) / 2, (top[2] + bottom[2]) / 2);
        } else {
          u.uC0.value.copy(hexToVec3(color(params, 'c0')));
          u.uC1.value.copy(hexToVec3(color(params, 'c1')));
          u.uC2.value.copy(hexToVec3(color(params, 'c2')));
          u.uC3.value.copy(hexToVec3(color(params, 'c3')));
        }
        u.uColumnSpacing.value = Math.max(1, num(params, 'columnSpacing'));
        u.uColumnJitter.value = num(params, 'columnJitter');
        u.uColumnWidth.value = Math.max(0.5, num(params, 'columnWidth'));
        u.uColumnBase.value = num(params, 'columnBase');
        u.uChroma.value = num(params, 'chroma');
        u.uFlicker.value = num(params, 'flicker') * Math.min(1, flicker);
        const glowOn = bool(params, 'sunGlow');
        u.uGlow.value = (glowOn ? input.lit : 1) * num(params, 'glowStrength');
      },
      dispose: s.dispose,
    };
  },
};
