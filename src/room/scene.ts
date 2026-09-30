// room モード：仮想のホワイトボックスの部屋に、計算した日差しをパストレーシングで再現する。
//
// 光を 2 つに分けて計算する：
// - 直射日光：太陽の円盤（0.53°）の各点から窓を通って届くかを、画面に出す段階で毎フレーム確かめる（乱数を使わないので縁がくっきり）
// - 空の光と照り返し：画素ごとに光の経路を追い（床・壁・天井で何度か跳ね返る）、フレームを重ねて平均する。
//   なだらかに変わる成分なので、同じ面の近くの画素どうしでならして、少ない枚数でも見やすくする
//
// 部屋の向きは src/solar.ts の light.{x,y,z}（screen 座標：x = 鑑賞者から見て右、y = 上、z = スクリーンの奥）に合わせる。
// ただし screen 座標は左手系、three.js は右手系なので、three.js 側では「スクリーンの奥 = -z」とし、
// z の符号だけ反転して使う（toThree）。窓の位置・緯度経度が変わっても、この対応は変わらない。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { WindowSide } from '../config.ts';
import type { RGB } from '../palette.ts';
import type { SolarState } from '../solar.ts';
import { SUN_ANGULAR_RADIUS_DEG, directSunFactor, skyBrightness } from './daylight.ts';

export interface RoomGeometry {
  widthM: number;
  depthM: number;
  heightM: number;
}

export interface WindowGeometry {
  widthM: number;
  heightM: number;
  sillHeightM: number;
}

export interface RoomInput {
  solar: SolarState;
  lightColor: RGB;
  sky: { top: RGB; bottom: RGB };
}

/** 画面の設定（パネルから変える） */
export interface RoomRenderSettings {
  /** 露出（画面の明るさ）。1 が標準 */
  exposure: number;
  /** 照り返しの回数。0 = 直接光だけ（照り返しなし） */
  bounces: number;
  /** 照り返しの成分を近くの画素でならす（ざらつきを減らす） */
  smooth: boolean;
}

export interface RoomView {
  camera: THREE.Vector3;
  target: THREE.Vector3;
}

/** screen 座標（左手系）→ three.js（右手系）。スクリーンの奥を -z にする */
export const toThree = (v: { x: number; y: number; z: number }): THREE.Vector3 => new THREE.Vector3(v.x, v.y, -v.z);

// palette.ts の色は sRGB 表記の 0〜1。光の計算は線形の値で行う
const linear = (c: RGB): THREE.Vector3 => {
  const l = new THREE.Color(c[0], c[1], c[2]).convertSRGBToLinear();
  return new THREE.Vector3(l.r, l.g, l.b);
};

// 明るさの目盛り（演出上の値）。直射日光の強さ（大気の外 = SUN_SCALE）と、昼の空の明るさ（放射輝度）の比は、
// 晴天時に「水平面が空から受ける光 ≒ 直射日光の 2 割」になる程度にしている
const SUN_SCALE = 3.0;
const SKY_SCALE = SUN_SCALE * 0.045;
const GROUND_ALBEDO = 0.2; // 窓の外の地面（壁の窓から下向きに見えるところ）
const WALL_ALBEDO = 0.82; // 白い塗装の壁
const FLOOR_ALBEDO = 0.72;
const SCREEN_ALBEDO = 0.45;

