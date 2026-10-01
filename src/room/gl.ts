// room モードを WebGL2（three.js）で描く。シェーダーは GLSL。
// 同じ計算の WebGPU 版は src/room/gpu.ts（WGSL）。どちらも src/room/core.ts が決めた値で描く
import * as THREE from 'three';
import { GLSL_SIMPLEX3, glPass } from '../scenes/shader.ts';
import type { SceneInstance } from '../scenes/types.ts';
import { CAUSTIC_FACES, CAUSTIC_SIZE, FLOOR_ALBEDO, POOL_ALBEDO, SCREEN_ALBEDO, SCREEN_IMAGE, WALL_ALBEDO, type RoomCore, type RoomFrame } from './core.ts';
import { MAX_SPOTS, type RoomScreenImage } from './model.ts';
import { WATER_ABSORPTION, WATER_GLSL, WATER_IOR } from './water.ts';

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
uniform int uCloudOn;        // 窓の外の空に雲
uniform int uCloudShadow;    // 雲が日差しをさえぎる
uniform float uCloudY;       // 雲の高さ（m）
uniform float uCloudScale;   // 1 / 雲のかたまりの大きさ（1/m）
uniform float uCloudAmount, uCloudContrast, uCloudOpacity;
uniform vec3 uCloudOffA, uCloudOffB;  // 雲の流れ（xy）と形の変化（z）。B は巻き戻した後の同じ動き
uniform float uCloudBlend;
uniform int uScreenOn;       // スクリーンに映像を映す
uniform sampler2D uScreenTex;
uniform float uScreenGain;
uniform vec2 uScreenOut;     // 映像の出力の明るさの範囲（下限・上限）
const int MAX_SPOTS = ${MAX_SPOTS};
uniform float uSpotCount;            // 点いている鑑賞者の頭上のスポットライトの台数（0 = 消えている）
uniform vec3 uSpotPos[MAX_SPOTS];    // ライトの位置
uniform vec3 uSpotDir[MAX_SPOTS];    // ライトの向き
uniform vec3 uSpotI[MAX_SPOTS];      // 光度（色 × 強さ × 点き具合）
uniform vec2 uSpotCos[MAX_SPOTS];    // 円すいの縁の cos（外側・内側）
uniform float uSpotR;                // 器具の大きさ（球の半径）

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

${GLSL_SIMPLEX3}
// 雲の濃さ（0〜1）。visuals の「光の雲」と同じ作り方（大きさを約半分ずつにしたノイズの重ね合わせ）を、空の水平な面の上に置く
float cloudSum(vec2 q, vec3 off, int octaves) {
  float s = 0.0, a = 0.55, f = 1.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    s += a * snoise(vec3((q + off.xy) * f + vec2(17.3, -9.1) * float(i), off.z * (1.0 + 0.35 * float(i))));
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}
float cloudDensity(vec2 xz, int octaves) {
  vec2 q = xz * uCloudScale;
  float s = cloudSum(q, uCloudOffA, octaves);
  if (uCloudBlend > 0.0) {
    float w = uCloudBlend;
    s = (s * (1.0 - w) + cloudSum(q, uCloudOffB, octaves) * w) / sqrt((1.0 - w) * (1.0 - w) + w * w);
  }
  // 雲の量でしきい値を決め、それより濃い所を雲にする（量 0 で快晴、1 で全天の雲）。境目は少しぼかす
  float d = 0.5 + 0.5 * s * uCloudContrast;
  float th = 0.8 - 0.6 * uCloudAmount;
  return smoothstep(th - 0.12, th + 0.12, d);
}
// 日差しが雲を通り抜ける割合。点 p から太陽の向きへ進んで雲の高さに届いた所の濃さで決める
// （雲の影の縁は数十〜数百 m の幅でぼけるので、細かい層は省いて 3 層で求める）
float cloudTrans(vec3 p) {
  if (uCloudOn == 0 || uCloudShadow == 0 || uSunDir.y <= 0.0) return 1.0;
  float t = (uCloudY - p.y) / max(uSunDir.y, 0.02);
  return 1.0 - uCloudOpacity * cloudDensity(p.xz + uSunDir.xz * t, 3);
}
// 雲のある空：点 o から向き d（上向き）に見える空の明るさ
vec3 cloudySky(vec3 o, vec3 d) {
  vec3 sky = skyRadiance(d);
  if (uCloudOn == 0 || d.y <= 0.0) return sky;
  float t = (uCloudY - o.y) / max(d.y, 1e-3);
  float dens = cloudDensity(o.xz + d.xz * t, 5);
  // 地平線に近い雲は遠すぎて、空気でかすむ
  float alpha = uCloudOpacity * dens * smoothstep(0.02, 0.2, d.y);
  // 雲の明るさ：日差しを受けて白く光り（太陽に近い向きほど明るい：前方散乱）、厚い所ほど暗い。空の光も受ける
  float fwd = pow(max(dot(d, uSunDir), 0.0), 6.0);
  vec3 lit = uSunE * (0.16 + 0.6 * fwd) * (1.0 - 0.45 * dens) + 0.5 * (uSkyTop + uSkyBottom);
  return mix(sky, lit, alpha);
}

