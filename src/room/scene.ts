// room モード：仮想のホワイトボックスの部屋に、計算した日差しをパストレーシングで再現する。
//
// 光を 3 つに分けて計算する：
// - 直射日光：太陽の円盤（0.53°）の各点から窓を通って届くかを、画面に出す段階で毎フレーム確かめる（乱数を使わないので縁がくっきり）
// - 水面で反射・屈折した日差し（光の揺らぎ＝コースティクス）：水面の細かい網目ごとに、日差しが跳ね返って（曲がって）
//   どこに届くかを求め、網目の面積が届いた先でどれだけ縮んだか（光が集まったか）から明るさを出す。毎フレーム計算する
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
import { WATER_ABSORPTION, WATER_GLSL, WATER_IOR, wavePhases } from './water.ts';

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
  /** 窓の外に海を描く（壁の窓のとき） */
  seaView: boolean;
  /** 窓の外の水面で反射した日差しが、窓から入って天井・壁に揺らぎを映す（壁の窓のとき） */
  seaRipples: boolean;
  /** 床に浅い水を張る（水盤） */
  pool: boolean;
  /** 波の強さの倍率 */
  waveAmp: number;
  /** 水盤の深さ（m） */
  poolDepthM: number;
  /** 窓の外の水面の高さ（床を 0 とした m。負なら床より下） */
  seaLevelM: number;
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
const POOL_ALBEDO = 0.62; // 水盤の底（明るい石）
const CAUSTIC_SIZE = 512; // 光の揺らぎを記録する面ごとの画像の大きさ（画素）
const f3 = (n: number): string => n.toFixed(4);

const vert = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ---- 全段階で共通の部分：部屋・窓・太陽・空・水面、カメラの光線 ----
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
uniform int uSeaOn;          // 窓の外に海を描く
uniform float uSeaY;         // 窓の外の水面の高さ
uniform vec3 uSeaBody;       // 水の中から出てくる光（水の色）
uniform int uPoolOn;         // 床の水盤
uniform float uPoolDepth;    // 水盤の深さ

const float PI = 3.14159265358979;
const float EPS = 1e-4;
const float IOR = ${WATER_IOR.toFixed(3)};
const vec3 WATER_ABS = vec3(${WATER_ABSORPTION.map(f3).join(', ')});
const vec3 OUTSIDE = vec3(0.02); // 部屋の外（カメラが外にあり、部屋に当たらない方向）

${WATER_GLSL}

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

// 面の平面（面の外側まで広げたもの）との交点までの距離
float planeT(int face, vec3 o, vec3 d) {
  vec3 dd = safeDir(d);
  if (face == 0) return (uRoomMax.x - o.x) / dd.x;
  if (face == 1) return (uRoomMin.x - o.x) / dd.x;
  if (face == 2) return (uRoomMax.y - o.y) / dd.y;
  if (face == 3) return (uRoomMin.y - o.y) / dd.y;
  if (face == 4) return (uRoomMax.z - o.z) / dd.z;
  return (uRoomMin.z - o.z) / dd.z;
}

