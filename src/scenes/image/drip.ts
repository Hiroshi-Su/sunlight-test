// 垂れる流れ：明るい所の色が、重力で下へ（または光の向きへ）垂れて伸びる。先端は丸い滴になる
import * as THREE from 'three';
import { bool, num } from '../types.ts';
import { TIME_PERIOD, imageScene } from './source.ts';

const glsl = /* glsl */ `
uniform float uLen, uThreshold, uWidth, uAmount, uInvert, uOpacity;
uniform vec2 uFlowDir;

vec3 effect(vec2 uv, vec2 p) {
  vec3 base = img(uv);
  vec2 d = normalize(uFlowDir);
  vec2 perp = vec2(-d.y, d.x);

  // 流れに沿った細い帯ごとに、垂れるかどうか・長さ・伸び縮みの周期を決める
  float across = dot(p, perp) / uWidth;
  float colId = floor(across);
  float cx = fract(across) - 0.5;
  float h = hash(vec2(colId, 3.3)), h2 = hash(vec2(colId, 7.1));
  if (h2 < 1.0 - uAmount) return base;
  float life = fract(h * 5.3 + uT * (1.0 + floor(h2 * 5.0)) / ${TIME_PERIOD.toFixed(1)});
  float len = uLen * uRes.y * (0.25 + 0.75 * h) * smoothstep(0.0, 0.7, life) * (1.0 - smoothstep(0.9, 1.0, life));
  if (len < 2.0) return base;

  // 流れの上流へたどり、最初に見つかった「明るい所」の色を引き伸ばす
  float hitDist = -1.0;
  vec3 hitCol = vec3(0.0);
  for (int i = 0; i < 28; i++) {
    float sd = float(i) / 27.0 * len;
    vec3 c = imgLod((p - d * sd) / uRes, 1.0);
    float l = luma(c);
    if (uInvert > 0.5) l = 1.0 - l;
    if (l > uThreshold) { hitDist = sd; hitCol = c; break; }
  }
  if (hitDist <= 0.0) return base;

  // 先へ行くほど細くなり、先端は丸い滴
  float halfW = 0.5 * mix(0.85, 0.5, hitDist / len);
  float body = (1.0 - smoothstep(halfW - 0.06, halfW, abs(cx))) * (1.0 - smoothstep(len - uWidth * 0.3, len, hitDist));
  float bulbR = uWidth * 0.42;
  float bulb = 1.0 - smoothstep(bulbR - 1.5, bulbR, length(vec2(cx * uWidth, hitDist - (len - bulbR))));
  float mask = max(body, bulb);
  return mix(base, hitCol, mask * uOpacity);
}
`;

// 上と同じもの（WebGPU 用）
const wgsl = /* wgsl */ `
fn effect(uv: vec2f, p: vec2f) -> vec3f {
  let base = img(uv);
  let d = normalize(u.uFlowDir);
  let perp = vec2f(-d.y, d.x);
  let across = dot(p, perp) / u.uWidth;
  let colId = floor(across);
  let cx = fract(across) - 0.5;
  let h = hash(vec2f(colId, 3.3));
  let h2 = hash(vec2f(colId, 7.1));
  if (h2 < 1.0 - u.uAmount) { return base; }
  let life = fract(h * 5.3 + u.uT * (1.0 + floor(h2 * 5.0)) / ${TIME_PERIOD.toFixed(1)});
  let len = u.uLen * u.uRes.y * (0.25 + 0.75 * h) * smoothstep(0.0, 0.7, life) * (1.0 - smoothstep(0.9, 1.0, life));
  if (len < 2.0) { return base; }
  var hitDist = -1.0;
  var hitCol = vec3f(0.0);
  for (var i = 0; i < 28; i++) {
    let sd = f32(i) / 27.0 * len;
    let c = imgLod((p - d * sd) / u.uRes, 1.0);
    var l = luma(c);
    if (u.uInvert > 0.5) { l = 1.0 - l; }
    if (l > u.uThreshold) { hitDist = sd; hitCol = c; break; }
  }
  if (hitDist <= 0.0) { return base; }
  let halfW = 0.5 * mix(0.85, 0.5, hitDist / len);
  let body = (1.0 - smoothstep(halfW - 0.06, halfW, abs(cx))) * (1.0 - smoothstep(len - u.uWidth * 0.3, len, hitDist));
  let bulbR = u.uWidth * 0.42;
  let bulb = 1.0 - smoothstep(bulbR - 1.5, bulbR, length(vec2f(cx * u.uWidth, hitDist - (len - bulbR))));
  let mask = max(body, bulb);
  return mix(base, hitCol, mask * u.uOpacity);
}
`;

export const drip = imageScene({
  id: 'img-drip',
  label: '画像：垂れる流れ',
  sunLinks: [{ toggle: 'followLight', uses: ['direction'] }],
  glsl,
  wgsl,
  params: {
    len: { type: 'number', label: '垂れる長さ', value: 0.35, min: 0.02, max: 1, step: 0.01 },
    threshold: { type: 'number', label: '垂れる明るさ', value: 0.62, min: 0, max: 1, step: 0.01 },
    invert: { type: 'boolean', label: '暗い所を垂らす', value: false },
    width: { type: 'number', label: '筋の太さ（px）', value: 26, min: 4, max: 160, step: 1 },
    amount: { type: 'number', label: '筋の多さ', value: 0.45, min: 0, max: 1, step: 0.01 },
    opacity: { type: 'number', label: '濃さ', value: 0.9, min: 0, max: 1, step: 0.01 },
    followLight: { type: 'boolean', label: '光の向きに垂れる（オフで下へ）', value: false },
  },
  uniforms: () => ({
    uLen: { value: 0.35 },
    uThreshold: { value: 0.62 },
    uWidth: { value: 26 },
    uAmount: { value: 0.45 },
    uInvert: { value: 0 },
    uOpacity: { value: 0.9 },
    uFlowDir: { value: new THREE.Vector2(0, -1) },
  }),
  update(u, input, params) {
    u.uLen.value = num(params, 'len');
    u.uThreshold.value = num(params, 'threshold');
    u.uWidth.value = num(params, 'width');
    u.uAmount.value = num(params, 'amount');
    u.uInvert.value = bool(params, 'invert') ? 1 : 0;
    u.uOpacity.value = num(params, 'opacity');
    if (bool(params, 'followLight')) u.uFlowDir.value.set(input.light.dirX, input.light.dirY);
    else u.uFlowDir.value.set(0, -1);
  },
});
