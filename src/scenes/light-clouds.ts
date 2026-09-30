// 光の雲：ゆっくり流れて形を変える雲（3 次元ノイズの重ね合わせ）を、窓から差す光が照らす。
// 光は画面の外、光が来る側（光の進む向きの上流）にあり、そこに近い雲ほど明るく、光の色に染まる。
// 動き回る色の光の点（光の点を表示）は既定ではオフ。
import * as THREE from 'three';
import { DriftBlend, GLSL_SIMPLEX3, fullscreenShader, hexToVec3 } from './shader.ts';
import { type SceneDef, bool, color, num } from './types.ts';


const MAX_OCTAVES = 6;
const POINTS = 3;

const frag = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform vec3 uOffA, uOffB;   // 雲の流れ（xy）と形の変化（z）。B は巻き戻した後の同じ動き（つなぎ目用）
uniform float uBlend;        // 0 = A だけ、1 = B だけ（移っている間だけ 0 より大きい）
uniform float uScale, uOctaves, uAmount, uContrast;
uniform float uCloudsOn;
uniform vec2 uSrc;           // 光のある位置（高さ = 1 の座標。画面の外でよい）
uniform float uGlow, uSpread, uHaze;
uniform vec3 uLightCol, uSkyTop, uSkyBottom;
uniform float uBg, uAmbient;
uniform float uPointsOn, uPointSize, uPointReach;
uniform vec2 uPointPos[${POINTS}];
uniform vec3 uPointCol[${POINTS}];
${GLSL_SIMPLEX3}