const vert = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ---- 2 つの段階で共通の部分：部屋・窓・太陽・空、カメラの光線 ----
const common = /* glsl */ `
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uRoomMin;
uniform vec3 uRoomMax;
uniform int uWinFace;        // 窓のある面：0 = 右の壁（+x）、1 = 左の壁（-x）、2 = 天井（+y）
uniform vec4 uWinRect;       // 窓の範囲（面上の座標 u0, u1, v0, v1）。壁は (z, y)、天井は (x, z)
uniform vec3 uSunDir;        // 太陽のある方向
uniform float uSunSinR;      // 太陽の見かけの半径の sin
uniform vec3 uSunE;          // 直射日光の強さ（光に垂直な面での放射照度）
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform vec3 uGround;
uniform vec4 uScreenRect;    // スクリーン面（奥の壁の x0, x1, y0, y1）

const float PI = 3.14159265358979;
const float EPS = 1e-4;
const vec3 OUTSIDE = vec3(0.02); // 部屋の外（カメラが外にあり、部屋に当たらない方向）

// n を軸にした正規直交基底
void basis(vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float c = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * c, -s * n.x);
  b = vec3(c, s + n.y * n.y * a, -n.y);
}

vec3 safeDir(vec3 d) {
  return vec3(abs(d.x) < 1e-8 ? 1e-8 : d.x, abs(d.y) < 1e-8 ? 1e-8 : d.y, abs(d.z) < 1e-8 ? 1e-8 : d.z);
}

// 部屋（直方体）の内側から出る点。面：0 = +x, 1 = -x, 2 = +y（天井）, 3 = -y（床）, 4 = +z（手前）, 5 = -z（奥・スクリーン）
float exitRoom(vec3 o, vec3 d, out int face) {
  vec3 dd = safeDir(d);
  vec3 bound = mix(uRoomMin, uRoomMax, step(0.0, dd));
  vec3 t = (bound - o) / dd;
  if (t.x <= t.y && t.x <= t.z) { face = dd.x > 0.0 ? 0 : 1; return t.x; }
  if (t.y <= t.z) { face = dd.y > 0.0 ? 2 : 3; return t.y; }
  face = dd.z > 0.0 ? 4 : 5;
  return t.z;
}

vec3 inwardNormal(int face) {
  if (face == 0) return vec3(-1.0, 0.0, 0.0);
  if (face == 1) return vec3(1.0, 0.0, 0.0);
  if (face == 2) return vec3(0.0, -1.0, 0.0);
  if (face == 3) return vec3(0.0, 1.0, 0.0);
  if (face == 4) return vec3(0.0, 0.0, -1.0);
  return vec3(0.0, 0.0, 1.0);
}

bool inWindow(int face, vec3 p) {
  if (face != uWinFace) return false;
  vec2 uv = face == 2 ? p.xz : p.zy;
  return uv.x > uWinRect.x && uv.x < uWinRect.y && uv.y > uWinRect.z && uv.y < uWinRect.w;
}

vec3 windowPoint(float r1, float r2) {
  float u = mix(uWinRect.x, uWinRect.y, r1), v = mix(uWinRect.z, uWinRect.w, r2);
  if (uWinFace == 0) return vec3(uRoomMax.x, v, u);
  if (uWinFace == 1) return vec3(uRoomMin.x, v, u);
  return vec3(u, uRoomMax.y, v);
}

vec3 windowOutward() {
  if (uWinFace == 0) return vec3(1.0, 0.0, 0.0);
  if (uWinFace == 1) return vec3(-1.0, 0.0, 0.0);
  return vec3(0.0, 1.0, 0.0);
}

bool onScreen(int face, vec3 p) {
  return face == 5 && p.x > uScreenRect.x && p.x < uScreenRect.y && p.y > uScreenRect.z && p.y < uScreenRect.w;
}

vec3 albedo(int face, vec3 p) {
  if (face == 3) return vec3(${FLOOR_ALBEDO.toFixed(3)});
  if (onScreen(face, p)) return vec3(${SCREEN_ALBEDO.toFixed(3)}) * vec3(0.92, 0.96, 1.05);
  return vec3(${WALL_ALBEDO.toFixed(3)});
}

// 窓の外の明るさ（空は上ほど上の色、下は地面）
vec3 outsideRadiance(vec3 d) {
  if (d.y >= 0.0) return mix(uSkyBottom, uSkyTop, sqrt(d.y));
  return uGround;
}

// 太陽の円盤の中の向き（u は 0〜1 の 2 つの値。円盤内に一様）
vec3 sunDirAt(vec2 u) {
  float r = sqrt(u.x) * uSunSinR, phi = 2.0 * PI * u.y;
  vec3 t, b; basis(uSunDir, t, b);
  return normalize(uSunDir + t * r * cos(phi) + b * r * sin(phi));
}

// その向きへの光線が窓を通って外へ出られるか（出られなければ壁の影）
bool seesOutside(vec3 p, vec3 l) {
  int f;
  float t = exitRoom(p, l, f);
  return inWindow(f, p + l * t);
}

// 画面の画素（px）を通るカメラの光線が、部屋のどこに当たるか。カメラが部屋の外なら、部屋に入った所から追う
bool primaryHit(vec2 px, out int face, out vec3 p, out vec3 dir) {
  vec2 ndc = px / uRes * 2.0 - 1.0;
  vec4 v = uProjInv * vec4(ndc, 1.0, 1.0);
  vec3 d = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 o = uCamPos;
  dir = d;
  bool inside = all(greaterThan(o, uRoomMin)) && all(lessThan(o, uRoomMax));
  if (!inside) {
    vec3 dd = safeDir(d);
    vec3 t0 = (uRoomMin - o) / dd, t1 = (uRoomMax - o) / dd;
    vec3 tn = min(t0, t1), tf = max(t0, t1);
    float tNear = max(max(tn.x, tn.y), tn.z), tFar = min(min(tf.x, tf.y), tf.z);
    if (tNear > tFar || tFar < 0.0) return false;
    o += d * (tNear + 1e-3);
  }
  float t = exitRoom(o, d, face);
  p = o + d * t;
  return true;
}
`;

