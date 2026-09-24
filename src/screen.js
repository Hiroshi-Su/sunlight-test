import * as THREE from 'three';

const vert = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const frag = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform vec2 uDir;          // 画面内の光の進行方向（x=右, y=上, 正規化済み）
uniform float uLit;         // 窓から光が入っている度合い 0..1
uniform vec3 uSkyTop, uSkyBottom, uLightColor;
uniform vec2 uDrift;        // ノイズの流れ。CPU 側で NOISE_PERIOD に巻き戻した値
uniform float uSeed;        // ディザ用 0..1
uniform float uPaneWidth;   // 窓枠の影の間隔(px)
uniform float uStripes;     // 窓枠の影 1=表示 0=非表示

const float NOISE_PERIOD = 256.0;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// 格子を NOISE_PERIOD で繰り返すタイル化ノイズ。fbm の各オクターブも同じ周期で繰り返すので、uDrift を巻き戻しても継ぎ目が出ない
float hashTiled(vec2 i) { return hash(mod(i, NOISE_PERIOD)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashTiled(i), hashTiled(i + vec2(1, 0)), u.x), mix(hashTiled(i + vec2(0, 1)), hashTiled(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; } return v; }

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 uv = p / uRes;
  vec3 col = mix(uSkyBottom, uSkyTop, smoothstep(0.0, 1.0, uv.y));
  float n = fbm(vec2(uv.x * uRes.x / uRes.y, uv.y) * 1.3 + uDrift);
  col *= 0.95 + 0.1 * n;

  vec2 d = normalize(uDir);
  vec2 perp = vec2(-d.y, d.x);
  float s = dot(p, perp) / uPaneWidth;
  float f = fract(s);
  float pane = mix(1.0, smoothstep(0.0, 0.03, f) * (1.0 - smoothstep(0.82, 0.85, f)), uStripes);

  // 光が入ってくる側の画面端を 0、抜けていく側を 1
  float c0 = 0.0, c1 = dot(vec2(uRes.x, 0.0), d), c2 = dot(vec2(0.0, uRes.y), d), c3 = dot(uRes, d);
  float tMin = min(min(c0, c1), min(c2, c3)), tMax = max(max(c0, c1), max(c2, c3));
  float t = (dot(p, d) - tMin) / max(tMax - tMin, 1.0);
  float fade = mix(1.0, 0.35, smoothstep(0.0, 1.0, t));

  // 窓枠の影は沈め、光の当たる面は光の色へ寄せる（加算で白飛びさせない）
  col *= 1.0 - 0.22 * uLit * (1.0 - pane);
  col = mix(col, uLightColor * 0.9, 0.5 * pane * fade * uLit);

  col = clamp(col, 0.05, 0.93);
  col += (hash(p + uSeed * 97.0) - 0.5) / 255.0;  // バンディング対策のディザ
  gl_FragColor = vec4(col, 1.0);
}
`;

export const NOISE_PERIOD = 256;

export function createScreen(canvas, width, height) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);

  const uniforms = {
    uRes: { value: new THREE.Vector2(width, height) },
    uDir: { value: new THREE.Vector2(-1, -0.5) },
    uLit: { value: 0 },
    uSkyTop: { value: new THREE.Vector3() },
    uSkyBottom: { value: new THREE.Vector3() },
    uLightColor: { value: new THREE.Vector3(1, 1, 1) },
    uDrift: { value: new THREE.Vector2() },
    uSeed: { value: 0 },
    uPaneWidth: { value: 420 },
    uStripes: { value: 0 },
  };
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  scene.add(new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms }),
  ));

  return {
    uniforms,
    render() { renderer.render(scene, camera); },
  };
}
