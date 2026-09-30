// 検証用：光の向きと強さを、窓側から差す光の広がりと窓枠の影で見せる
import * as THREE from 'three';
import { GLSL_NOISE, WGSL_NOISE, fullscreenShader, wrap } from './shader.ts';
import { type SceneDef, bool, num } from './types.ts';

const frag = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform vec2 uDir;
uniform float uLit;
uniform vec3 uSkyTop, uSkyBottom, uLightColor;
uniform vec2 uDrift;
uniform float uPaneWidth, uStripes, uStrength, uShadow, uNoise;
${GLSL_NOISE}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 uv = p / uRes;
  vec3 col = mix(uSkyBottom, uSkyTop, smoothstep(0.0, 1.0, uv.y));
  float n = fbm(vec2(uv.x * uRes.x / uRes.y, uv.y) * 1.3 + uDrift);
  col *= 1.0 - uNoise * 0.5 + uNoise * n;

  vec2 d = normalize(uDir);
  vec2 perp = vec2(-d.y, d.x);
  float f = fract(dot(p, perp) / uPaneWidth);
  float pane = mix(1.0, smoothstep(0.0, 0.03, f) * (1.0 - smoothstep(0.82, 0.85, f)), uStripes);

  // 光が入ってくる側の画面端を 0、抜けていく側を 1
  float c1 = dot(vec2(uRes.x, 0.0), d), c2 = dot(vec2(0.0, uRes.y), d), c3 = dot(uRes, d);
  float tMin = min(min(0.0, c1), min(c2, c3)), tMax = max(max(0.0, c1), max(c2, c3));
  float t = (dot(p, d) - tMin) / max(tMax - tMin, 1.0);
  float fade = mix(1.0, 0.35, smoothstep(0.0, 1.0, t));

  // 窓枠の影は沈め、光の当たる面は光の色へ寄せる（加算で白飛びさせない）
  col *= 1.0 - uShadow * uLit * (1.0 - pane);
  col = mix(col, uLightColor * 0.9, uStrength * pane * fade * uLit);
  gl_FragColor = vec4(col, 1.0);
}
`;

const wgsl = /* wgsl */ `
${WGSL_NOISE}
fn frag(p: vec2f) -> vec3f {
  let uv = p / u.uRes;
  var col = mix(u.uSkyBottom, u.uSkyTop, smoothstep(0.0, 1.0, uv.y));
  let n = fbm(vec2f(uv.x * u.uRes.x / u.uRes.y, uv.y) * 1.3 + u.uDrift);
  col *= 1.0 - u.uNoise * 0.5 + u.uNoise * n;

  let d = normalize(u.uDir);
  let perp = vec2f(-d.y, d.x);
  let f = fract(dot(p, perp) / u.uPaneWidth);
  let pane = mix(1.0, smoothstep(0.0, 0.03, f) * (1.0 - smoothstep(0.82, 0.85, f)), u.uStripes);

  // 光が入ってくる側の画面端を 0、抜けていく側を 1
  let c1 = dot(vec2f(u.uRes.x, 0.0), d);
  let c2 = dot(vec2f(0.0, u.uRes.y), d);
  let c3 = dot(u.uRes, d);
  let tMin = min(min(0.0, c1), min(c2, c3));
  let tMax = max(max(0.0, c1), max(c2, c3));
  let t = (dot(p, d) - tMin) / max(tMax - tMin, 1.0);
  let fade = mix(1.0, 0.35, smoothstep(0.0, 1.0, t));

  // 窓枠の影は沈め、光の当たる面は光の色へ寄せる（加算で白飛びさせない）
  col *= 1.0 - u.uShadow * u.uLit * (1.0 - pane);
  col = mix(col, u.uLightColor * 0.9, u.uStrength * pane * fade * u.uLit);
  return col;
}
`;

export const lightDebug: SceneDef = {
  id: 'light-debug',
  label: '検証用：光の向き',
  sunLinks: [{ uses: ['direction', 'lit', 'color'] }],
  params: {
    strength: { type: 'number', label: '光の強さ', value: 0.5, min: 0, max: 1, step: 0.01 },
    stripes: { type: 'boolean', label: '窓枠の影', value: false },
    paneWidth: { type: 'number', label: '窓枠の間隔(px)', value: 420, min: 80, max: 1600, step: 10 },
    shadow: { type: 'number', label: '影の濃さ', value: 0.22, min: 0, max: 0.6, step: 0.01 },
    noise: { type: 'number', label: '揺らぎ', value: 0.1, min: 0, max: 0.4, step: 0.01 },
  },
  create({ width, height }) {
    const s = fullscreenShader({ glsl: frag, wgsl }, {
      uRes: { value: new THREE.Vector2(width, height) },
      uDir: { value: new THREE.Vector2(-1, -0.5) },
      uLit: { value: 0 },
      uSkyTop: { value: new THREE.Vector3() },
      uSkyBottom: { value: new THREE.Vector3() },
      uLightColor: { value: new THREE.Vector3(1, 1, 1) },
      uDrift: { value: new THREE.Vector2() },
      uPaneWidth: { value: 420 },
      uStripes: { value: 0 },
      uStrength: { value: 0.5 },
      uShadow: { value: 0.22 },
      uNoise: { value: 0.1 },
    });
    return {
      pass: s.pass,
      update(input, params) {
        const u = s.uniforms;
        u.uDir.value.set(input.light.dirX, input.light.dirY);
        u.uLit.value = input.lit;
        u.uSkyTop.value.set(...input.sky.top);
        u.uSkyBottom.value.set(...input.sky.bottom);
        u.uLightColor.value.set(...input.lightColor);
        u.uDrift.value.set(wrap(input.time * 0.004), wrap(input.time * 0.002));
        u.uPaneWidth.value = num(params, 'paneWidth');
        u.uStripes.value = bool(params, 'stripes') ? 1 : 0;
        u.uStrength.value = num(params, 'strength');
        u.uShadow.value = num(params, 'shadow');
        u.uNoise.value = num(params, 'noise');
      },
      dispose: s.dispose,
    };
  },
};