// スクリーンに映した映像が出す光（放射輝度）。lod < 0 なら画面の画素の大きさに合わせてぼかす
vec3 screenLight(int face, vec3 p, float lod) {
  if (uScreenOn == 0 || !onScreen(face, p)) return vec3(0.0);
  vec2 uv = vec2((p.x - uScreenRect.x) / (uScreenRect.y - uScreenRect.x), (p.y - uScreenRect.z) / (uScreenRect.w - uScreenRect.z));
  vec3 c = lod < 0.0 ? texture(uScreenTex, uv).rgb : textureLod(uScreenTex, uv, lod).rgb;
  c = clamp(c, uScreenOut.x, uScreenOut.y);
  return uScreenGain * pow(c, vec3(2.2)); // 映像の色（sRGB）→ 光の強さ（線形）
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
  vec3 c = F * (cloudySky(x, r) + uSunE * sunLobe(r) * cloudTrans(x)) + (1.0 - F) * uSeaBody;
  // 遠くはかすんで、地平線の空の色に近づく
  return mix(c, skyRadiance(normalize(vec3(d.x, 0.02, d.z))), 1.0 - exp(-t / 600.0));
}

// 窓の外の明るさ：上は空、下は海（オフなら地面）
vec3 outsideRadiance(vec3 o, vec3 d) {
  if (d.y >= 0.0) return cloudySky(o, d);
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


// 鑑賞者の頭上のスポットライト（点光源 ＋ 円すいの広がり）。最大 MAX_SPOTS 台を足し合わせる。
// 部屋は中に物のない箱なので、部屋の中のどの点にも遮られずに届く
vec3 spotOne(int i, vec3 p, vec3 n) {
  vec3 l = uSpotPos[i] - p;
  float d2 = max(dot(l, l), 1e-4);
  l *= inversesqrt(d2);
  float c = dot(n, l);
  if (c <= 0.0) return vec3(0.0);
  float cone = smoothstep(uSpotCos[i].x, uSpotCos[i].y, dot(-l, uSpotDir[i]));
  return uSpotI[i] * (cone * c / d2);
}
vec3 spotIrradiance(vec3 p, vec3 n) {
  vec3 e = vec3(0.0);
  for (int i = 0; i < MAX_SPOTS; i++) {
    if (float(i) >= uSpotCount) break;
    e += spotOne(i, p, n);
  }
  return e;
}
// 水盤の底に届くスポットライト。水面で屈折して入る（向きの曲がりは省き、水に入る割合と、底までの水の吸収を掛ける）
vec3 spotBottom(vec3 b) {
  vec3 e = vec3(0.0);
  for (int i = 0; i < MAX_SPOTS; i++) {
    if (float(i) >= uSpotCount) break;
    vec3 l = normalize(uSpotPos[i] - b);
    e += spotOne(i, b, vec3(0.0, 1.0, 0.0)) * exp(-WATER_ABS * uPoolDepth / max(l.y, 0.2));
  }
  return e * 0.97;
}
// 光線がライトの器具（小さな球）に当たれば、いちばん手前の器具の明るさ。
// 光を出すのは、向いている側（器具の口）だけで、後ろ側は暗い灰色の器具
vec3 spotLamp(vec3 o, vec3 d, float tMax) {
  vec3 col = vec3(0.0);
  float best = tMax;
  for (int i = 0; i < MAX_SPOTS; i++) {
    if (float(i) >= uSpotCount) break;
    vec3 oc = o - uSpotPos[i];
    float b = dot(oc, d);
    float h = b * b - (dot(oc, oc) - uSpotR * uSpotR);
    if (h < 0.0) continue;
    float t = -b - sqrt(h);
    if (t < 0.0 || t > best) continue;
    best = t;
    vec3 nn = normalize(o + d * t - uSpotPos[i]);
    col = max(uSpotI[i] / (PI * uSpotR * uSpotR) * smoothstep(-0.2, 0.4, dot(nn, uSpotDir[i])), vec3(0.01));
  }
  return col;
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
  float w = max(ci, 0.0) * (uMode == 1 ? 1.0 - F : F) * cloudTrans(p);
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
// 窓から入る空の光。2 通りの選び方を混ぜる（多重重点サンプリング、バランス・ヒューリスティック）
// - 窓の中の点を選ぶ（skyNee）：小さい窓に強い。ただし窓のすぐ近くの点では「面積 ÷ 距離²」が極端に大きくなり、
//   これだけだと白い点（ファイアフライ）が出る（天井いっぱいの天窓の、壁の上の縁など）
// - 照り返しの光線（余弦に比例した向き）がそのまま窓から外へ出たとき（skyBsdf）：大きい窓に強い
// どちらも「光 × cos ÷（2 つの確率密度の和）」で数えるので、1 回の値は「光 × π」を超えず、平均の明るさは変わらない。
// 照り返しの光線は、もともと追っているものを使う（足す光線は、最後の点の 1 本だけ。indirect）
float windowPdf(vec3 w, float d2) {
  // 窓の点を一様に選んだときの、方向あたりの確率密度
  float area = (uWinRect.y - uWinRect.x) * (uWinRect.w - uWinRect.z);
  return d2 / (max(dot(windowOutward(), w), 1e-6) * area);
}
// 窓の中の点を選んで数える空の光（放射照度。π で割ると、拡散面が返す光になる）
vec3 skyNee(vec3 p, vec3 n) {
  vec3 q = windowPoint(rnd(), rnd());
  vec3 w = q - p;
  float d2 = dot(w, w);
  w *= inversesqrt(d2);
  float cp = dot(n, w), cq = dot(windowOutward(), w);
  if (cp <= 0.0 || cq <= 0.0) return vec3(0.0);
  return outsideRadianceAvg(w) * cp / (windowPdf(w, d2) + cp / PI);
}
// 照り返しの光線 d が窓から外へ出たとき（t = 窓までの距離）に数える空の光（拡散面が返す光、skyNee / π と同じ単位）
vec3 skyBsdf(vec3 n, vec3 d, float t) {
  float pc = dot(n, d) / PI;
  return outsideRadianceAvg(d) * pc / (windowPdf(d, t * t) + pc);
}

vec3 sunIrradiance(vec3 p, vec3 n) {
  if (uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  vec3 l = sunDirAt(vec2(rnd(), rnd()));
  float c = dot(n, l);
  return c > 0.0 && seesOutside(p, l) ? uSunE * (c * cloudTrans(p)) : vec3(0.0);
}

vec3 indirect(vec3 p, vec3 n) {
  vec3 acc = skyNee(p, n) / PI;
  vec3 thr = vec3(1.0);
  // b 回目の光線で照り返しを 1 回たどる。照り返しの回数ぶんたどった後の 1 本は、空の光の 2 つ目の見本（skyBsdf）だけに使う
  for (int b = 0; b <= 6; b++) {
    vec3 d = cosineSample(n);
    int f;
    float t = exitRoom(p, d, f);
    vec3 q = p + d * t;
    if (inWindow(f, q)) { acc += thr * skyBsdf(n, d, t); break; } // 窓から外へ出た：空の光の 2 つ目の見本
    if (b >= uBounces) break;
    acc += thr * screenLight(f, q, 5.0); // スクリーンに映した映像の光が、部屋をほんのり照らす（照り返しと同じくぼけた光）
    vec3 n2 = inwardNormal(f);
    vec3 a;
    vec3 e;
    q += n2 * EPS;
    if (uPoolOn == 1 && f == 3) {
      // 水盤の底：屈折して届いた日差し（光の揺らぎ）を、水に吸収されながら返す
      vec3 absorb = exp(-WATER_ABS * 2.0 * uPoolDepth);
      a = vec3(${POOL_ALBEDO.toFixed(3)}) * absorb;
      e = uSunE * causticBottom(q) + skyNee(q, n2) + spotIrradiance(q, n2) * 0.97;
    } else {
      a = albedo(f, q);
      e = sunIrradiance(q, n2) + uSunE * causticAt(f, q) + skyNee(q, n2) + spotIrradiance(q, n2);
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
  return sum > 0.0 ? uSunE * (sum / 12.0 * cloudTrans(p)) : vec3(0.0);
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
  return a * ind + a / PI * (sunDirect(q + n * EPS, n) + uSunE * causticAt(f, q) + spotIrradiance(q + n * EPS, n)) + screenLight(f, q, 2.0);
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
  vec3 lb = vec3(${POOL_ALBEDO.toFixed(3)}) / PI * ((uSunE * causticBottom(b) + PI * ind) * absorb + spotBottom(b) * exp(-WATER_ABS * tb));
  // 反射：窓の外（空・海と、映り込んだ太陽のきらめき）か、部屋の面
  vec3 rr = reflect(d, n);
  vec3 o = vec3(p.x, EPS, p.z);
  int f2;
  float t2 = exitRoom(o, rr, f2);
  vec3 q = o + rr * t2;
  vec3 lr = inWindow(f2, q) ? outsideRadiance(q, rr) + uSunE * sunLobe(rr) * cloudTrans(q) : surfaceRadiance(f2, q, ind);
  lr += spotLamp(o, rr, t2); // 水面に映るライトのきらめき
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
    vec3 lamp = spotLamp(uCamPos, d, distance(uCamPos, p)); // ライトの器具そのもの
    if (lamp.x + lamp.y + lamp.z > 0.0) { col += lamp; continue; }
    if (inWindow(f, p)) { col += outsideRadiance(p, d); continue; }
    if (uPoolOn == 1 && f == 3) { col += poolRadiance(p, d, ind); continue; }
    vec3 n = inwardNormal(f);
    vec3 a = albedo(f, p);
    col += a * ind + a / PI * (sunDirect(p + n * EPS, n) + uSunE * causticAt(f, p) + spotIrradiance(p + n * EPS, n)) + screenLight(f, p, -1.0);
  }
  col *= 0.25 * uExposure;
  col = toSrgb(aces(col));
  float nz = fract(sin(dot(px, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  fragColor = vec4(col + nz / 255.0, 1.0);
}
`;

/** room モードを描く方式（WebGL2 版・WebGPU 版で共通） */
export interface RoomRenderer {
  readonly canvas: HTMLCanvasElement;
  resize(w: number, h: number): void;
  render(frame: RoomFrame): void;
  /** 積んだ描画の命令を GPU が終えるまで待つ（重さを測るため） */
  finish(): Promise<void>;
  dispose(): void;
}

export class GlRoomRenderer implements RoomRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readT: THREE.WebGLRenderTarget;
  private writeT: THREE.WebGLRenderTarget;
  private readonly causticTargets = new Map<number, THREE.WebGLRenderTarget>();
  private readonly traceMat: THREE.ShaderMaterial;
  private readonly displayMat: THREE.ShaderMaterial;
  private readonly causticMat: THREE.ShaderMaterial;
  private readonly tri: THREE.BufferGeometry;
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly grids: Record<'pool' | 'sea', THREE.PlaneGeometry>;
  private readonly gridMesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly gridScene = new THREE.Scene();
  private readonly screenTarget: THREE.WebGLRenderTarget;
  private screenScene: { id: string; inst: SceneInstance; gl: ReturnType<typeof glPass> } | null = null;

  constructor(core: RoomCore) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    this.renderer.setPixelRatio(1); // 画素数がそのまま計算量になるので、高解像度ディスプレイでも 1 倍で計算する
    this.renderer.autoClear = false;
    this.canvas = this.renderer.domElement;

    // 計算結果を重ねるバッファ（2 枚を交互に使う）。平均を取り続けるので 32bit 浮動小数が望ましい
    const floatType = this.renderer.extensions.has('EXT_color_buffer_float') ? THREE.FloatType : THREE.HalfFloatType;
    const makeTarget = (): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(1, 1, {
      type: floatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    });
    this.readT = makeTarget();
    this.writeT = makeTarget();

    // 光の揺らぎの画像（面ごと）
    for (const face of CAUSTIC_FACES) {
      this.causticTargets.set(face, new THREE.WebGLRenderTarget(CAUSTIC_SIZE, CAUSTIC_SIZE, {
        type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
      }));
    }
    const causTex = (face: number): THREE.Texture => this.causticTargets.get(face)!.texture;

    // スクリーンに映す映像を描く画像。遠くから見ると縮小されるので、ミップマップを作ってちらつきを抑える
    this.screenTarget = new THREE.WebGLRenderTarget(SCREEN_IMAGE.width, SCREEN_IMAGE.height, {
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: false,
    });

    // 値はすべて core の同じ物を参照する（core が書き換えれば、そのまま描く値になる）
    const shared = { ...core.shared, uScreenTex: { value: this.screenTarget.texture } };
    const causticUniforms = {
      uCausOn: core.causOn,
      uCaus0: { value: causTex(0) },
      uCaus1: { value: causTex(1) },
      uCaus2: { value: causTex(2) },
      uCaus4: { value: causTex(4) },
      uCaus5: { value: causTex(5) },
      uCausB: { value: causTex(6) },
    };
    const material = (vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader, fragmentShader, depthTest: false, depthWrite: false, uniforms });
    this.traceMat = material(vert, traceFrag, { ...shared, ...causticUniforms, uPrev: { value: this.readT.texture }, ...core.trace });
    this.displayMat = material(vert, displayFrag, { ...shared, ...causticUniforms, uAccum: { value: this.readT.texture }, ...core.display });
    this.causticMat = material(causticVert, causticFrag, {
      ...shared,
      uGridO: { value: new THREE.Vector3() },
      uGridU: { value: new THREE.Vector3() },
      uGridV: { value: new THREE.Vector3() },
      uWaterY: { value: 0 },
      uSource: { value: 0 },
      uMode: { value: 0 },
      uTarget: { value: 0 },
    });
    this.causticMat.side = THREE.DoubleSide; // 届いた先で網目が裏返ることがある
    this.causticMat.blending = THREE.CustomBlending;
    this.causticMat.blendEquation = THREE.AddEquation;
    this.causticMat.blendSrc = THREE.OneFactor;
    this.causticMat.blendDst = THREE.OneFactor;

    // 画面全体を覆う三角形 1 枚
    this.tri = new THREE.BufferGeometry();
    this.tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(this.tri, this.traceMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    // 水面の網目（uv だけ使う）
    this.grids = {
      pool: new THREE.PlaneGeometry(1, 1, ...core.poolGridSegs),
      sea: new THREE.PlaneGeometry(1, 1, ...core.seaGridSegs),
    };
    this.gridMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>(this.grids.pool, this.causticMat);
    this.gridMesh.frustumCulled = false;
    this.gridScene.add(this.gridMesh);
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.readT.setSize(w, h);
    this.writeT.setSize(w, h);
  }

  render(frame: RoomFrame): void {
    const renderer = this.renderer;
    if (frame.screen) this.renderScreenImage(frame.screen);

    // 段階 0：水面の光の揺らぎ
    const cu = this.causticMat.uniforms;
    renderer.setClearColor(0x000000, 0);
    for (const [face, rt] of this.causticTargets) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
      for (const p of frame.caustics) {
        if (p.target !== face) continue;
        this.gridMesh.geometry = this.grids[p.grid];
        cu['uGridO']!.value.copy(p.o);
        cu['uGridU']!.value.copy(p.u);
        cu['uGridV']!.value.copy(p.v);
        cu['uWaterY']!.value = p.y;
        cu['uSource']!.value = p.source;
        cu['uMode']!.value = p.mode;
        cu['uTarget']!.value = p.target;
        renderer.render(this.gridScene, this.quadCam);
      }
    }

    // 段階 1：空の光と照り返し
    this.traceMat.uniforms['uPrev']!.value = this.readT.texture;
    this.quad.material = this.traceMat;
    renderer.setRenderTarget(this.writeT);
    renderer.render(this.quadScene, this.quadCam);
    [this.readT, this.writeT] = [this.writeT, this.readT];

    // 段階 2：画面に出す
    this.displayMat.uniforms['uAccum']!.value = this.readT.texture;
    this.quad.material = this.displayMat;
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, this.quadCam);
  }

  async finish(): Promise<void> {
    const gl = this.renderer.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); // 読み出しは GPU の処理が終わるまで待つ
  }

  private renderScreenImage(img: RoomScreenImage): void {
    if (this.screenScene?.id !== img.def.id) {
      this.screenScene?.inst.dispose();
      this.screenScene?.gl.dispose();
      const inst = img.def.create(SCREEN_IMAGE);
      this.screenScene = { id: img.def.id, inst, gl: glPass(inst.pass) };
    }
    this.screenScene.inst.update(img.input, img.params);
    this.renderer.setRenderTarget(this.screenTarget);
    this.renderer.render(this.screenScene.gl.scene, this.screenScene.gl.camera);
  }

  dispose(): void {
    this.tri.dispose();
    this.grids.pool.dispose();
    this.grids.sea.dispose();
    this.traceMat.dispose();
    this.displayMat.dispose();
    this.causticMat.dispose();
    this.readT.dispose();
    this.writeT.dispose();
    for (const rt of this.causticTargets.values()) rt.dispose();
    this.screenTarget.dispose();
    this.screenScene?.inst.dispose();
    this.screenScene?.gl.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // 作り直しを繰り返しても WebGL コンテキストが溜まらないように
  }
}