// 面の上の位置を 0〜1 の座標に（光の揺らぎの画像を読み書きするため）
vec2 faceUV(int face, vec3 p) {
  vec3 q = (p - uRoomMin) / (uRoomMax - uRoomMin);
  if (face == 0 || face == 1) return vec2(q.z, q.y);
  if (face == 2 || face == 3) return vec2(q.x, q.z);
  return vec2(q.x, q.y);
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

vec3 skyRadiance(vec3 d) {
  return mix(uSkyBottom, uSkyTop, sqrt(max(d.y, 0.0)));
}

// 太陽の円盤に向かう向きほど強い、鋭い山（水面に映る太陽のきらめき）。面積で割ってあるので、放射照度を掛けると放射輝度になる
float sunLobe(vec3 r) {
  return pow(max(dot(r, uSunDir), 0.0), 3000.0) * (3002.0 / (2.0 * PI));
}

// 窓の外の海：点 o から向き d（下向き）で見た水面の明るさ。空の映り込み・太陽のきらめき・水の色を、反射の割合で混ぜる
vec3 seaRadiance(vec3 o, vec3 d) {
  float t = (uSeaY - o.y) / min(d.y, -1e-4);
  vec3 x = o + d * t;
  vec3 n = waveNormal(seaWave(x.xz) + fineWave(x.xz));
  float F = fresnelWater(dot(-d, n));
  vec3 r = reflect(d, n);
  r.y = abs(r.y);
  vec3 c = F * (skyRadiance(r) + uSunE * sunLobe(r)) + (1.0 - F) * uSeaBody;
  // 遠くはかすんで、地平線の空の色に近づく
  return mix(c, skyRadiance(normalize(vec3(d.x, 0.02, d.z))), 1.0 - exp(-t / 600.0));
}

// 窓の外の明るさ：上は空、下は海（オフなら地面）
vec3 outsideRadiance(vec3 o, vec3 d) {
  if (d.y >= 0.0) return skyRadiance(d);
  return uSeaOn == 1 ? seaRadiance(o, d) : uGround;
}

// 空の光を部屋に取り込む計算用：波やきらめきを平均した明るさ（水面で反射した日差しは、光の揺らぎとして別に数える）
vec3 outsideRadianceAvg(vec3 d) {
  if (d.y >= 0.0) return skyRadiance(d);
  if (uSeaOn == 0) return uGround;
  float F = fresnelWater(-d.y);
  return F * skyRadiance(vec3(d.x, -d.y, d.z)) + (1.0 - F) * uSeaBody;
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

// 光の揺らぎの画像を読む（段階 1・2 で使う）。値は「直射日光の何倍の光が届いているか」
const causticRead = /* glsl */ `
uniform int uCausOn;
uniform sampler2D uCaus0;
uniform sampler2D uCaus1;
uniform sampler2D uCaus2;
uniform sampler2D uCaus4;
uniform sampler2D uCaus5;
uniform sampler2D uCausB;
// 太陽には大きさ（0.53°）があるので、水面から数 m 先に届く光の模様は数 cm ぼける。その程度に近くの 5 点を平均する
const float CAUS_TEXEL = ${(1 / CAUSTIC_SIZE).toFixed(6)};
float blurTap(sampler2D s, vec2 uv) {
  vec2 o = vec2(1.2 * CAUS_TEXEL);
  return (2.0 * texture(s, uv).r + texture(s, uv + o).r + texture(s, uv - o).r
    + texture(s, uv + vec2(o.x, -o.y)).r + texture(s, uv + vec2(-o.x, o.y)).r) / 6.0;
}
float causticAt(int face, vec3 p) {
  if (uCausOn == 0) return 0.0;
  vec2 uv = faceUV(face, p);
  if (face == 0) return blurTap(uCaus0, uv);
  if (face == 1) return blurTap(uCaus1, uv);
  if (face == 2) return blurTap(uCaus2, uv);
  if (face == 4) return blurTap(uCaus4, uv);
  if (face == 5) return blurTap(uCaus5, uv);
  return 0.0;
}
// 水盤の底に屈折して届く日差し（底は水面から近いので、ぼけは小さい）
float causticBottom(vec3 p) {
  return uCausOn == 0 ? 0.0 : texture(uCausB, faceUV(3, p)).r;
}
`;

// ---- 段階 0：水面の光の揺らぎ（コースティクス）----
// 水面の網目の各点で、日差しを反射（屈折）させた先を求め、その面の画像の上に網目を描き直す。
// 網目が小さく縮んだ所ほど光が集まって明るい（明るさ = 元の網目の面積 / 届いた先の面積）。重なった所は足し合わせる
const causticVert = /* glsl */ `
${common}
uniform vec3 uGridO;
uniform vec3 uGridU;
uniform vec3 uGridV;
uniform float uWaterY;
uniform int uSource;   // 0 = 水盤、1 = 窓の外の水面
uniform int uMode;     // 0 = 反射、1 = 屈折
uniform int uTarget;   // 0〜5 = 部屋の面、6 = 水盤の底
out vec3 vOld;
out vec3 vNew;
out float vW;
void main() {
  vec3 p0 = uGridO + uv.x * uGridU + uv.y * uGridV;
  vec3 hw = uSource == 0 ? poolWave(p0.xz) : seaWave(p0.xz);
  vec3 n = waveNormal(hw);
  vec3 p = vec3(p0.x, uWaterY + hw.x, p0.z);
  float ci = dot(n, uSunDir);
  float F = fresnelWater(ci);
  vec3 L = uMode == 1 ? refract(-uSunDir, n, 1.0 / IOR) : reflect(-uSunDir, n);
  // 水面が受ける日差しの量（傾きの余弦）× 反射または屈折する割合
  float w = max(ci, 0.0) * (uMode == 1 ? 1.0 - F : F);
  vec3 o;
  if (uSource == 0) {
    // 水盤：その点に日差しが窓から届いているか
    o = vec3(p.x, max(p.y, 0.0) + 1e-3, p.z);
    if (!seesOutside(o, uSunDir)) w = 0.0;
    if (uMode == 1) o = vec3(p.x, min(p.y, 0.0), p.z);
  } else {
    // 窓の外の水面：反射した光が窓の開口を通るか
    float wx = uWinFace == 0 ? uRoomMax.x : uRoomMin.x;
    float t = (wx - p.x) / (abs(L.x) < 1e-6 ? 1e-6 : L.x);
    vec3 q = p + L * t;
    if (!(t > 0.0 && q.z > uWinRect.x && q.z < uWinRect.y && q.y > uWinRect.z && q.y < uWinRect.w)) w = 0.0;
    o = q + L * 1e-3;
  }
  vec3 x;
  vec2 tuv;
  if (uTarget == 6) {
    float t = clamp((-uPoolDepth - o.y) / min(L.y, -1e-4), 0.0, 1e3);
    x = o + L * t;
    tuv = faceUV(3, x);
  } else {
    int f;
    exitRoom(o, L, f);
    if (f != uTarget) w = 0.0;
    float t = clamp(planeT(uTarget, o, L), 0.0, 1e3);
    x = o + L * t;
    tuv = faceUV(uTarget, x);
  }
  vOld = p0;
  vNew = x;
  vW = w;
  gl_Position = vec4(tuv * 2.0 - 1.0, 0.0, 1.0);
}
`;
const causticFrag = /* glsl */ `
precision highp float;
in vec3 vOld;
in vec3 vNew;
in float vW;
out vec4 fragColor;
void main() {
  float oldA = length(cross(dFdx(vOld), dFdy(vOld)));
  float newA = length(cross(dFdx(vNew), dFdy(vNew)));
  fragColor = vec4(min(vW * oldA / max(newA, 1e-9), 60.0), 0.0, 0.0, 1.0);
}
`;

// ---- 段階 1：空の光と照り返しを、光の経路を追って求め、前のフレームまでの平均と重ねる ----
// 保存する値は「その点が受ける光（直射日光と、画面に出す段階で足す光の揺らぎを除く）/ π」。
// 反射率は画面に出す段階で掛ける（スクリーン面などの色の境目をならしてもぼけないように）
const traceFrag = /* glsl */ `
${common}
${causticRead}
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

// 窓から見える空（と海）から受ける光（窓の面の 1 点を選ぶ。部屋は凸なので、窓はどこからでも遮られずに見える）
vec3 skyIrradiance(vec3 p, vec3 n) {
  vec3 q = windowPoint(rnd(), rnd());
  vec3 w = q - p;
  float d2 = dot(w, w);
  w *= inversesqrt(d2);
  float cp = dot(n, w), cq = dot(windowOutward(), w);
  if (cp <= 0.0 || cq <= 0.0) return vec3(0.0);
  float area = (uWinRect.y - uWinRect.x) * (uWinRect.w - uWinRect.z);
  return outsideRadianceAvg(w) * cp * cq * area / d2;
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
    vec3 a;
    vec3 e;
    q += n2 * EPS;
    if (uPoolOn == 1 && f == 3) {
      // 水盤の底：屈折して届いた日差し（光の揺らぎ）を、水に吸収されながら返す
      vec3 absorb = exp(-WATER_ABS * 2.0 * uPoolDepth);
      a = vec3(${POOL_ALBEDO.toFixed(3)}) * absorb;
      e = uSunE * causticBottom(q) + skyIrradiance(q, n2);
    } else {
      a = albedo(f, q);
      e = sunIrradiance(q, n2) + uSunE * causticAt(f, q) + skyIrradiance(q, n2);
    }
    acc += thr * a / PI * e;
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

// ---- 段階 2：画面に出す。照り返しの成分をならし、反射率・直射日光・光の揺らぎを加えて、露出 → トーンマッピング → sRGB ----
const displayFrag = /* glsl */ `
${common}
${causticRead}
uniform sampler2D uAccum;
uniform float uExposure;
uniform float uStride;      // ならす範囲（画素の間隔）。0 ならならさない
uniform float uSigmaP;      // ならす範囲（部屋の中の距離、m）
uniform mat4 uViewProj;
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

// 水面に映った部屋の面の明るさ（照り返しの成分は、その点が画面に映っていればその画素の値を使う）
vec3 surfaceRadiance(int f, vec3 q, vec3 fallback) {
  vec3 n = inwardNormal(f);
  vec3 a = albedo(f, q);
  vec3 ind = fallback;
  vec4 c = uViewProj * vec4(q, 1.0);
  if (c.w > 0.0) {
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) ind = texture(uAccum, uv).rgb;
  }
  return a * ind + a / PI * (sunDirect(q + n * EPS, n) + uSunE * causticAt(f, q));
}

// 水盤：水面で反射する光と、屈折して底から戻る光を、反射の割合（フレネル）で混ぜる
vec3 poolRadiance(vec3 p, vec3 d, vec3 ind) {
  vec3 n = waveNormal(poolWave(p.xz));
  float F = fresnelWater(dot(-d, n));
  // 屈折して底へ。水に吸収されて、深いほど青緑になる（見る光の道のりと、日差しが底まで届く道のり）
  vec3 rd = refract(d, n, 1.0 / IOR);
  float tb = (-uPoolDepth - p.y) / min(rd.y, -1e-3);
  vec3 b = p + rd * tb;
  vec3 absorb = exp(-WATER_ABS * (tb + uPoolDepth));
  vec3 lb = vec3(${POOL_ALBEDO.toFixed(3)}) / PI * (uSunE * causticBottom(b) + PI * ind) * absorb;
  // 反射：窓の外（空・海と、映り込んだ太陽のきらめき）か、部屋の面
  vec3 rr = reflect(d, n);
  vec3 o = vec3(p.x, EPS, p.z);
  int f2;
  float t2 = exitRoom(o, rr, f2);
  vec3 q = o + rr * t2;
  vec3 lr = inWindow(f2, q) ? outsideRadiance(q, rr) + uSunE * sunLobe(rr) : surfaceRadiance(f2, q, ind);
  return (1.0 - F) * lb + F * lr;
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

  // 画素の中の 4 点で、窓の外・反射率・直射日光・光の揺らぎを求める（縁のギザギザを抑える）
  vec3 col = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(k == 1 || k == 3 ? 0.25 : -0.25, k >= 2 ? 0.25 : -0.25);
    int f; vec3 p, d;
    if (!primaryHit(px + o, f, p, d)) { col += OUTSIDE; continue; }
    if (inWindow(f, p)) { col += outsideRadiance(p, d); continue; }
    if (uPoolOn == 1 && f == 3) { col += poolRadiance(p, d, ind); continue; }
    vec3 n = inwardNormal(f);
    vec3 a = albedo(f, p);
    col += a * ind + a / PI * (sunDirect(p + n * EPS, n) + uSunE * causticAt(f, p));
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
  renderer.autoClear = false;
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

  // 光の揺らぎの画像（面ごと）。0 = 右の壁、1 = 左の壁、2 = 天井、4 = 手前、5 = 奥、6 = 水盤の底
  const causticTargets = new Map<number, THREE.WebGLRenderTarget>();
  for (const face of [0, 1, 2, 4, 5, 6]) {
    causticTargets.set(face, new THREE.WebGLRenderTarget(CAUSTIC_SIZE, CAUSTIC_SIZE, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    }));
  }
  const causTex = (face: number): THREE.Texture => causticTargets.get(face)!.texture;

  const phases = wavePhases(0);
  // 全段階で共通の値（同じオブジェクトを各材質から参照する）
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
    uSeaOn: { value: 0 },
    uSeaY: { value: -1 },
    uSeaBody: { value: new THREE.Vector3() },
    uPoolOn: { value: 0 },
    uPoolDepth: { value: 0.3 },
    uWaveAmp: { value: 1 },
    uPOOLPh: { value: phases.pool },
    uSEAPh: { value: phases.sea },
    uFINEPh: { value: phases.fine },
  };
  const causticUniforms = {
    uCausOn: { value: 0 },
    uCaus0: { value: causTex(0) },
    uCaus1: { value: causTex(1) },
    uCaus2: { value: causTex(2) },
    uCaus4: { value: causTex(4) },
    uCaus5: { value: causTex(5) },
    uCausB: { value: causTex(6) },
  };
  const traceMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: vert,
    fragmentShader: traceFrag,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      ...shared,
      ...causticUniforms,
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
      ...causticUniforms,
      uAccum: { value: readT.texture },
      uExposure: { value: 1 },
      uStride: { value: 2 },
      uSigmaP: { value: 0.2 },
      uViewProj: { value: new THREE.Matrix4() },
    },
  });
  const causticMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: causticVert,
    fragmentShader: causticFrag,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide, // 届いた先で網目が裏返ることがある
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    uniforms: {
      ...shared,
      uGridO: { value: new THREE.Vector3() },
      uGridU: { value: new THREE.Vector3() },
      uGridV: { value: new THREE.Vector3() },
      uWaterY: { value: 0 },
      uSource: { value: 0 },
      uMode: { value: 0 },
      uTarget: { value: 0 },
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

  // 水面の網目（uv だけ使う）。網目の大きさは、光の揺らぎの画像の画素の 2 倍程度（小さすぎると描き漏れが出る）
  const poolGrid = new THREE.PlaneGeometry(1, 1, 256, Math.max(32, Math.round((256 * D) / W)));
  const seaGrid = new THREE.PlaneGeometry(1, 1, 220, 220);
  const gridMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>(poolGrid, causticMat);
  gridMesh.frustumCulled = false;
  const gridScene = new THREE.Scene();
  gridScene.add(gridMesh);

  // 窓の外の水面のうち、反射した日差しが窓を通る範囲（窓の四隅から、反射した光の向きを逆にたどって水面に下ろす）
  function seaPatch(sunDir: THREE.Vector3, seaY: number): { o: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 } | null {
    if (windowSide === 'ceiling' || sunDir.y < 0.02) return null;
    const r = new THREE.Vector3(-sunDir.x, sunDir.y, -sunDir.z); // 平らな水面で反射した光の進む向き
    const wx = windowSide === 'right' ? W / 2 : -W / 2;
    if ((windowSide === 'right' && r.x >= 0) || (windowSide === 'left' && r.x <= 0)) return null; // 太陽が窓の側にない
    const down = (y: number, z: number): THREE.Vector3 => {
      const c = new THREE.Vector3(wx, y, z);
      return c.addScaledVector(r, -(y - seaY) / r.y);
    };
    const [z0, z1, y0, y1] = [winRect.x, winRect.y, winRect.z, winRect.w];
    const a = down(y0, z0), b = down(y0, z1), c = down(y1, z0);
    const u = b.clone().sub(a), v = c.clone().sub(a);
    // 波で光の向きがずれるぶん、少し広めにとる
    const center = a.clone().addScaledVector(u, 0.5).addScaledVector(v, 0.5);
    u.multiplyScalar(1.4);
    v.multiplyScalar(1.4);
    const o = center.addScaledVector(u, -0.5).addScaledVector(v, -0.5);
    return { o, u, v };
  }

  function renderCaustics(sunDir: THREE.Vector3, sunOn: boolean, settings: RoomRenderSettings): void {
    const passes: { grid: THREE.BufferGeometry; source: number; mode: number; target: number; o: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; y: number }[] = [];
    if (sunOn && settings.pool) {
      const o = new THREE.Vector3(-W / 2, 0, -D), u = new THREE.Vector3(W, 0, 0), v = new THREE.Vector3(0, 0, D);
      for (const target of [0, 1, 2, 4, 5]) passes.push({ grid: poolGrid, source: 0, mode: 0, target, o, u, v, y: 0 });
      passes.push({ grid: poolGrid, source: 0, mode: 1, target: 6, o, u, v, y: 0 });
    }
    const patch = sunOn && settings.seaRipples ? seaPatch(sunDir, settings.seaLevelM) : null;
    if (patch) {
      for (const target of [0, 1, 2, 4, 5]) passes.push({ grid: seaGrid, source: 1, mode: 0, target, ...patch, y: settings.seaLevelM });
    }
    const cu = causticMat.uniforms;
    renderer.setClearColor(0x000000, 0);
    for (const [face, rt] of causticTargets) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
      for (const p of passes) {
        if (p.target !== face) continue;
        gridMesh.geometry = p.grid;
        cu['uGridO']!.value.copy(p.o);
        cu['uGridU']!.value.copy(p.u);
        cu['uGridV']!.value.copy(p.v);
        cu['uWaterY']!.value = p.y;
        cu['uSource']!.value = p.source;
        cu['uMode']!.value = p.mode;
        cu['uTarget']!.value = p.target;
        renderer.render(gridScene, quadCam);
      }
    }
  }

  // 何枚重ねたか。視点や太陽などが変わったら数え直す
  let samples = 0;
  let frame = 0;
  const lastCam = new THREE.Matrix4();
  const lastProj = new THREE.Matrix4();
  const refSun = new THREE.Vector3(0, -1, 0);
  let refKey = '';
  const t0 = performance.now();

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

    // 重ね合わせのやり直し：視点や設定が変わったら最初から
    const key = [settings.bounces, settings.seaView, settings.seaRipples, settings.pool, settings.waveAmp, settings.poolDepthM, settings.seaLevelM].join();
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

    // 波は実際の時間で動かす（早送りしても波の速さは変わらない）
    const ph = wavePhases((performance.now() - t0) / 1000);
    shared.uPOOLPh.value = ph.pool;
    shared.uSEAPh.value = ph.sea;
    shared.uFINEPh.value = ph.fine;
    shared.uWaveAmp.value = settings.waveAmp;
    shared.uSeaOn.value = settings.seaView && windowSide !== 'ceiling' ? 1 : 0;
    shared.uSeaY.value = settings.seaLevelM;
    shared.uSeaBody.value.set(0.12, 0.35, 0.42).multiplyScalar(skyL * 0.25);
    shared.uPoolOn.value = settings.pool ? 1 : 0;
    shared.uPoolDepth.value = settings.poolDepthM;
    causticUniforms.uCausOn.value = settings.pool || (settings.seaRipples && windowSide !== 'ceiling') ? 1 : 0;

    shared.uSunDir.value.copy(sunDir);
    shared.uSunE.value.copy(sunE);
    shared.uSkyTop.value.copy(top);
    shared.uSkyBottom.value.copy(bottom);
    shared.uGround.value.copy(ground);
    shared.uProjInv.value.copy(camera.projectionMatrixInverse);
    shared.uCamWorld.value.copy(camera.matrixWorld);
    shared.uCamPos.value.copy(camera.position);

    // 段階 0：水面の光の揺らぎ
    renderCaustics(sunDir, sunOn, settings);

    // 段階 1：空の光と照り返し
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

    // 段階 2：画面に出す。ならす範囲は、重ねた枚数が増えるほど狭くする
    const du = displayMat.uniforms;
    const k = Math.min(1, Math.sqrt(32 / (samples * SPP)));
    du['uAccum']!.value = readT.texture;
    du['uExposure']!.value = settings.exposure;
    du['uStride']!.value = settings.smooth ? Math.max(1, 3 * k) : 0;
    du['uSigmaP']!.value = 0.05 + 0.25 * k;
    du['uViewProj']!.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
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
    poolGrid.dispose();
    seaGrid.dispose();
    traceMat.dispose();
    displayMat.dispose();
    causticMat.dispose();
    readT.dispose();
    writeT.dispose();
    for (const rt of causticTargets.values()) rt.dispose();
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