// ---- 段階 1：空の光と照り返しを、光の経路を追って求め、前のフレームまでの平均と重ねる ----
// 保存する値は「その点が受ける光（直射日光を除く）/ π」。反射率は画面に出す段階で掛ける
// （スクリーン面などの色の境目をならしてもぼけないように）
const traceFrag = /* glsl */ `
${common}
uniform sampler2D uPrev;
uniform float uBlend;
uniform float uFrame;
uniform int uBounces;
uniform int uSpp;
in vec2 vUv;
out vec4 fragColor;

uint rngState;
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float rnd() { rngState = pcg(rngState); return float(rngState) * (1.0 / 4294967296.0); }

// 余弦に比例した向き（拡散反射の跳ね返り）
vec3 cosineSample(vec3 n) {
  float u1 = rnd(), u2 = rnd();
  float r = sqrt(u1), phi = 2.0 * PI * u2;
  vec3 t, b; basis(n, t, b);
  return normalize(t * r * cos(phi) + b * r * sin(phi) + n * sqrt(max(0.0, 1.0 - u1)));
}

// 窓から見える空から受ける光（窓の面の 1 点を選ぶ。部屋は凸なので、窓はどこからでも遮られずに見える）
vec3 skyIrradiance(vec3 p, vec3 n) {
  vec3 q = windowPoint(rnd(), rnd());
  vec3 w = q - p;
  float d2 = dot(w, w);
  w *= inversesqrt(d2);
  float cp = dot(n, w), cq = dot(windowOutward(), w);
  if (cp <= 0.0 || cq <= 0.0) return vec3(0.0);
  float area = (uWinRect.y - uWinRect.x) * (uWinRect.w - uWinRect.z);
  return outsideRadiance(w) * cp * cq * area / d2;
}

vec3 sunIrradiance(vec3 p, vec3 n) {
  if (uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  vec3 l = sunDirAt(vec2(rnd(), rnd()));
  float c = dot(n, l);
  return c > 0.0 && seesOutside(p, l) ? uSunE * c : vec3(0.0);
}

vec3 indirect(vec3 p, vec3 n) {
  vec3 acc = skyIrradiance(p, n) / PI;
  vec3 thr = vec3(1.0);
  for (int b = 1; b <= 6; b++) {
    if (b > uBounces) break;
    vec3 d = cosineSample(n);
    int f;
    float t = exitRoom(p, d, f);
    vec3 q = p + d * t;
    if (inWindow(f, q)) break; // 窓から外へ出た光（空の光は skyIrradiance で数えている）
    vec3 n2 = inwardNormal(f);
    vec3 a = albedo(f, q);
    q += n2 * EPS;
    acc += thr * a / PI * (sunIrradiance(q, n2) + skyIrradiance(q, n2));
    thr *= a; // 余弦に比例して向きを選ぶので、反射率を掛けるだけでよい
    p = q;
    n = n2;
  }
  return acc;
}

void main() {
  rngState = pcg(uint(gl_FragCoord.x) + pcg(uint(gl_FragCoord.y) + pcg(uint(uFrame))));
  vec3 sum = vec3(0.0);
  for (int s = 0; s < uSpp; s++) {
    int f; vec3 p, d;
    vec2 px = gl_FragCoord.xy - 0.5 + vec2(rnd(), rnd());
    if (!primaryHit(px, f, p, d) || inWindow(f, p)) continue; // 窓の外と部屋の外は画面に出す段階で描く
    vec3 n = inwardNormal(f);
    sum += indirect(p + n * EPS, n);
  }
  vec3 col = sum / float(uSpp);
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  vec3 prev = texture(uPrev, vUv).rgb;
  fragColor = vec4(mix(prev, col, uBlend), 1.0);
}
`;

