// 結露・水滴：曇ったガラスに水滴がつく。水滴はレンズとして景色を屈折させ、縁には光が集まって光る
import * as THREE from 'three';
import { hexToVec3 } from '../shader.ts';
import { color, num } from '../types.ts';
import { TIME_PERIOD, imageScene } from './source.ts';

const glsl = /* glsl */ `
uniform float uFog, uBlur, uDropSize, uDensity, uSmall, uRefract, uRim, uSunRim;
uniform vec3 uRimColor, uFogColor;

vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }

// 水滴の場（メタボール：近い水滴は表面張力でつながる）。x = 場の強さ（1 以上が水滴の中）, yz = 場の勾配
vec3 drops(vec2 q, float scale, float seed, float density) {
  vec2 g = q * scale;
  vec2 id = floor(g), f = fract(g);
  float v = 0.0;
  vec2 grad = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cid = id + vec2(float(i), float(j));
      if (hash(cid + seed + 9.7) > density) continue;
      vec2 h = hash2(cid + seed);
      vec2 c = vec2(float(i), float(j)) + 0.15 + 0.7 * h;
      // 水滴ごとに、ゆっくり育って消える（周期内で整数回なので巻き戻しても継ぎ目が出ない）
      float life = fract(h.x * 3.7 + uT * (2.0 + floor(h.y * 7.0)) / ${TIME_PERIOD.toFixed(1)});
      float r = (0.16 + 0.3 * hash(cid + seed + 3.1)) * smoothstep(0.0, 0.25, life) * (1.0 - smoothstep(0.8, 1.0, life));
      vec2 dv = f - c;
      float d2 = max(dot(dv, dv), 1e-4);
      float w = r * r / d2;
      v += w;
      grad += -2.0 * w * dv / d2;
    }
  }
  return vec3(v, grad * scale);
}

vec3 effect(vec2 uv, vec2 p) {
  float aspect = uRes.x / uRes.y;
  vec2 q = vec2(uv.x * aspect, uv.y);
  vec3 big = drops(q, 1.0 / uDropSize, 0.0, uDensity);
  vec3 small = drops(q, 3.2 / uDropSize, 17.0, uDensity * uSmall);
  vec3 f = big.x > small.x ? big : small;
  float inside = smoothstep(0.96, 1.04, f.x);

  // 水滴はレンズ：縁ほど強く屈折して、景色がゆがみ拡大されて見える
  float hgt = sqrt(clamp(1.0 - 1.0 / max(f.x, 1e-3), 0.0, 1.0));
  vec2 n = f.yz / (length(f.yz) + 1e-3);
  vec2 off = -n * (1.0 - hgt) * uRefract;
  vec3 clear = img(uv + off * vec2(1.0 / aspect, 1.0)) * (0.94 + 0.1 * hgt);

  // 曇ったガラス：細かい水滴で光が散り、ぼけて白っぽく見える
  vec3 fog = mix(imgLod(uv, uBlur), uFogColor, uFog);
  fog *= 1.0 + (noise(p * 0.35) - 0.5) * 0.04 * uFog;
  vec3 col = mix(fog, clear, inside);

  // 縁の光（水滴の中で反射した光が縁に集まる）と、外側の細い影
  float rim = smoothstep(1.0, 1.12, f.x) * (1.0 - smoothstep(1.12, 1.8, f.x));
  float shadow = smoothstep(0.75, 1.0, f.x) * (1.0 - smoothstep(0.97, 1.03, f.x));
  col *= 1.0 - 0.3 * shadow;
  col += mix(uRimColor, uLightColor, 0.35) * rim * uRim * uSunRim;
  return col;
}
`;

