// ひな形：光の時計（最小版）。画面全体の色面グラデーションが、光の向きと太陽高度に合わせて移ろう
import * as THREE from 'three';
import { GLSL_NOISE, WGSL_NOISE, fullscreenShader, hexToVec3, wrap } from './shader.ts';
import { type SceneDef, bool, color, num } from './types.ts';

const frag = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform vec2 uDir;
uniform float uLit;
uniform vec3 uSkyTop, uSkyBottom, uLightColor, uAccent;
uniform vec2 uDrift;
uniform float uWarmth, uSoftness, uNoise, uUseAccent;
${GLSL_NOISE}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 uv = p / uRes;
  float aspect = uRes.x / uRes.y;

  // 光の進む向きに沿ったグラデーション（光が来る側 = 0）
  vec2 d = normalize(uDir);
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float t = dot(q, d) / (0.5 * aspect + 0.5) * 0.5 + 0.5;
  float warp = (fbm(q * 0.9 + uDrift) - 0.5) * uNoise;
  t = smoothstep(0.5 - uSoftness, 0.5 + uSoftness, t + warp);

  vec3 far = mix(uSkyTop, uAccent, uUseAccent);
  vec3 near = mix(uSkyBottom, uLightColor * 0.9, uWarmth * (0.35 + 0.65 * uLit));
  gl_FragColor = vec4(mix(near, far, t), 1.0);
}
`;

const wgsl = /* wgsl */ `
${WGSL_NOISE}
fn frag(p: vec2f) -> vec3f {
  let uv = p / u.uRes;
  let aspect = u.uRes.x / u.uRes.y;

  // 光の進む向きに沿ったグラデーション（光が来る側 = 0）
  let d = normalize(u.uDir);
  let q = vec2f((uv.x - 0.5) * aspect, uv.y - 0.5);
  var t = dot(q, d) / (0.5 * aspect + 0.5) * 0.5 + 0.5;
  let warp = (fbm(q * 0.9 + u.uDrift) - 0.5) * u.uNoise;
  t = smoothstep(0.5 - u.uSoftness, 0.5 + u.uSoftness, t + warp);

  let far = mix(u.uSkyTop, u.uAccent, u.uUseAccent);
  let near = mix(u.uSkyBottom, u.uLightColor * 0.9, u.uWarmth * (0.35 + 0.65 * u.uLit));
  return mix(near, far, t);
}
`;

export const colorField: SceneDef = {
  id: 'color-field',
  label: 'ひな形：光の時計',
  sunLinks: [{ uses: ['direction', 'lit', 'color'] }],
  params: {
    warmth: { type: 'number', label: '光の色の強さ', value: 0.6, min: 0, max: 1, step: 0.01 },
    softness: { type: 'number', label: 'グラデーションの幅', value: 0.45, min: 0.05, max: 0.8, step: 0.01 },
    noise: { type: 'number', label: '揺らぎ', value: 0.25, min: 0, max: 1, step: 0.01 },
    flow: { type: 'number', label: '揺らぎの速さ', value: 1, min: 0, max: 5, step: 0.05 },
    useAccent: { type: 'boolean', label: '奥側の色を指定', value: false },
    accent: { type: 'color', label: '奥側の色', value: '#5a6aa8' },
  },
  create({ width, height }) {
    const s = fullscreenShader({ glsl: frag, wgsl }, {
      uRes: { value: new THREE.Vector2(width, height) },
      uDir: { value: new THREE.Vector2(-1, -0.5) },
      uLit: { value: 0 },
      uSkyTop: { value: new THREE.Vector3() },
      uSkyBottom: { value: new THREE.Vector3() },
      uLightColor: { value: new THREE.Vector3(1, 1, 1) },
      uAccent: { value: new THREE.Vector3() },
      uDrift: { value: new THREE.Vector2() },
      uWarmth: { value: 0.6 },
      uSoftness: { value: 0.45 },
      uNoise: { value: 0.25 },
      uUseAccent: { value: 0 },
    });
    return {
      pass: s.pass,
      update(input, params) {
        const u = s.uniforms;
        const flow = num(params, 'flow');
        u.uDir.value.set(input.light.dirX, input.light.dirY);
        u.uLit.value = input.lit;
        u.uSkyTop.value.set(...input.sky.top);
        u.uSkyBottom.value.set(...input.sky.bottom);
        u.uLightColor.value.set(...input.lightColor);
        u.uAccent.value.copy(hexToVec3(color(params, 'accent')));
        u.uDrift.value.set(wrap(input.time * 0.01 * flow), wrap(input.time * 0.006 * flow));
        u.uWarmth.value = num(params, 'warmth');
        u.uSoftness.value = num(params, 'softness');
        u.uNoise.value = num(params, 'noise');
        u.uUseAccent.value = bool(params, 'useAccent') ? 1 : 0;
      },
      dispose: s.dispose,
    };
  },
};