// ---- 段階 2：画面に出す。照り返しの成分をならし、反射率と直射日光を加えて、露出 → トーンマッピング → sRGB ----
const displayFrag = /* glsl */ `
${common}
uniform sampler2D uAccum;
uniform float uExposure;
uniform float uStride;      // ならす範囲（画素の間隔）。0 ならならさない
uniform float uSigmaP;      // ならす範囲（部屋の中の距離、m）
in vec2 vUv;
out vec4 fragColor;

// 太陽の円盤の決まった 12 点から、窓を通って届く直射日光（影の縁のぼけは円盤の大きさで決まる）
vec3 sunDirect(vec3 p, vec3 n) {
  if (uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  float sum = 0.0;
  for (int k = 0; k < 12; k++) {
    vec2 u = vec2((float(k) + 0.5) / 12.0, fract(float(k) * 0.618034));
    vec3 l = sunDirAt(u);
    float c = dot(n, l);
    if (c > 0.0 && seesOutside(p, l)) sum += c;
  }
  return uSunE * (sum / 12.0);
}

// 照り返しの成分を、同じ面の近くの画素どうしでならす
vec3 smoothedIndirect(vec2 px, int face, vec3 pc) {
  vec3 center = texture(uAccum, px / uRes).rgb;
  if (uStride <= 0.0) return center;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      vec2 q = px + vec2(float(i), float(j)) * uStride;
      if (q.x < 0.0 || q.y < 0.0 || q.x > uRes.x || q.y > uRes.y) continue;
      int f; vec3 p, d;
      if (!primaryHit(q, f, p, d) || f != face || inWindow(f, p) || onScreen(f, p) != onScreen(face, pc)) continue;
      vec3 dp = p - pc;
      float w = exp(-float(i * i + j * j) / 8.0 - dot(dp, dp) / (2.0 * uSigmaP * uSigmaP));
      sum += w * texture(uAccum, q / uRes).rgb;
      wsum += w;
    }
  }
  return wsum > 0.0 ? sum / wsum : center;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  int fc; vec3 pc, dc;
  bool hitC = primaryHit(px, fc, pc, dc);
  vec3 ind = hitC && !inWindow(fc, pc) ? smoothedIndirect(px, fc, pc) : vec3(0.0);

  // 画素の中の 4 点で、窓の外・反射率・直射日光を求める（縁のギザギザを抑える）
  vec3 col = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(k == 1 || k == 3 ? 0.25 : -0.25, k >= 2 ? 0.25 : -0.25);
    int f; vec3 p, d;
    if (!primaryHit(px + o, f, p, d)) { col += OUTSIDE; continue; }
    if (inWindow(f, p)) { col += outsideRadiance(d); continue; }
    vec3 n = inwardNormal(f);
    vec3 a = albedo(f, p);
    col += a * ind + a / PI * sunDirect(p + n * EPS, n);
  }
  col *= 0.25 * uExposure;
  col = toSrgb(aces(col));
  float nz = fract(sin(dot(px, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  fragColor = vec4(col + nz / 255.0, 1.0);
}
`;

const WINDOW_FACE: Record<WindowSide, number> = { right: 0, left: 1, ceiling: 2 };