// 上と同じもの（WebGPU 用）
const wgsl = /* wgsl */ `
fn hash2(p: vec2f) -> vec2f { return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453); }

fn drops(q: vec2f, scale: f32, seed: f32, density: f32) -> vec3f {
  let g = q * scale;
  let id = floor(g);
  let f = fract(g);
  var v = 0.0;
  var grad = vec2f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cid = id + vec2f(f32(i), f32(j));
      if (hash(cid + seed + 9.7) > density) { continue; }
      let h = hash2(cid + seed);
      let c = vec2f(f32(i), f32(j)) + 0.15 + 0.7 * h;
      let life = fract(h.x * 3.7 + u.uT * (2.0 + floor(h.y * 7.0)) / ${TIME_PERIOD.toFixed(1)});
      let r = (0.16 + 0.3 * hash(cid + seed + 3.1)) * smoothstep(0.0, 0.25, life) * (1.0 - smoothstep(0.8, 1.0, life));
      let dv = f - c;
      let d2 = max(dot(dv, dv), 1e-4);
      let w = r * r / d2;
      v += w;
      grad += -2.0 * w * dv / d2;
    }
  }
  return vec3f(v, grad * scale);
}

fn effect(uv: vec2f, p: vec2f) -> vec3f {
  let aspect = u.uRes.x / u.uRes.y;
  let q = vec2f(uv.x * aspect, uv.y);
  let big = drops(q, 1.0 / u.uDropSize, 0.0, u.uDensity);
  let small = drops(q, 3.2 / u.uDropSize, 17.0, u.uDensity * u.uSmall);
  let f = select(small, big, big.x > small.x);
  let inside = smoothstep(0.96, 1.04, f.x);
  let hgt = sqrt(clamp(1.0 - 1.0 / max(f.x, 1e-3), 0.0, 1.0));
  let n = f.yz / (length(f.yz) + 1e-3);
  let off = -n * (1.0 - hgt) * u.uRefract;
  let clear = img(uv + off * vec2f(1.0 / aspect, 1.0)) * (0.94 + 0.1 * hgt);
  var fog = mix(imgLod(uv, u.uBlur), u.uFogColor, u.uFog);
  fog *= 1.0 + (noise(p * 0.35) - 0.5) * 0.04 * u.uFog;
  var col = mix(fog, clear, inside);
  let rim = smoothstep(1.0, 1.12, f.x) * (1.0 - smoothstep(1.12, 1.8, f.x));
  let shadow = smoothstep(0.75, 1.0, f.x) * (1.0 - smoothstep(0.97, 1.03, f.x));
  col *= 1.0 - 0.3 * shadow;
  col += mix(u.uRimColor, u.uLightColor, 0.35) * rim * u.uRim * u.uSunRim;
  return col;
}
`;

export const droplets = imageScene({
  id: 'img-droplets',
  label: '画像：結露・水滴',
  sunLinks: [{ toggle: 'sunRim', uses: ['lit'] }, { uses: ['color'] }],
  glsl,
  wgsl,
  params: {
    fog: { type: 'number', label: '曇り（湿度）', value: 0.5, min: 0, max: 1, step: 0.01 },
    blur: { type: 'number', label: '曇りのぼけ', value: 5, min: 0, max: 8, step: 0.1 },
    dropSize: { type: 'number', label: '水滴の大きさ', value: 0.12, min: 0.03, max: 0.4, step: 0.005 },
    density: { type: 'number', label: '水滴の多さ', value: 0.4, min: 0, max: 1, step: 0.01 },
    small: { type: 'number', label: '小さな水滴', value: 0.5, min: 0, max: 1, step: 0.01 },
    refract: { type: 'number', label: '屈折の強さ', value: 0.06, min: 0, max: 0.3, step: 0.005 },
    rim: { type: 'number', label: '縁の光', value: 0.3, min: 0, max: 1.5, step: 0.01 },
    sunRim: { type: 'boolean', label: '日差しで縁が光る', value: true },
    rimColor: { type: 'color', label: '縁の光の色', value: '#9fd4ff' },
    fogColor: { type: 'color', label: '曇りの色', value: '#e6eaef' },
  },
  uniforms: () => ({
    uFog: { value: 0.5 },
    uBlur: { value: 5 },
    uDropSize: { value: 0.12 },
    uDensity: { value: 0.6 },
    uSmall: { value: 0.8 },
    uRefract: { value: 0.06 },
    uRim: { value: 0.5 },
    uSunRim: { value: 1 },
    uRimColor: { value: new THREE.Vector3() },
    uFogColor: { value: new THREE.Vector3() },
  }),
  update(u, input, params) {
    u.uFog.value = num(params, 'fog');
    u.uBlur.value = num(params, 'blur');
    u.uDropSize.value = num(params, 'dropSize');
    u.uDensity.value = num(params, 'density');
    u.uSmall.value = num(params, 'small');
    u.uRefract.value = num(params, 'refract');
    u.uRim.value = num(params, 'rim');
    u.uSunRim.value = params['sunRim'] === true ? 0.4 + 0.6 * input.lit : 1;
    u.uRimColor.value.copy(hexToVec3(color(params, 'rimColor')));
    u.uFogColor.value.copy(hexToVec3(color(params, 'fogColor')));
  },
});