// 雲の濃さのもと（-1〜1 程度）。細かい層ほど弱く、速く形が変わる。層ごとに位置をずらして同じ模様が重ならないようにする
float cloudSum(vec2 q, vec3 off) {
  float s = 0.0, a = 0.55, f = 1.0;
  for (int i = 0; i < ${MAX_OCTAVES}; i++) {
    if (float(i) >= uOctaves) break;
    vec2 shift = vec2(17.3, -9.1) * float(i);
    s += a * snoise(vec3((q + off.xy) * f * uScale + shift, off.z * (1.0 + 0.35 * float(i))));
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

float density(vec2 q) {
  float s = cloudSum(q, uOffA);
  // つなぎ目：2 つの独立な雲を、ばらつきの大きさが変わらない重みで混ぜる
  if (uBlend > 0.0) {
    float w = uBlend;
    s = (s * (1.0 - w) + cloudSum(q, uOffB) * w) / sqrt((1.0 - w) * (1.0 - w) + w * w);
  }
  // 0〜1 の濃さへ。雲の量で全体を濃く・薄く、コントラストで輪郭をはっきりさせる
  float d = 0.5 + 0.5 * s;
  d = (d - 0.5) * uContrast + 0.5 + (uAmount - 0.5);
  return clamp(d, 0.0, 1.0);
}

void main() {
  vec2 q = gl_FragCoord.xy / uRes.y;   // 高さ = 1 の座標（横は 0〜幅/高さ）
  float d = uCloudsOn > 0.5 ? density(q) : 0.0;

  // 背景：空の色（下から上へ）。雲は空の光でも照らされるので、日差しがないときも空より明るく見える
  vec3 sky = mix(uSkyBottom, uSkyTop, gl_FragCoord.y / uRes.y);
  vec3 col = sky * uBg + d * uAmbient * (0.5 * (uSkyTop + uSkyBottom) + 0.1);

  // 窓から差す光：光のある位置に近いほど強い。雲はその光を受けて光り、雲のない所も空気がうっすら光る
  float r = distance(q, uSrc);
  float light = uGlow * exp(-r / uSpread);
  col += uLightCol * light * (d + uHaze * (1.0 - d));

  // 光の点（既定はオフ）：点のまわりの雲が点の色に照らされ、点そのものも光る
  if (uPointsOn > 0.5) {
    for (int i = 0; i < ${POINTS}; i++) {
      float rp = distance(q, uPointPos[i]);
      float onCloud = max(0.0, 1.0 - rp / uPointReach) * d;
      float core = uPointSize / max(rp, 1e-3);
      col += uPointCol[i] * (onCloud * 0.8 + core);
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

export const lightClouds: SceneDef = {
  id: 'light-clouds',
  label: '光の雲',
  sunLinks: [
    { toggle: 'sunDirection', uses: ['direction'] },
    { toggle: 'sunColors', uses: ['color'] },
    { toggle: 'sunLit', uses: ['lit'] },
  ],
  params: {
    // 雲
    clouds: { type: 'boolean', label: '雲を表示', value: true },
    scale: { type: 'number', label: '雲の細かさ', value: 1.6, min: 0.3, max: 6, step: 0.05 },
    octaves: { type: 'number', label: '雲の重ね数（多いほど細部まで・重い）', value: 5, min: 1, max: MAX_OCTAVES, step: 1 },
    amount: { type: 'number', label: '雲の量', value: 0.45, min: 0, max: 1, step: 0.01 },
    contrast: { type: 'number', label: '雲の輪郭のくっきりさ', value: 1.7, min: 0.3, max: 4, step: 0.05 },
    flow: { type: 'number', label: '流れる速さ', value: 1, min: 0, max: 5, step: 0.05 },
    flowAngle: { type: 'number', label: '流れる向き（度、0 = 右）', value: 10, min: -180, max: 180, step: 1 },
    evolve: { type: 'number', label: '形の変わる速さ', value: 1, min: 0, max: 5, step: 0.05 },
    // 窓から差す光
    sunDirection: { type: 'boolean', label: '光の向きに合わせて照らす', value: true },
    glow: { type: 'number', label: '光の強さ', value: 1.1, min: 0, max: 3, step: 0.01 },
    spread: { type: 'number', label: '光の届く広さ', value: 0.8, min: 0.1, max: 5, step: 0.05 },
    haze: { type: 'number', label: '雲のない所の光', value: 0.08, min: 0, max: 1, step: 0.01 },
    sunLit: { type: 'boolean', label: '日差しの強さで明るさが変わる', value: true },
    // 色
    sunColors: { type: 'boolean', label: '時間帯の光・空の色を使う', value: true },
    lightColor: { type: 'color', label: '光の色', value: '#ffe2b8' },
    skyTop: { type: 'color', label: '空の色（上）', value: '#1c2440' },
    skyBottom: { type: 'color', label: '空の色（下）', value: '#3a3550' },
    background: { type: 'number', label: '背景の明るさ', value: 0.3, min: 0, max: 1, step: 0.01 },
    ambient: { type: 'number', label: '空の光で見える雲の明るさ', value: 0.35, min: 0, max: 1, step: 0.01 },
    // 光の点（動き回る色の光）
    points: { type: 'boolean', label: '光の点を表示', value: false },
    pointSize: { type: 'number', label: '光の点の大きさ', value: 0.006, min: 0.001, max: 0.03, step: 0.001 },
    pointReach: { type: 'number', label: '光の点が雲を照らす広さ', value: 0.5, min: 0.05, max: 2, step: 0.01 },
    pointSpeed: { type: 'number', label: '光の点の速さ', value: 1, min: 0, max: 5, step: 0.05 },
    p0: { type: 'color', label: '光の点の色 1', value: '#ff5a4d' },
    p1: { type: 'color', label: '光の点の色 2', value: '#4dff7a' },
    p2: { type: 'color', label: '光の点の色 3', value: '#5a6bff' },
  },
  create({ width, height }) {
    const aspect = width / height;
    const s = fullscreenShader(frag, {
      uRes: { value: new THREE.Vector2(width, height) },
      uOffA: { value: new THREE.Vector3() },
      uOffB: { value: new THREE.Vector3() },
      uBlend: { value: 0 },
      uScale: { value: 1.6 },
      uOctaves: { value: 5 },
      uAmount: { value: 0.5 },
      uContrast: { value: 1.4 },
      uCloudsOn: { value: 1 },
      uSrc: { value: new THREE.Vector2() },
      uGlow: { value: 1 },
      uSpread: { value: 1 },
      uHaze: { value: 0.15 },
      uLightCol: { value: new THREE.Vector3(1, 1, 1) },
      uSkyTop: { value: new THREE.Vector3() },
      uSkyBottom: { value: new THREE.Vector3() },
      uBg: { value: 0.3 },
      uAmbient: { value: 0.35 },
      uPointsOn: { value: 0 },
      uPointSize: { value: 0.006 },
      uPointReach: { value: 0.5 },
      uPointPos: { value: Array.from({ length: POINTS }, () => new THREE.Vector2()) },
      uPointCol: { value: Array.from({ length: POINTS }, () => new THREE.Vector3()) },
    });
    // 流れ・形の変化・光の点の動きは、パラメータを変えても位置が飛ばないよう、毎フレームの増分を足していく
    const drift = new DriftBlend();
    let pointPhase = 0;
    let last = -1;

    return {
      scene: s.scene,
      camera: s.camera,
      update(input, params) {
        const u = s.uniforms;
        const dt = last < 0 ? 0 : Math.min(0.25, Math.max(0, input.time - last));
        last = input.time;

        // 雲の流れ（高さ = 1 の座標で毎秒どれだけ動くか）と形の変化
        const a = (num(params, 'flowAngle') * Math.PI) / 180;
        const v = new THREE.Vector3(-Math.cos(a) * 0.012 * num(params, 'flow'), -Math.sin(a) * 0.012 * num(params, 'flow'), 0.05 * num(params, 'evolve'));
        drift.step(v, dt);
        u.uOffA.value.copy(drift.a);
        u.uOffB.value.copy(drift.b);
        u.uBlend.value = drift.blend;

        u.uScale.value = num(params, 'scale');
        u.uOctaves.value = Math.round(num(params, 'octaves'));
        u.uAmount.value = num(params, 'amount');
        u.uContrast.value = num(params, 'contrast');
        u.uCloudsOn.value = bool(params, 'clouds') ? 1 : 0;

        // 光のある位置：画面の中央から、光が来る側（光の進む向きの逆）へ画面の外まで離した所。オフなら画面の上の中央の外
        const cx = aspect / 2, cy = 0.5;
        const dir = new THREE.Vector2(input.light.dirX, input.light.dirY);
        if (bool(params, 'sunDirection') && dir.lengthSq() > 1e-8) {
          dir.normalize();
          // 画面の縁（横 ±aspect/2、縦 ±1/2）を越える所まで戻す
          const tx = Math.abs(dir.x) > 1e-6 ? (aspect / 2) / Math.abs(dir.x) : Infinity;
          const ty = Math.abs(dir.y) > 1e-6 ? 0.5 / Math.abs(dir.y) : Infinity;
          const k = Math.min(tx, ty) + 0.15;
          u.uSrc.value.set(cx - dir.x * k, cy - dir.y * k);
        } else {
          u.uSrc.value.set(cx, 1.15);
        }
        u.uGlow.value = num(params, 'glow') * (bool(params, 'sunLit') ? input.lit : 1);
        u.uSpread.value = num(params, 'spread');
        u.uHaze.value = num(params, 'haze');

        if (bool(params, 'sunColors')) {
          u.uLightCol.value.set(...input.lightColor);
          u.uSkyTop.value.set(...input.sky.top);
          u.uSkyBottom.value.set(...input.sky.bottom);
        } else {
          u.uLightCol.value.copy(hexToVec3(color(params, 'lightColor')));
          u.uSkyTop.value.copy(hexToVec3(color(params, 'skyTop')));
          u.uSkyBottom.value.copy(hexToVec3(color(params, 'skyBottom')));
        }
        u.uBg.value = num(params, 'background');
        u.uAmbient.value = num(params, 'ambient');

        // 光の点：画面の中をゆっくり回る（向きと速さの違う円運動の組み合わせ）
        u.uPointsOn.value = bool(params, 'points') ? 1 : 0;
        u.uPointSize.value = num(params, 'pointSize');
        u.uPointReach.value = num(params, 'pointReach');
        pointPhase = (pointPhase + dt * num(params, 'pointSpeed')) % (2 * Math.PI * 1000);
        const ph = pointPhase;
        const paths: [number, number, number, number][] = [
          [0.9, 0.7, 0.33, 1.3],
          [-0.8, 1.1, 0.51, 4.1],
          [1.15, -0.6, 0.27, 2.2],
        ];
        paths.forEach(([fx, fy, r, o], i) => {
          const x = cx + aspect * 0.28 * Math.sin(fx * ph * 0.5 + o) + r * Math.cos(0.37 * ph + o * 2);
          const y = cy + 0.3 * Math.cos(fy * ph * 0.5 + o * 1.7);
          u.uPointPos.value[i]!.set(x, y);
          u.uPointCol.value[i]!.copy(hexToVec3(color(params, `p${i}`)));
        });
      },
      dispose: s.dispose,
    };
  },
};