export function createRoomScene(
  container: HTMLElement,
  windowSide: WindowSide,
  room: RoomGeometry,
  win: WindowGeometry,
  view?: RoomView,
) {
  const { widthM: W, depthM: D, heightM: H } = room;
  const midZ = -D / 2;
  // 1 フレームで 1 画素あたり追う光線の本数（多いほど早くきれいになるが重い）。URL の ?spp= で変えられる
  const SPP = Math.max(1, Math.min(8, Number(new URLSearchParams(location.search).get('spp') ?? 2) || 2));

  // 鑑賞者の位置（部屋の幅の中央・目の高さ）から、スクリーン（奥の壁、-z）を正面に見る。画面の右 = 鑑賞者の右
  const eyeY = Math.min(1.5, H * 0.5);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 200);
  camera.position.copy(view?.camera ?? new THREE.Vector3(0, eyeY, D * 0.4));

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(1); // 画素数がそのまま計算量になるので、高解像度ディスプレイでも 1 倍で計算する
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(view?.target ?? new THREE.Vector3(0, eyeY, -D));
  controls.maxPolarAngle = Math.PI * 0.6;
  controls.minDistance = 1;
  controls.maxDistance = Math.max(W, D, H) * 4;
  controls.update();

  // 窓の範囲（面上の座標）。壁の窓は奥行きの中央、天窓は天井の中央
  const winRect = windowSide === 'ceiling'
    ? (() => {
      const w = Math.min(win.widthM, W * 0.95) / 2, d = Math.min(win.heightM, D * 0.95) / 2;
      return new THREE.Vector4(-w, w, midZ - d, midZ + d);
    })()
    : (() => {
      const w = Math.min(win.widthM, D * 0.95) / 2;
      const y0 = Math.min(win.sillHeightM, H * 0.9), y1 = Math.min(win.sillHeightM + win.heightM, H * 0.98);
      return new THREE.Vector4(midZ - w, midZ + w, y0, y1);
    })();

  // スクリーン（投影面、32:9）の目印。寸法は未計測なので、奥の壁に収まる大きさ
  const screenW = Math.min(W * 0.8, (H * 0.7 * 32) / 9);
  const screenH = (screenW * 9) / 32;
  const screenCy = Math.max(screenH / 2 + 0.2, eyeY);

  // 計算結果を重ねるバッファ（2 枚を交互に使う）。平均を取り続けるので 32bit 浮動小数が望ましい
  const floatType = renderer.extensions.has('EXT_color_buffer_float') ? THREE.FloatType : THREE.HalfFloatType;
  const makeTarget = (): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(1, 1, {
    type: floatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
  });
  let readT = makeTarget();
  let writeT = makeTarget();

  // 2 つの段階で共通の値（同じオブジェクトを両方の材質から参照する）
  const shared = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uProjInv: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uRoomMin: { value: new THREE.Vector3(-W / 2, 0, -D) },
    uRoomMax: { value: new THREE.Vector3(W / 2, H, 0) },
    uWinFace: { value: WINDOW_FACE[windowSide] },
    uWinRect: { value: winRect },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunSinR: { value: Math.sin((SUN_ANGULAR_RADIUS_DEG * Math.PI) / 180) },
    uSunE: { value: new THREE.Vector3() },
    uSkyTop: { value: new THREE.Vector3() },
    uSkyBottom: { value: new THREE.Vector3() },
    uGround: { value: new THREE.Vector3() },
    uScreenRect: { value: new THREE.Vector4(-screenW / 2, screenW / 2, screenCy - screenH / 2, screenCy + screenH / 2) },
  };
  const traceMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: vert,
    fragmentShader: traceFrag,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      ...shared,
      uPrev: { value: readT.texture },
      uBlend: { value: 1 },
      uFrame: { value: 0 },
      uBounces: { value: 3 },
      uSpp: { value: SPP },
    },
  });
  const displayMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: vert,
    fragmentShader: displayFrag,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      ...shared,
      uAccum: { value: readT.texture },
      uExposure: { value: 1 },
      uStride: { value: 2 },
      uSigmaP: { value: 0.2 },
    },
  });

  // 画面全体を覆う三角形 1 枚
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri, traceMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // 何枚重ねたか。視点や太陽などが変わったら数え直す
  let samples = 0;
  let frame = 0;
  const lastCam = new THREE.Matrix4();
  const lastProj = new THREE.Matrix4();
  const refSun = new THREE.Vector3(0, -1, 0);
  let refKey = '';

  function resize(): void {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    readT.setSize(w, h);
    writeT.setSize(w, h);
    shared.uRes.value.set(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    samples = 0;
  }
  resize();

  function render(input: RoomInput, settings: RoomRenderSettings): void {
    controls.update();
    camera.updateMatrixWorld();
    const { light, sun } = input.solar;

    // 太陽のある方向（光が進む向きの逆）と、大気を通った直射日光の強さ
    const sunDir = toThree(light).negate().normalize();
    const sunOn = sun.altitude > 0;
    const sunE = linear(input.lightColor).multiplyScalar(sunOn ? SUN_SCALE * directSunFactor(sun.altitude) : 0);
    const skyL = SKY_SCALE * skyBrightness(sun.altitude);
    const top = linear(input.sky.top).multiplyScalar(skyL);
    const bottom = linear(input.sky.bottom).multiplyScalar(skyL);
    // 窓の外の地面：日差しと空の光を受けて、反射率ぶんだけ明るい
    const horizSun = sunE.clone().multiplyScalar(Math.max(0, Math.sin((sun.altitude * Math.PI) / 180)));
    const ground = horizSun.add(top.clone().add(bottom).multiplyScalar(0.5 * Math.PI)).multiplyScalar(GROUND_ALBEDO / Math.PI);

    // 重ね合わせのやり直し：視点が動いたら最初から
    const key = `${settings.bounces}`;
    if (!lastCam.equals(camera.matrixWorld) || !lastProj.equals(camera.projectionMatrix) || key !== refKey) {
      samples = 0;
      lastCam.copy(camera.matrixWorld);
      lastProj.copy(camera.projectionMatrix);
      refKey = key;
    }
    // 太陽が 0.06° 動いたら、直近 16 枚ぶんの重みまで下げて新しい太陽に追従させる（照り返しはなだらかなので少し遅れても目立たない）
    if (sunDir.angleTo(refSun) > 1e-3) {
      samples = Math.min(samples, 16);
      refSun.copy(sunDir);
    }

    shared.uSunDir.value.copy(sunDir);
    shared.uSunE.value.copy(sunE);
    shared.uSkyTop.value.copy(top);
    shared.uSkyBottom.value.copy(bottom);
    shared.uGround.value.copy(ground);
    shared.uProjInv.value.copy(camera.projectionMatrixInverse);
    shared.uCamWorld.value.copy(camera.matrixWorld);
    shared.uCamPos.value.copy(camera.position);

    const tu = traceMat.uniforms;
    tu['uBounces']!.value = Math.round(settings.bounces);
    tu['uFrame']!.value = frame++ % 1_000_000;
    tu['uBlend']!.value = 1 / (samples + 1);
    tu['uPrev']!.value = readT.texture;
    quad.material = traceMat;
    renderer.setRenderTarget(writeT);
    renderer.render(quadScene, quadCam);
    [readT, writeT] = [writeT, readT];
    samples = Math.min(samples + 1, 100_000);

    // ならす範囲は、重ねた枚数が増えるほど狭くする（ざらつきが減れば、ならす必要も減る）
    const du = displayMat.uniforms;
    const k = Math.min(1, Math.sqrt(32 / (samples * SPP)));
    du['uAccum']!.value = readT.texture;
    du['uExposure']!.value = settings.exposure;
    du['uStride']!.value = settings.smooth ? Math.max(1, 3 * k) : 0;
    du['uSigmaP']!.value = 0.05 + 0.25 * k;
    quad.material = displayMat;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCam);
  }

  function currentView(): RoomView {
    return { camera: camera.position.clone(), target: controls.target.clone() };
  }

  function dispose(): void {
    controls.dispose();
    tri.dispose();
    traceMat.dispose();
    displayMat.dispose();
    readT.dispose();
    writeT.dispose();
    renderer.dispose();
    renderer.forceContextLoss(); // 作り直しを繰り返しても WebGL コンテキストが溜まらないように
    container.removeChild(renderer.domElement);
  }

  return {
    camera,
    controls,
    render,
    resize,
    currentView,
    dispose,
    /** 1 画素あたり、これまでに追った光線の本数 */
    get samples(): number { return samples * SPP; },
  };
}
