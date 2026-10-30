// room モードを WebGL2（three.js）で描く。シェーダーは GLSL。
// 同じ計算の WebGPU 版は src/room/gpu.ts（WGSL）。どちらも src/room/core.ts が決めた値で描く
import * as THREE from 'three';
import { GLSL_SIMPLEX3, glPass } from '../scenes/shader.ts';
import type { SceneInstance } from '../scenes/types.ts';
import { CAUSTIC_FACES, CAUSTIC_SIZE, FLOOR_ALBEDO, POOL_ALBEDO, SCREEN_ALBEDO, SCREEN_IMAGE, WALL_ALBEDO, type RoomCore, type RoomFrame } from './core.ts';
import { MAX_BLOBS, MAX_PRISMS, MAX_SHIM_COLORS, MAX_SHIM_PALETTE, MAX_SPOTS, type RoomScreenImage } from './model.ts';
import { MAX_ROOM_PRIMS } from './step.ts';
import { TEX_SIZE } from './textures.ts';
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
uniform float uWin2On;       // 2 つ目の窓（天窓）があるか。天窓＋左の窓のとき 1（1 つ目は左の壁）
uniform vec4 uWin2Rect;      // 2 つ目の窓（天窓）の範囲 (x0, x1, z0, z1)
uniform vec3 uSunDir;        // 太陽のある方向
uniform float uSunSinR;      // 太陽の見かけの半径の sin
uniform vec3 uSunE;          // 直射日光の強さ（光に垂直な面での放射照度）
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform vec3 uViewSkyTop;    // 見える空（画面に出す段階だけ）。「選んだ色のまま」でなければ uSkyTop と同じ
uniform vec3 uViewSkyBottom;
uniform vec3 uGround;
uniform vec4 uScreenRect;    // スクリーン面（奥の壁の x0, x1, y0, y1）
uniform int uScreenArea;     // スクリーン面を壁と分けて示す（0 なら、ただの壁として扱う）
uniform int uSeaOn;          // 窓の外に海を描く
uniform float uSeaY;         // 窓の外の水面の高さ
uniform vec3 uSeaBody;       // 水の中から出てくる光（水の色）
uniform float uSeaHaze;      // 海が空気でかすむ距離（m）
uniform float uSeaHorizon;   // 水平線：0 = 平らな海、1 = 地球の丸みと遠くの波の傾きを入れる
uniform vec2 uSeaLook;       // 海面の細かい粗さ（傾きの 2 乗平均）・波の山が透ける強さ
uniform float uPixAngle;     // 1 画素が見込む角度（ラジアン）
uniform vec3 uSeaGlintDir;   // 海に映すきらめきの光の向き（昼は太陽、夜は海に映す月）
uniform vec3 uSeaGlintE;     // その光の強さ
uniform vec3 uMoonDisk;      // 窓から見える月：描くか（1 = 描く）・見かけの半径の sin・満ち欠けの形を描くか
uniform vec3 uMoonDiskL;     // 月の円盤の明るさ（放射輝度）
uniform vec3 uMoonSunDir;    // 太陽のある方向（月の満ち欠けの形を決める。夜は地平線の下）
uniform float uGlassMask;    // ガラスの壁の面（ビット：1 = +x 右、2 = −x 左、4 = 天井、16 = 手前、32 = 奥）
uniform float uOpenMask;     // 窓（壁いっぱいの穴）にする面のうち、1 つ目・2 つ目の窓で表せないもの（ビットは uGlassMask と同じ。左右の壁を両方窓にしたときなど）
// ガラスの仕様は面ごと（面の番号で引く。0 = 右、1 = 左、2 = 天井、4 = 手前、5 = 奥。3（床）は使わない）
uniform vec3 uGlassWaveA[6]; // 表面の形（0 平ら・1 波打ち・2 うねり・3 リブ）・模様の大きさ（m）・深さ（m）
uniform vec3 uGlassWaveB[6]; // 虹の強さ（色ごとの屈折率の差の倍率。0 で虹なし）・光が集まり切る距離 ×（n−1）の上限（これより遠くでは網目がそれ以上折り重ならない）・（使わない）
uniform vec3 uGlassTintF[6]; // ガラスを真正面から通る光の割合（色ごと。ガラスの種類と色）
uniform int uPoolOn;         // 床の水盤
uniform float uPoolDepth;    // 水盤の深さ
uniform int uCloudOn;        // 窓の外の空に雲
uniform int uCloudShadow;    // 雲が日差しをさえぎる
uniform float uCloudY;       // 雲の高さ（m）
uniform float uCloudScale;   // 1 / 雲のかたまりの大きさ（1/m）
uniform float uCloudAmount, uCloudContrast, uCloudOpacity;
uniform vec3 uCloudOffA, uCloudOffB;  // 雲の流れ（xy）と形の変化（z）。B は巻き戻した後の同じ動き
uniform float uCloudBlend;
const int MAX_PRISMS = ${MAX_PRISMS};
uniform float uPrismOn;      // プリズム（虹色の光）
uniform float uPrismPattern; // 出し方：0 = 日だまりの中に虹の筋、1 = 窓に吊るプリズム、2 = 窓をプリズムの板で覆う、3 = 日差しの先の虹の筋、4 = 波のプリズム
uniform float uPrismPhase;   // 動き（筋の揺れ）の進み
uniform float uStreakAmount, uStreakLen, uStreakAngle; // 虹の筋：多さ・長さ（m）・向き（ラジアン）
uniform float uPanelRidge;   // プリズムの板の稜の向き（ラジアン）
uniform float uPrismCount;   // 吊っているプリズムの数
uniform vec3 uPrismPos[MAX_PRISMS];   // プリズムの位置
uniform vec3 uPrismAxis[MAX_PRISMS];  // プリズムの稜の向き（水平）
uniform float uPrismStrength, uPrismSize;
uniform float uPrismDev, uPrismDisp;  // 光が曲がる角度・赤と紫の差（ラジアン）
uniform float uPrismVivid;            // 日なたに落ちた虹の色を際立たせる割合（0〜1）
uniform float uPrismFacets;           // 1 つのプリズムから出る虹の数（面の数、1〜4）
uniform float uPrismFadeM;   // 日なたと影の境目・面の縁で、色のずれを消していく幅（m）
// E・F・G の縁の見え方：Edge = (色の帯の幅, ぼかしの幅, 外へ広がる光の明るさ, 外へ広がる幅)、Look = (色の濃さ, 外へ広がる光の色合い)
uniform float uWaveOn;       // E：波のプリズム
uniform vec4 uWaveEdge;
uniform vec2 uWaveLook;
uniform vec3 uWaveShape;     // E：縁が揺れる大きさ（m）・波の長さ（m）・波の進み（ラジアン）
uniform float uOrgOn;        // F：有機的な日だまりの縁
uniform vec4 uOrgEdge;
uniform vec2 uOrgLook;
uniform vec4 uOrgShape;      // F：縁が揺れる大きさ（m）・模様の大きさ（m）・形の変化の進み・内側の淡い色
uniform float uShimOn;       // H：水のきらめきを重ねる強さ（0 = 出さない）
uniform vec4 uShimShape;     // H：網目の大きさ（m）・線の太さ・ゆがみ・形の変化の進み
uniform vec4 uShimLook;      // H：線のない所の明るさ・線の明るさ・虹のずれ・膜の虹色の濃さ
uniform vec4 uShimColor;     // H：線の縁の色の数・虹の色の範囲の始め・終わり・色の濃さ
uniform float uShimSurface;  // H：1 = 網目を面そのものに置く（大きさが変わらない）
uniform float uShimPalN;     // H：選んだ色の数（0 = 虹の色の範囲を使う）
const int MAX_SHIM_COLORS = ${MAX_SHIM_COLORS};
const int MAX_SHIM_PALETTE = ${MAX_SHIM_PALETTE};
uniform vec3 uShimPal[MAX_SHIM_PALETTE];
uniform vec3 uShimLineCol;   // H：線の色合い（明るさ 1）
uniform vec3 uShimBaseCol;   // H：線のない所の色合い（明るさ 1）
const int MAX_BLOBS = ${MAX_BLOBS};
uniform float uBlobCount;    // G：虹のしみの数（0 = 出さない）
uniform vec3 uBlobPos[MAX_BLOBS];
uniform vec3 uBlobAxis[MAX_BLOBS];
uniform vec4 uBlobEdge;
uniform vec2 uBlobLook;
uniform vec4 uBlobShape;     // G：形の崩れ方・形の変化の進み・内側の淡い色
uniform vec4 uBlobBeam;      // G：半径（m、窓の所）・大きくなる割合・曲がる角度（ラジアン）・明るさ
uniform float uBeamBlur;     // D：光の束が進むにつれて太くなる割合（m/m）
uniform float uPrismCaus;    // 水の光の揺らぎの虹色のにじみの幅（m、0 = にじませない）
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
uniform float uSpotLampOn;           // 器具を描くか（0 = 描かない。照らす光は変わらない）
uniform vec3 uAmbL;                  // 全体照明：天井の光る面の明るさ（放射輝度。0 = 消えている）
uniform vec4 uAmbRect;               // 全体照明：光る面の範囲（x0, x1, z0, z1。高さは天井）
uniform float uLhOn;                 // 灯台の光：点き具合（0 = 消えている）
uniform vec3 uLhPos;                 // 灯火の位置
uniform vec4 uLhAxis;                // 帯の向き（ラジアン）・帯の本数・広がりの半分の tan・明るさの広がり（ガウスの幅、ラジアン）
uniform vec3 uLhI;                   // 光度（距離² で割ると放射照度）
uniform vec4 uLhLook;                // 空気の散乱の強さ・灯火のにじみ・もやで見える距離
// 読み込んだ部屋の形（STEP。src/room/step.ts）の面。uPrimCount が 0 なら四角い部屋
const int MAX_ROOM_PRIMS = ${MAX_ROOM_PRIMS};
uniform float uPrimCount;
uniform vec3 uPrimO[MAX_ROOM_PRIMS];    // 面の角
uniform vec3 uPrimU[MAX_ROOM_PRIMS];    // 面の 2 辺（平行四辺形。三角形なら角と 2 辺の先の 3 点）
uniform vec3 uPrimV[MAX_ROOM_PRIMS];
uniform vec3 uPrimInfo[MAX_ROOM_PRIMS]; // x = 面の番号（0〜5 = 外枠の面、8〜13 = 部屋の中の物（8 + 向き））、y = 1 なら三角形、z = 1 なら軸にそった長方形（uPrimO・uPrimU が両端の角）
uniform vec3 uPrimBoxMin, uPrimBoxMax; // 面をまとめて囲む直方体
// 面に貼る画像（面のまとまりごと：0〜5 = 面の向き、6 = 部屋の中の物）。src/room/textures.ts
uniform float uTexOn;
uniform vec3 uTexA[7];       // 画像の束の何枚目か（−1 = 貼らない）・1 / 画像の幅（m）・1 / 画像の高さ（m）
uniform vec3 uTexB[7];       // 明るさの倍率
uniform highp sampler2DArray uTexArr;

const float PI = 3.14159265358979;
const float EARTH_R = 6371000.0; // 地球の半径（m）
const float EPS = 1e-4;
const float IOR = ${WATER_IOR.toFixed(3)};
const vec3 WATER_ABS = vec3(${WATER_ABSORPTION.map(f3).join(', ')});
const vec3 OUTSIDE = vec3(0.02); // 部屋の外（カメラが外にあり、部屋に当たらない方向）

${WATER_GLSL}

// ---- 水盤と窓の外の海をつなぐ（src/room/gpu.ts と同じ）----
uniform float uPoolSea;      // 水盤と海のつなぎ方：0 = つながない、1 = ガラスで仕切る、2 = 壁の下が開いている
uniform float uPoolSeaMask;  // 水盤が海とつながる面（ビットは uGlassMask と同じ）
uniform float uPoolSeaReach; // 海の波が部屋に入る距離（m）
// 壁の下が開いているとき：海とつながる面までの距離から、海の波が入る割合（0〜1）。遠いほど静まる
float poolSeaInflow(vec2 p) {
  if (uPoolSea < 1.5) return 0.0;
  int m = int(uPoolSeaMask + 0.5);
  float dm = 1e9;
  if ((m & 1) != 0) dm = min(dm, uRoomMax.x - p.x);
  if ((m & 2) != 0) dm = min(dm, p.x - uRoomMin.x);
  if ((m & 16) != 0) dm = min(dm, uRoomMax.z - p.y);
  if ((m & 32) != 0) dm = min(dm, p.y - uRoomMin.z);
  return exp(-max(dm, 0.0) / uPoolSeaReach);
}
// 水盤の波（高さ・x・z の傾き）。壁の下が開いているときは、つながる面に近いほど海の波にする
vec3 poolSurface(vec2 p) {
  float k = poolSeaInflow(p);
  if (k < 1e-3) return poolWave(p);
  return mix(poolWave(p), seaSurface(p, 0.0).xyz, k);
}
// 水の中を o から向き d に進む光線が、海とつながる面を抜けるまでの距離（抜けなければ 1e9）と、その面
float poolSeaWall(vec3 o, vec3 d, out int face) {
  int m = int(uPoolSeaMask + 0.5);
  float r = 1e9;
  face = -1;
  if (uPoolSea < 0.5) return r;
  if ((m & 1) != 0 && d.x > 1e-6) { float t = (uRoomMax.x - o.x) / d.x; if (t < r) { r = t; face = 0; } }
  if ((m & 2) != 0 && d.x < -1e-6) { float t = (uRoomMin.x - o.x) / d.x; if (t < r) { r = t; face = 1; } }
  if ((m & 16) != 0 && d.z > 1e-6) { float t = (uRoomMax.z - o.z) / d.z; if (t < r) { r = t; face = 4; } }
  if ((m & 32) != 0 && d.z < -1e-6) { float t = (uRoomMin.z - o.z) / d.z; if (t < r) { r = t; face = 5; } }
  return r;
}

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

// 読み込んだ部屋の形の面のうち、距離 t より手前で光線が当たる面。当たれば、その面の番号と距離にする
float meshExit(vec3 o, vec3 d, float t, inout int face) {
  // 面をまとめて囲む直方体を、光線が距離 t までに通らなければ、どの面にも当たらない
  vec3 id = 1.0 / safeDir(d);
  vec3 t0 = (uPrimBoxMin - o) * id, t1 = (uPrimBoxMax - o) * id;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  if (max(max(tn.x, tn.y), max(tn.z, 0.0)) > min(min(tf.x, tf.y), min(tf.z, t))) return t;
  for (int i = 0; i < MAX_ROOM_PRIMS; i++) {
    if (float(i) >= uPrimCount) break;
    vec3 info = uPrimInfo[i];
    if (info.z > 0.5) {
      // 軸にそった長方形：厚さ 0 の直方体（uPrimO・uPrimU が両端の角）に入る所
      vec3 a0 = (uPrimO[i] - o) * id, a1 = (uPrimU[i] - o) * id;
      vec3 n0 = min(a0, a1), f0 = max(a0, a1);
      float ta = max(max(n0.x, n0.y), n0.z);
      if (ta <= min(min(f0.x, f0.y), f0.z) && ta > 1e-5 && ta < t) { t = ta; face = int(info.x + 0.5); }
      continue;
    }
    vec3 e1 = uPrimU[i], e2 = uPrimV[i];
    vec3 pv = cross(d, e2);
    float det = dot(e1, pv);
    if (abs(det) < 1e-12) continue;
    float inv = 1.0 / det;
    vec3 s = o - uPrimO[i];
    float a = dot(s, pv) * inv;
    if (a < 0.0 || a > 1.0) continue;
    vec3 qv = cross(s, e1);
    float b = dot(d, qv) * inv;
    if (b < 0.0 || b > 1.0 || (uPrimInfo[i].y > 0.5 && a + b > 1.0)) continue;
    float ti = dot(e2, qv) * inv;
    if (ti > 1e-5 && ti < t) { t = ti; face = int(uPrimInfo[i].x + 0.5); }
  }
  return t;
}

// 部屋の内側から出る点（光線が最初に当たる面）。面：0 = +x, 1 = -x, 2 = +y（天井）, 3 = -y（床）, 4 = +z（手前）, 5 = -z（奥・スクリーン）。
// 読み込んだ部屋の形のときは、その面（部屋の中の物は 8 + 向き）。形の面がない所（開いた手前など）は、外枠の直方体の面
float exitRoom(vec3 o, vec3 d, out int face) {
  vec3 dd = safeDir(d);
  vec3 bound = mix(uRoomMin, uRoomMax, step(0.0, dd));
  vec3 t = (bound - o) / dd;
  float tb;
  if (t.x <= t.y && t.x <= t.z) { face = dd.x > 0.0 ? 0 : 1; tb = t.x; }
  else if (t.y <= t.z) { face = dd.y > 0.0 ? 2 : 3; tb = t.y; }
  else { face = dd.z > 0.0 ? 4 : 5; tb = t.z; }
  return uPrimCount > 0.5 ? meshExit(o, d, tb, face) : tb;
}
// 面の向き（部屋の中の物 8〜13 は、向きの番号 0〜5 に）
int dirOf(int face) { return face >= 8 ? face - 8 : face; }

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
  face = dirOf(face);
  vec3 q = (p - uRoomMin) / (uRoomMax - uRoomMin);
  if (face == 0 || face == 1) return vec2(q.z, q.y);
  if (face == 2 || face == 3) return vec2(q.x, q.z);
  return vec2(q.x, q.y);
}

vec3 inwardNormal(int face) {
  face = dirOf(face);
  if (face == 0) return vec3(-1.0, 0.0, 0.0);
  if (face == 1) return vec3(1.0, 0.0, 0.0);
  if (face == 2) return vec3(0.0, -1.0, 0.0);
  if (face == 3) return vec3(0.0, 1.0, 0.0);
  if (face == 4) return vec3(0.0, 0.0, -1.0);
  return vec3(0.0, 0.0, 1.0);
}

bool inWindow1(int face, vec3 p) {
  if (face != uWinFace) return false;
  vec2 uv = face == 2 ? p.xz : p.zy;
  return uv.x > uWinRect.x && uv.x < uWinRect.y && uv.y > uWinRect.z && uv.y < uWinRect.w;
}

// 2 つ目の窓（天窓＋左の窓のときの天窓）
bool inWindow2(int face, vec3 p) {
  return uWin2On > 0.5 && face == 2 && p.x > uWin2Rect.x && p.x < uWin2Rect.y && p.z > uWin2Rect.z && p.z < uWin2Rect.w;
}

// ガラスの壁（面ぜんたいが枠なしの一枚ガラス）。光と景色はそのまま通すので、計算の上では面ぜんたいが窓。画面に出す段階で、ガラスの映り込みを足す
// ガラスの面。窓（穴）の所は窓のまま（天窓のときに天井をガラスにすると、天窓のまわりの天井だけがガラスになる）
// 壁いっぱいの窓（1 つ目・2 つ目の窓のほかに開ける面）
bool isOpen(int face) { return (int(uOpenMask + 0.5) & (1 << face)) != 0; }
bool isGlass(int face, vec3 p) {
  return (int(uGlassMask + 0.5) & (1 << face)) != 0 && !isOpen(face) && !inWindow1(face, p) && !inWindow2(face, p);
}

bool inWindow(int face, vec3 p) {
  return inWindow1(face, p) || inWindow2(face, p) || isOpen(face) || isGlass(face, p);
}
// 光線が抜けた所が、窓の点を選ぶ方法で選ばれうる窓か（1 = 窓、2 = 2 つ目の窓、0 = ガラスの壁だけ：その向きは窓の点を選ぶ方法では選ばれない）
int windowIndex(int face, vec3 p) { return inWindow2(face, p) ? 2 : (inWindow1(face, p) ? 1 : 0); }

// ---- ガラスの表面の形とプリズム ----
// 表面の高さ h（ガラスの面の上の 2 次元の位置 q、m）を、向きと長さの違う正弦波の重ね合わせで表す（波打ち 6 本・うねり 3 本の長い波・リブ 1 本の縦の筋）。
// 傾き g = ∇h と、曲がり具合 H = (hxx, hyy, hxy) を返す
const vec3 GLASS_W[6] = vec3[6](vec3(0.3, 1.0, 0.0), vec3(1.4, 0.73, 1.7), vec3(2.5, 1.31, 3.1), vec3(3.6, 0.58, 4.4), vec3(4.7, 1.12, 0.9), vec3(5.6, 0.87, 2.6));
vec2 glassUV(int f, vec3 p) { return f == 0 || f == 1 ? p.zy : (f == 2 ? p.xz : p.xy); }
void glassAxes(int f, out vec3 tu, out vec3 tv) {
  if (f == 0 || f == 1) { tu = vec3(0.0, 0.0, 1.0); tv = vec3(0.0, 1.0, 0.0); }
  else if (f == 2) { tu = vec3(1.0, 0.0, 0.0); tv = vec3(0.0, 0.0, 1.0); }
  else { tu = vec3(1.0, 0.0, 0.0); tv = vec3(0.0, 1.0, 0.0); }
}
void glassWaves(int f, vec2 q, out vec2 g, out vec3 H) {
  g = vec2(0.0);
  H = vec3(0.0);
  vec3 gw = uGlassWaveA[f];
  float kind = gw.x;
  if (kind < 0.5) return;
  float m = kind > 1.5 && kind < 2.5 ? 3.0 : 1.0; // うねり：3 倍長く、3 倍深い（傾きは同じくらい）
  for (int i = 0; i < 6; i++) {
    vec3 w = GLASS_W[i];
    if (kind > 2.5) { if (i > 0) break; w = vec3(0.0, 1.0, 0.0); } // リブ：横の向きだけに並ぶ縦の筋
    if (kind > 1.5 && kind < 2.5 && i > 2) break;
    float k = 6.2832 / (gw.y * w.y * m);
    vec2 kv = k * vec2(cos(w.x), sin(w.x));
    float a = gw.z * m * (kind > 2.5 ? 1.0 : 0.45);
    float ph = dot(kv, q) + w.z;
    g += a * cos(ph) * kv;
    H -= a * sin(ph) * vec3(kv.x * kv.x, kv.y * kv.y, kv.x * kv.y);
  }
}
// 虹の色（0 = 赤 → 1 = 紫、白を混ぜない）
vec3 glassHue(float s) { return clamp(abs(fract(s * 0.8 + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
// 点 p に向き l から届く日差しが、ガラスを通ってきたときの倍率（色ごと）。ガラスでなければ 1。
// ガラスの色（uGlassTintF）と、表面の形による光の網目：ガラスの表面の傾きで光は (n−1)·∇h だけ曲がる（薄いプリズム、n = 1.5）。
// 距離 t 進むと、ガラスの上の位置 s を通った光が s + t·(n−1)·∇h(s) に届くので、点に届く光の明るさは 1 / |det(I + t·(n−1)·H)|（光が集まる所が明るい網目）。
// 虹：色ごとに屈折率を少しずつ変えて（本物のガラスの差 0.012 × 虹の強さ）7 色で重ねると、網目の縁が虹色になる。caustic = false なら色だけ
vec3 glassSunFactor(vec3 p, vec3 l, bool caustic) {
  if (uGlassMask < 0.5) return vec3(1.0);
  int f;
  float t = exitRoom(p, l, f);
  vec3 q = p + l * t;
  if (!isGlass(f, q)) return vec3(1.0);
  if (!caustic || uGlassWaveA[f].x < 0.5) return uGlassTintF[f];
  vec2 uv = glassUV(f, q);
  float prism = uGlassWaveB[f].x;
  int ns = prism > 0.0 ? 7 : 1;
  vec3 sum = vec3(0.0), wsum = vec3(0.0);
  for (int j = 0; j < 7; j++) {
    if (j >= ns) break;
    float s = ns == 1 ? 0.5 : (float(j) + 0.5) / 7.0;
    float dn = 0.5 + 0.012 * prism * (s - 0.5);
    vec2 g; vec3 H;
    glassWaves(f, uv, g, H);
    glassWaves(f, uv - t * dn * g, g, H); // その点に届く光が通ったガラスの位置（1 回だけ近づける）
    // 光が集まり切る所（焦点）より遠くでは、網目は細かく折り重なるが、太陽の大きさ（0.53°）でぼけて見えなくなるので、焦点の手前で止める
    float a = min(t, uGlassWaveB[f].y / 0.5) * dn;
    float det = (1.0 + a * H.x) * (1.0 + a * H.y) - a * a * H.z * H.z;
    float I = min(1.0 / max(abs(det), 0.06), 8.0);
    // 太陽の大きさのぼけ：進んだ距離 × 0.0093（太陽の見かけの直径）が模様の大きさに近づくほど、網目は薄れる
    float blur = 3.1416 * t * 0.0093 / max(uGlassWaveA[f].y, 1e-3);
    I = mix(1.0, I, exp(-blur * blur));
    vec3 c = ns == 1 ? vec3(1.0) : glassHue(s);
    sum += c * I;
    wsum += c;
  }
  return uGlassTintF[f] * sum / wsum;
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
  return uScreenArea != 0 && face == 5 && p.x > uScreenRect.x && p.x < uScreenRect.y && p.y > uScreenRect.z && p.y < uScreenRect.w;
}

// 面に貼った画像の色（光を返す割合）。貼っていない面は base。画像は部屋の中から見て正しい向き（上が上）になるように貼る。
// lod < 0 なら、見ている所からの距離と面の傾きで縮小の段（ミップマップ）を決める（照り返しの計算では大きな値を渡して平均の色を使う）
vec3 texAlbedo(int face, vec3 p, vec3 base, float lod) {
  if (uTexOn < 0.5) return base;
  int g = face >= 8 ? 6 : face;
  vec3 a = uTexA[g];
  if (a.x < 0.0) return base;
  int d = dirOf(face);
  vec2 uv = d == 0 ? vec2(p.z, -p.y) : d == 1 ? vec2(-p.z, -p.y) : d == 2 ? vec2(-p.x, p.z) : d == 3 ? vec2(p.x, p.z) : d == 4 ? vec2(-p.x, -p.y) : vec2(p.x, -p.y);
  uv *= a.yz;
  if (lod < 0.0) {
    vec3 v = p - uCamPos;
    float dist = max(length(v), 1e-4);
    float c = max(abs(dot(v / dist, inwardNormal(face))), 0.15);
    lod = log2(max(dist * uPixAngle / c * max(a.y, a.z) * ${TEX_SIZE}.0, 1e-6));
  }
  return min(textureLod(uTexArr, vec3(uv, a.x), lod).rgb * uTexB[g].x, vec3(0.95));
}

vec3 albedoLod(int face, vec3 p, float lod) {
  if (face == 3) return texAlbedo(3, p, vec3(${FLOOR_ALBEDO.toFixed(3)}), lod);
  if (onScreen(face, p)) return vec3(${SCREEN_ALBEDO.toFixed(3)}) * vec3(0.92, 0.96, 1.05);
  return texAlbedo(face, p, vec3(${WALL_ALBEDO.toFixed(3)}), lod);
}
vec3 albedo(int face, vec3 p) { return albedoLod(face, p, -1.0); }

// 画面に出す段階（見える空）だけ true。「選んだ色のまま」のときは、見える空だけ uViewSky*（部屋を照らす空の光は uSky* のまま）
bool gView = false;
vec3 skyRadiance(vec3 d) {
  float t = sqrt(max(d.y, 0.0));
  if (gView) return mix(uViewSkyBottom, uViewSkyTop, t);
  return mix(uSkyBottom, uSkyTop, t);
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
// ---- 灯台の光（夜）。沖の灯台から、水平な円すいの光の帯が回る（上から見て時計回り） ----
// 灯台から向き w へ出る光の強さ（0〜1）：いちばん近い帯の軸からの角度で決まる（ガウス形。縁で約 6%）。帯の向きは (−sin a, 0, cos a)
float lhProfile(vec3 w) {
  float seg = 2.0 * PI / uLhAxis.y;
  float x = atan(-w.x, w.z) - uLhAxis.x + 0.5 * seg;
  float da = x - seg * floor(x / seg) - 0.5 * seg;
  float e = asin(clamp(w.y, -1.0, 1.0));
  float a2 = da * da * (1.0 - w.y * w.y) + e * e;
  return exp(-a2 / (uLhAxis.w * uLhAxis.w));
}
// 点 o から向き d を見たときの、灯台の光：空気のもやで散った光の帯（距離 tMax まで）と、こちらを向いたときの灯火のまぶしさ。
// 帯：灯火から見ると、視線（直線）の上の点は 1 つの平面の中に並び、点までの距離 r と、灯火から見た角度 ψ の間に ds / r² = dψ / h
// （h は灯火から視線までの距離）が成り立つ。なので、もやが散らす光 σ·光度·∫ 帯の強さ / r² ds は、σ·光度 / h × 帯の強さを ψ で足したもの。
// 帯の強さはガウス形なので、帯の軸から平面までの角度で決まる強さ × 平面の中で帯を横切る幅（視線の範囲で切る）で求まる。
// 帯の方を向いて見るほど（光が目に向かって進むほど）、もやは前に強く散らすので明るい
vec3 lighthouseSky(vec3 o, vec3 d, float tMax) {
  if (uLhOn <= 0.0) return vec3(0.0);
  vec3 col = vec3(0.0);
  vec3 w0 = o - uLhPos;
  float r0 = length(w0);
  vec3 a0 = w0 / r0;                       // 灯火から見た、視線の始まりの向き
  vec3 perp = d - a0 * dot(a0, d);
  float pl = length(perp);
  float h = max(r0 * pl, 0.5);             // 灯火から視線までの距離
  if (pl > 1e-6) {
    vec3 e2 = perp / pl;                   // 平面の中で、視線の進む側の向き
    vec3 m = cross(a0, e2);                // 平面に垂直な向き
    vec3 aEnd = normalize(w0 + d * min(tMax, 1e6));
    float psiEnd = atan(dot(aEnd, e2), dot(aEnd, a0));
    float sb2 = uLhAxis.w * uLhAxis.w;
    float seg = 2.0 * PI / uLhAxis.y;
    for (int k = 0; k < 4; k++) {
      if (float(k) >= uLhAxis.y) break;
      float a = uLhAxis.x + seg * float(k);
      vec3 b = vec3(-sin(a), 0.0, cos(a));
      float mb = dot(m, b);
      float psiB = atan(dot(b, e2), dot(b, a0));
      // 平面の中で帯を横切る割合（ガウスの積分。erf を tanh で近似し、引数は大きすぎないように切る）
      float x0 = clamp(-psiB / uLhAxis.w, -4.0, 4.0), x1 = clamp((psiEnd - psiB) / uLhAxis.w, -4.0, 4.0);
      float frac = 0.5 * (tanh(1.2 * x1) - tanh(1.2 * x0));
      if (frac <= 1e-4) continue;
      // 帯が視線と交わる所までの距離（もやで遠い所ほどかすむ）
      float c = dot(b, a0), sn = dot(b, e2), d1 = dot(d, a0), d2 = dot(d, e2);
      float den = d2 * c - d1 * sn;
      float sB = den > 1e-6 ? clamp(r0 * sn / den, 0.0, tMax) : 0.0;
      float ph = 0.4 + 3.0 * pow(max(-dot(d, b), 0.0), 12.0);
      col += uLhI * (uLhLook.x * ph / h * exp(-mb * mb / sb2) * 1.772 * uLhAxis.w * frac * exp(-sB / uLhLook.z));
    }
  }
  // 灯火：帯がこちらを向いているほど明るい（向いていなくても、かすかに見える）。芯は画素の大きさ、まわりに約 2° のにじみ
  vec3 tl = uLhPos - o;
  float dl2 = dot(tl, tl);
  vec3 wl = tl * inversesqrt(dl2);
  float ang = length(d - wl);
  float core = max(1.5 * uPixAngle, 3e-4);
  float lamp = exp(-ang * ang / (core * core)) / (PI * core * core) + uLhLook.y * exp(-ang * ang / 4e-4) / (PI * 4e-4);
  return col + uLhI / dl2 * (0.02 + lhProfile(-wl)) * lamp;
}
// 雲のある空：点 o から向き d（上向き）に見える空の明るさ（灯台の光も足す）
vec3 cloudySky(vec3 o, vec3 d) {
  vec3 sky = skyRadiance(d) + lighthouseSky(o, d, 1e9);
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

// 窓から見える月（夜）。本物の見かけの大きさ（× 倍率）の円盤で、本物の月のときは太陽の向きから満ち欠けの形を決める
// （月の球の、太陽を向いた半分が光る）。表面の暗い所（海）は月の球の上のノイズで薄く描き、影の側は地球照でかすかに見える。
// 明るさは本物どおりだと白く飛ぶので、露出に合わせて模様が見える値にしている（core.ts）。雲がかかると隠れる
vec3 moonDisk(vec3 o, vec3 d) {
  if (uMoonDisk.x < 0.5) return vec3(0.0);
  vec3 m = uSunDir;
  float c = dot(d, m);
  if (c <= 0.0) return vec3(0.0);
  float sr = uMoonDisk.y;
  vec3 q = (d - m * c) / sr; // 円盤の上の位置（縁が 1）
  float r = length(q);
  float aa = max(uPixAngle / sr, 0.03);
  float edge = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  if (edge <= 0.0) return vec3(0.0);
  vec3 n = q - m * sqrt(max(0.0, 1.0 - r * r)); // 月の球の、こちらを向いた面の向き
  float lit = uMoonDisk.z > 0.5 ? smoothstep(-0.04, 0.04, dot(n, uMoonSunDir)) : 1.0;
  vec3 up = vec3(0.0, 1.0, 0.0) - m * m.y;
  up = dot(up, up) > 1e-6 ? normalize(up) : vec3(0.0, 0.0, -1.0);
  vec3 s = vec3(dot(n, cross(m, up)), dot(n, up), -dot(n, m)); // 月の球の上の座標（上 = 空の上の向き）
  float mare = smoothstep(0.05, 0.45, snoise(s * 1.7 + vec3(3.1, 1.7, 0.4)));
  float tex = (1.0 - 0.4 * mare) * (0.93 + 0.07 * snoise(s * 9.0));
  return uMoonDiskL * (edge * mix(0.002, tex, lit) * cloudTrans(o));
}

// 窓の外の海：点 o から向き d（下向き）で見た水面の明るさ。空の映り込み・太陽のきらめき・水の色を、反射の割合で混ぜる
// 海面の太陽のきらめき（マイクロファセット）。n は描いた波の向き、m2 は描ききれない細かい波の傾きの 2 乗平均（粗さ）。
// 細かい傾きの分布を Beckmann 分布とし、太陽の向き l と視線 v の中間の向き h を向いた細かい面の割合で光らせる。
// 粗いほど、きらめきが広い帯になって暗くなる（光の量は同じ）
float seaGlintL(vec3 n, vec3 v, float m2, vec3 l) {
  float nl = dot(n, l);
  if (l.y <= 0.0 || nl <= 0.0) return 0.0;
  vec3 h = normalize(v + l);
  float nh = max(dot(n, h), 1e-3);
  float c2 = nh * nh;
  float D = exp(-(1.0 - c2) / (c2 * m2)) / (PI * m2 * c2 * c2);
  return fresnelWater(dot(h, v)) * D / (4.0 * max(dot(n, v), 0.05));
}
float seaGlint(vec3 n, vec3 v, float m2) { return seaGlintL(n, v, m2, uSeaGlintDir); }
vec3 seaRadiance(vec3 o, vec3 d) {
  float t = (uSeaY - o.y) / min(d.y, -1e-4);
  vec3 dl = d; // 当たった所の水面から見た視線（地球の丸みで、水面の水平が少し傾く）
  if (uSeaHorizon > 0.5) {
    // 地球の丸み：見下ろす角度 a、目の高さ h の視線は、t²/(2R) − a·t + h = 0 で丸い海面に当たる。
    // a² < 2h/R なら水平線より上（空）。当たった所では、水面の水平に対して √(a² − 2h/R) の角度で見下ろす
    float h = max(o.y - uSeaY, 0.01);
    float a = -d.y;
    float disc = a * a - 2.0 * h / EARTH_R;
    if (disc <= 0.0) return cloudySky(o, d);
    t = 2.0 * h / (a + sqrt(disc));
    dl = normalize(vec3(d.x, -sqrt(disc), d.z));
  }
  vec3 x = o + d * t;
  // 画素の大きさ（水面の上で m）。斜めに見るほど奥行きの向きに伸びる
  float fw = t * uPixAngle / sqrt(max(-d.y, 1e-3));
  vec4 sw = seaSurface(x.xz, fw);
  vec3 n = waveNormal(sw.xyz);
  vec3 v = -dl;
  float cv = dot(v, n);
  vec3 r = reflect(dl, n);
  r.y = abs(r.y);
  if (uSeaHorizon > 0.5) {
    // 遠くの消した波の傾き（sw.w）と細かい粗さ：浅い角度で見ても、見えている波の面はこちらへ傾いている。
    // 視線の向きの傾きのばらつき σ² ≒ 全体の半分。見えている面の平均の cos ≒ √(cos² + 1.5σ²)（真横から見ると約 1.2σ）。
    // 映す割合はその角度のフレネル、映る空はその面で跳ね返る向き（高さ ≒ 2·cos − 見下ろす角度）
    float s2 = 0.5 * (uSeaLook.x + sw.w);
    cv = sqrt(cv * cv + 1.5 * s2);
    r.y = max(r.y, 2.0 * cv + dl.y);
    r = normalize(r);
  }
  float F = fresnelWater(cv);
  // 水の中の色：波の山（薄い所）は日差しが透けて緑がかる。太陽の方を見ているほど強い
  float crest = clamp(sw.x / (0.03 * uWaveAmp + 1e-4), 0.0, 1.0);
  vec2 dh = normalize(d.xz + 1e-6), sh = normalize(uSunDir.xz + 1e-6);
  float toward = pow(0.5 + 0.5 * dot(dh, sh), 4.0);
  vec3 body = uSeaBody + uSunE * (vec3(0.02, 0.09, 0.07) * (uSeaLook.y * crest * (0.25 + toward) * max(uSunDir.y, 0.0)));
  vec3 c = F * cloudySky(x, r) + uSeaGlintE * (seaGlint(n, v, uSeaLook.x + sw.w) * cloudTrans(x)) + (1.0 - F) * body;
  // 灯台の光が当たっている海面のきらめき（帯がこちらを向いたときは、灯火から手前へ光の道ができる）
  if (uLhOn > 0.0) {
    vec3 lv = uLhPos - x;
    float ld2 = dot(lv, lv);
    vec3 lw = lv * inversesqrt(ld2);
    c += uLhI * (lhProfile(-lw) / ld2 * seaGlintL(n, v, uSeaLook.x + sw.w, lw));
  }
  // 遠くはかすんで、地平線の空の色に近づく。海面までの空気で散った灯台の光の帯を足す
  return mix(c, skyRadiance(normalize(vec3(d.x, 0.02, d.z))), 1.0 - exp(-t / uSeaHaze)) + lighthouseSky(o, d, t);
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
// 全体照明：天井の長方形がむらなく光る面（拡散面光源）。点 p に届く光は、長方形の 4 辺から式で求める（光線を飛ばさないのでざらつかない）。
// 部屋は箱で、光る面は天井の中にあるので、部屋の中のどの面から見ても面全体が手前側にある（遮るものもない）
float ambEdge(vec3 a, vec3 b, vec3 n) {
  vec3 c = cross(a, b);
  float l = length(c);
  return l < 1e-6 ? 0.0 : acos(clamp(dot(a, b), -1.0, 1.0)) * dot(n, c) / l;
}
vec3 ambientIrradiance(vec3 p, vec3 n) {
  if (uAmbL.x + uAmbL.y + uAmbL.z <= 0.0 || p.y > uRoomMax.y - 1e-3) return vec3(0.0);
  float y = uRoomMax.y;
  vec3 v0 = normalize(vec3(uAmbRect.x, y, uAmbRect.z) - p);
  vec3 v1 = normalize(vec3(uAmbRect.y, y, uAmbRect.z) - p);
  vec3 v2 = normalize(vec3(uAmbRect.y, y, uAmbRect.w) - p);
  vec3 v3 = normalize(vec3(uAmbRect.x, y, uAmbRect.w) - p);
  return uAmbL * (0.5 * abs(ambEdge(v0, v1, n) + ambEdge(v1, v2, n) + ambEdge(v2, v3, n) + ambEdge(v3, v0, n)));
}
// 全体照明の光る面そのものの明るさ（目に見える天井パネル。部屋を照らす光は ambientIrradiance で足すので、ここは見え方だけ）
vec3 ambientPanel(int face, vec3 p) {
  return face == 2 && p.x > uAmbRect.x && p.x < uAmbRect.y && p.z > uAmbRect.z && p.z < uAmbRect.w ? uAmbL : vec3(0.0);
}
// 部屋の中の点 p（面の向き n）が受ける灯台の光。灯火の方へ窓を通って外へ出られれば届く（ガラスなら、その色を掛ける）
vec3 lighthouseIrr(vec3 p, vec3 n) {
  if (uLhOn <= 0.0) return vec3(0.0);
  vec3 v = p - uLhPos;
  float d2 = dot(v, v);
  vec3 w = v * inversesqrt(d2);
  float k = lhProfile(w);
  float c = -dot(n, w);
  if (k < 1e-4 || c <= 0.0 || !seesOutside(p, -w)) return vec3(0.0);
  return uLhI * (k * c / d2) * glassSunFactor(p, -w, false);
}
vec3 spotIrradiance(vec3 p, vec3 n) {
  vec3 e = ambientIrradiance(p, n) + lighthouseIrr(p, n);
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
  e += ambientIrradiance(b, vec3(0.0, 1.0, 0.0)) * exp(-WATER_ABS * uPoolDepth * 1.3); // 全体照明は斜めからも入るので、水の中の道のりを少し長めに見る
  return e * 0.97;
}
// 光線がライトの器具（小さな球）に当たれば、いちばん手前の器具の明るさ。
// 光を出すのは、向いている側（器具の口）だけで、後ろ側は暗い灰色の器具
vec3 spotLamp(vec3 o, vec3 d, float tMax) {
  vec3 col = vec3(0.0);
  if (uSpotLampOn < 0.5) return col;
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
  if (uCausOn == 0 || face >= 8) return 0.0;
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
  vec3 hw = uSource == 0 ? poolSurface(p0.xz) : seaWave(p0.xz);
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

// 窓から見える空（と海）から受ける光（窓の面の 1 点を選ぶ。四角い部屋は凸なので、窓はどこからでも遮られずに見える。読み込んだ部屋の形では、間に物がないかを確かめる）
// 窓から入る空の光。2 通りの選び方を混ぜる（多重重点サンプリング、バランス・ヒューリスティック）
// - 窓の中の点を選ぶ（skyNee）：小さい窓に強い。ただし窓のすぐ近くの点では「面積 ÷ 距離²」が極端に大きくなり、
//   これだけだと白い点（ファイアフライ）が出る（天井いっぱいの天窓の、壁の上の縁など）
// - 照り返しの光線（余弦に比例した向き）がそのまま窓から外へ出たとき（skyBsdf）：大きい窓に強い
// どちらも「光 × cos ÷（2 つの確率密度の和）」で数えるので、1 回の値は「光 × π」を超えず、平均の明るさは変わらない。
// 照り返しの光線は、もともと追っているものを使う（足す光線は、最後の点の 1 本だけ。indirect）
// 窓が 2 つ（天窓＋左の窓）のときは、どちらの窓の点を選ぶかを半々で決める。部屋は凸なので、ある向きの光線が抜ける窓は 1 つだけで、
// その向きの確率密度は「その窓を選ぶ確率 × その窓の点を選んだときの密度」になる（k = 1 つ目 / 2 つ目の窓）
float windowSel() { return uWin2On > 0.5 ? 0.5 : 1.0; }
vec3 windowOutwardK(int k) { return k == 2 ? vec3(0.0, 1.0, 0.0) : windowOutward(); }
float windowPdf(int k, vec3 w, float d2) {
  if (k == 0) return 0.0;
  // 窓の点を一様に選んだときの、方向あたりの確率密度
  vec4 r = k == 2 ? uWin2Rect : uWinRect;
  float area = (r.y - r.x) * (r.w - r.z);
  return windowSel() * d2 / (max(dot(windowOutwardK(k), w), 1e-6) * area);
}
// 窓の中の点を選んで数える空の光（放射照度。π で割ると、拡散面が返す光になる）
vec3 skyNee(vec3 p, vec3 n) {
  int k = uWin2On > 0.5 && rnd() < 0.5 ? 2 : 1;
  float r1 = rnd(), r2 = rnd();
  vec3 q = k == 2 ? vec3(mix(uWin2Rect.x, uWin2Rect.y, r1), uRoomMax.y, mix(uWin2Rect.z, uWin2Rect.w, r2)) : windowPoint(r1, r2);
  vec3 w = q - p;
  float d2 = dot(w, w);
  w *= inversesqrt(d2);
  float cp = dot(n, w), cq = dot(windowOutwardK(k), w);
  if (cp <= 0.0 || cq <= 0.0) return vec3(0.0);
  // 読み込んだ部屋の形は凸とは限らないので、窓の点までの間に物があれば届かない
  if (uPrimCount > 0.5) {
    int fo;
    float to = exitRoom(p, w, fo);
    if (to * to < d2 * 0.999 && !inWindow(fo, p + w * to)) return vec3(0.0);
  }
  return outsideRadianceAvg(w) * cp / (windowPdf(k, w, d2) + cp / PI);
}
// 照り返しの光線 d が窓 k から外へ出たとき（t = 窓までの距離）に数える空の光（拡散面が返す光、skyNee / π と同じ単位）
vec3 skyBsdf(vec3 n, vec3 d, float t, int k) {
  float pc = dot(n, d) / PI;
  return outsideRadianceAvg(d) * pc / (windowPdf(k, d, t * t) + pc);
}

vec3 sunIrradiance(vec3 p, vec3 n) {
  if (uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  vec3 l = sunDirAt(vec2(rnd(), rnd()));
  float c = dot(n, l);
  return c > 0.0 && seesOutside(p, l) ? uSunE * glassSunFactor(p, l, false) * (c * cloudTrans(p)) : vec3(0.0);
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
    if (inWindow(f, q)) { acc += thr * skyBsdf(n, d, t, windowIndex(f, q)); break; } // 窓から外へ出た：空の光の 2 つ目の見本
    if (b >= uBounces) break;
    acc += thr * screenLight(f, q, 5.0); // スクリーンに映した映像の光が、部屋をほんのり照らす（照り返しと同じくぼけた光）
    vec3 n2 = inwardNormal(f);
    vec3 a;
    vec3 e;
    q += n2 * EPS;
    if (uPoolOn == 1 && f == 3) {
      // 水盤の底：屈折して届いた日差し（光の揺らぎ）を、水に吸収されながら返す
      vec3 absorb = exp(-WATER_ABS * 2.0 * uPoolDepth);
      a = texAlbedo(3, q, vec3(${POOL_ALBEDO.toFixed(3)}), 20.0) * absorb;
      e = uSunE * causticBottom(q) + skyNee(q, n2) + spotIrradiance(q, n2) * 0.97;
    } else {
      a = albedoLod(f, q, 20.0); // 照り返しは、貼った画像の平均の色で返す
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
uniform float uSmoothR;     // ならす範囲の半径（画素の数。既定 3 = 7×7）
uniform float uSubN;        // 1 画素を何点に分けて計算するか（4 か 1）
uniform float uSunPts;      // 直射日光を確かめる太陽の円盤の点の数（既定 12）
uniform mat4 uViewProj;
in vec2 vUv;
out vec4 fragColor;

// 太陽の円盤の決まった 12 点から、窓を通って届く直射日光（影の縁のぼけは円盤の大きさで決まる）
// ---- プリズム（画面に出す段階で足す光。照り返しの計算には入れない）----
// 虹の色（t = 0 で赤 → 1 で紫）。少し白を混ぜて淡くする
vec3 spectrum(float t) {
  vec3 c = clamp(abs(fract(t * 0.8 + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return mix(c, vec3(0.6), 0.3);
}
// プリズムで日差しが変わる分（放射照度の差）。
// 虹：プリズム i に日が当たっていれば、日差しの進む向き d を、稜 A のまわりに「曲がる角度」〜「＋赤と紫の差」だけ曲げた扇の中に光が出る。
//   点 p がその扇の中にあれば、扇の中の角度で色が決まる。扇の幅はプリズムの大きさ。扇が広がる分だけ淡くなる（遠いほど淡い）
// 影：本来まっすぐ進むはずだった日差しの、プリズムの後ろの所は暗くなる
vec3 hungLight(vec3 p, vec3 n) {
  if (uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  vec3 d = -uSunDir; // 日差しの進む向き
  float cl = dot(n, uSunDir);
  bool lit = cl > 0.0 && seesOutside(p, uSunDir);
  float half_ = 0.5 * uPrismSize;
  vec3 sum = vec3(0.0);
  float shade = 0.0, cover = 0.0;
  vec3 hue = vec3(0.0); // 虹の色（扇の広がりで淡くしない）。日なたで、減らした白の代わりに足す
  for (int i = 0; i < MAX_PRISMS; i++) {
    if (float(i) >= uPrismCount) break;
    vec3 P = uPrismPos[i];
    if (!seesOutside(P, uSunDir)) continue; // プリズムに日が当たっていない
    float sunP = cloudTrans(P);
    vec3 v = p - P;
    // 影：まっすぐ進む日差しの線からの距離
    float s = dot(v, d);
    if (lit && s > 0.0) { float r = length(v - d * s) / half_; shade += exp(-r * r) * sunP; }
    // 虹
    float D = length(v);
    if (D < 0.05) continue;
    vec3 u = v / D;
    float c = dot(n, -u);
    if (c <= 0.0) continue;
    vec3 A0 = normalize(uPrismAxis[i] - d * dot(uPrismAxis[i], d));
    vec3 B0 = cross(d, A0);
    float b = half_ / D;                                       // プリズムの大きさによるぼけ（角度）
    float spread = uPrismSize / (uPrismDisp * D + uPrismSize); // 扇が広がって淡くなる割合
    // 面ごとに、稜を日差しのまわりに等しく回した向きで、虹の扇を出す（曲がる角度も面ごとに少し違う）
    for (int f = 0; f < 4; f++) {
      if (float(f) >= uPrismFacets) break;
      float th = 6.2832 * float(f) / uPrismFacets;
      vec3 A = A0 * cos(th) + B0 * sin(th);
      vec3 e = cross(A, d);
      float phi = atan(dot(u, e), dot(u, d)) - uPrismDev * (0.75 + 0.25 * float(f)); // 扇の始まり（赤）からの角度
      float inFan = smoothstep(-b, b, phi) * (1.0 - smoothstep(-b, b, phi - uPrismDisp));
      float w = dot(u, A) * D / half_;                     // 扇に垂直な向きのずれ（プリズムの大きさで割る）
      float m = inFan * exp(-w * w);
      if (m <= 1e-4) continue;
      vec3 col = spectrum(clamp(phi / uPrismDisp, 0.0, 1.0));
      sum += col * (2.0 * m * spread * c * sunP / uPrismFacets);
      hue += col * (m * sunP);
      cover += m * sunP;
    }
  }
  sum *= uPrismStrength;
  // 日なたに落ちた虹：そのままでは明るい日だまりに埋もれて色が見えないので、虹の範囲では白い日差しを uPrismVivid の割合だけ
  // 虹の色に置き換える（明るさはほぼそのまま）。プリズムの影（まっすぐ進むはずだった日差し）は 35% 暗くする
  if (!lit) return uSunE * sum;
  float sunHere = cl * cloudTrans(p);
  float k = uPrismVivid * min(cover, 1.0);
  vec3 swap = hue / max(cover, 1e-4) * 1.6; // 虹の色（平均の明るさをおよそ白に合わせる）
  return uSunE * (sum + sunHere * (k * (swap - vec3(1.0)) - vec3(min(shade, 1.0) * 0.35)));
}
// 水の光の揺らぎ。プリズムのときは、赤・緑・青を日差しの向きに少しずつずらして、縁を虹色ににじませる
// ---- A：日だまりの中の虹色の筋（演出寄り）----
vec2 prismHash(vec2 c) {
  vec3 q = fract(c.xyx * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}
// 日差しに垂直な面の上の模様（q は日差しに垂直な面での座標 m）。格子の各升に、確率 uStreakAmount で 1 本の虹色の筋を置く。
// 模様は日差しの向きにはどこまでも同じなので、斜めに当たる面では日差しの向きに長く伸びた筋になる。rgb = 色 × 濃さ、a = 濃さ
vec4 streakPattern(vec2 q) {
  float s = uStreakLen, cell = s * 1.3;
  vec2 gi = floor(q / cell);
  vec4 sum = vec4(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = gi + vec2(float(i), float(j));
      vec2 h = prismHash(c), h2 = prismHash(c + 17.0);
      if (h2.x > uStreakAmount) continue;
      vec2 ctr = (c + 0.2 + 0.6 * h) * cell;
      float ang = uStreakAngle + (h2.y - 0.5) * 0.6 + 0.25 * sin(uPrismPhase + 6.2832 * h.x);
      vec2 e = vec2(cos(ang), sin(ang));
      vec2 d = q - ctr;
      float a = dot(d, e) / s + 0.5;                   // 筋の端から端へ 0〜1（虹の色の並び）
      float w = dot(d, vec2(-e.y, e.x)) / (s * 0.25); // 筋の幅の向き
      float m = smoothstep(0.0, 0.2, a) * (1.0 - smoothstep(0.8, 1.0, a)) * exp(-w * w * 3.0);
      sum += vec4(spectrum(clamp(a, 0.0, 1.0)), 1.0) * m;
    }
  }
  return sum;
}
// 筋の所では、白い日差しを虹色の光に置き換える（日が差している所だけ）
vec3 streakLight(vec3 p, vec3 n) {
  if (uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  float c = dot(n, uSunDir);
  if (c <= 0.0 || !seesOutside(p, uSunDir)) return vec3(0.0);
  vec3 t, b; basis(uSunDir, t, b);
  vec4 pat = streakPattern(vec2(dot(p, t), dot(p, b)));
  vec3 delta = pat.rgb * (2.0 * uPrismStrength) - vec3(min(pat.a, 1.0) * min(uPrismStrength, 1.0));
  return uSunE * (c * cloudTrans(p)) * delta;
}

// ---- C：窓をプリズムの板で覆う ----
// 窓から入る日差しは、すべて板で曲がる。色 t（赤 0 → 紫 1）ごとに、太陽の向きを板の稜のまわりに「曲がる角度 ＋ 虹の広がり × t」だけ回し、
// 点 p からその向きに窓（同じ窓）が見えれば、その色の日差しが届く。日だまりは色ごとに少しずつずれて重なり、重なった所は白く、縁は虹色になる
const int PANEL_SAMPLES = 16;
vec3 spectrumPure(float t) {
  return clamp(abs(fract(t * 0.8 + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
vec3 panelLight(vec3 p, vec3 n) {
  if (uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  vec3 sum = vec3(0.0), wsum = vec3(0.0);
  for (int j = 0; j < PANEL_SAMPLES; j++) wsum += spectrumPure((float(j) + 0.5) / float(PANEL_SAMPLES));
  for (int k = 1; k <= 2; k++) {
    if (k == 2 && uWin2On < 0.5) break;
    if (dot(uSunDir, k == 2 ? vec3(0.0, 1.0, 0.0) : windowOutward()) <= 0.0) continue; // 太陽が、この窓の外側にない
    int face = k == 2 ? 2 : uWinFace;
    vec3 A = face == 2 ? vec3(cos(uPanelRidge), 0.0, sin(uPanelRidge)) : vec3(0.0, sin(uPanelRidge), cos(uPanelRidge));
    vec3 axs = cross(A, uSunDir);
    float ad = dot(A, uSunDir);
    for (int j = 0; j < PANEL_SAMPLES; j++) {
      float t = (float(j) + 0.5) / float(PANEL_SAMPLES);
      float ang = uPrismDev + uPrismDisp * t;
      vec3 L = uSunDir * cos(ang) + axs * sin(ang) + A * ad * (1.0 - cos(ang)); // 板を通った後に、この色の光がやって来る向き
      float c = dot(n, L);
      if (c <= 0.0) continue;
      int f;
      float tt = exitRoom(p, L, f);
      vec3 q = p + L * tt;
      if (k == 2 ? inWindow2(f, q) : inWindow1(f, q)) sum += spectrumPure(t) * c;
    }
  }
  return uSunE * (cloudTrans(p) * uPrismStrength) * sum / wsum;
}

// ---- D：日差しの先の虹の筋（窓ガラスに付けた小さなプリズムから出る、細い光の束）----
// 束 i は、ガラスの所 P で日を受け、日差しの向き d を稜 A のまわりに「曲がる角度 ＋ 虹の広がり × t」だけ曲げた向き L に進む（色 t ごとに少しずつ違う向き）。
// 点 p が L の線から近ければ（太さは進んだ距離で太くなる）、その色の光が届く。線からの距離で測るので、斜めに当たる面では日差しの向きに長く伸びた筋になり、
// 色は筋の幅の向きに並ぶ。束が太くなる分だけ淡くなる。日なたでは、B と同じく白い日差しを虹の色に置き換えて色を見せる
const int BEAM_SAMPLES = 7;
vec3 beamLight(vec3 p, vec3 n) {
  if (uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  vec3 d = -uSunDir;
  float cl = dot(n, uSunDir);
  bool lit = cl > 0.0 && seesOutside(p, uSunDir);
  float r0 = 0.5 * uPrismSize;
  vec3 wsum = vec3(0.0);
  for (int j = 0; j < BEAM_SAMPLES; j++) wsum += spectrumPure((float(j) + 0.5) / float(BEAM_SAMPLES));
  vec3 sum = vec3(0.0), hue = vec3(0.0);
  float cover = 0.0;
  for (int i = 0; i < MAX_PRISMS; i++) {
    if (float(i) >= uPrismCount) break;
    vec3 P = uPrismPos[i];
    if (!seesOutside(P, uSunDir)) continue; // ガラスのプリズムに日が当たっていない
    vec3 A = uPrismAxis[i] - d * dot(uPrismAxis[i], d);
    if (dot(A, A) < 1e-6) continue;
    A = normalize(A);
    vec3 e = cross(A, d);
    vec3 v = p - P;
    float sunP = cloudTrans(P);
    float mMax = 0.0;
    for (int j = 0; j < BEAM_SAMPLES; j++) {
      float t = (float(j) + 0.5) / float(BEAM_SAMPLES);
      float ang = uPrismDev + uPrismDisp * t;
      vec3 L = d * cos(ang) + e * sin(ang); // この色の光が進む向き
      float s = dot(v, L);
      if (s <= 0.0) continue;
      float c = dot(n, -L);
      if (c <= 0.0) continue;
      float R = r0 + uBeamBlur * s;
      vec3 w = v - L * s;
      float m = exp(-2.0 * dot(w, w) / (R * R));
      if (m <= 1e-4) continue;
      vec3 col = spectrumPure(t);
      sum += col * (m * (r0 * r0) / (R * R) * c * sunP);
      hue += col * (m * sunP);
      mMax = max(mMax, m);
    }
    cover += mMax * sunP;
  }
  sum *= uPrismStrength / max(dot(wsum, vec3(1.0 / 3.0)), 1e-4); // 色を足し合わせると白（明るさ 1）になるように
  if (!lit) return uSunE * sum;
  float sunHere = cl * cloudTrans(p);
  float k = uPrismVivid * min(cover, 1.0);
  vec3 swap = hue / max(dot(hue, vec3(1.0 / 3.0)), 1e-4); // 虹の色（平均の明るさを白に合わせる）
  return uSunE * (sum + sunHere * k * (swap - vec3(1.0)));
}

// プリズムで日差しが変わる分（A・B・D。C は日差しそのものを置き換えるので sunLight で扱う）
vec3 patternLight(vec3 p, vec3 n) {
  if (uPrismOn < 0.5) return vec3(0.0);
  if (uPrismPattern < 0.5) return streakLight(p, n);
  if (uPrismPattern < 1.5) return hungLight(p, n);
  if (uPrismPattern > 2.5 && uPrismPattern < 3.5) return beamLight(p, n);
  return vec3(0.0);
}

// ---- E・F・G 共通：有機的な縁 ----
// ゆっくり形を変える、なめらかな揺らぎ（-1〜1 くらい）。座標を自分の揺らぎで少しゆがめて、丸みのある不規則な形にする
float orgNoise(vec2 q, float t) {
  vec2 w = q + 0.6 * vec2(sin(q.y * 1.7 + t * 0.9), sin(q.x * 1.3 - t * 0.7));
  return 0.5 * sin(w.x * 2.1 + t) + 0.35 * sin(w.y * 2.7 - 1.3 * t + 1.1) + 0.15 * sin((w.x + w.y) * 4.3 + 0.7 * t);
}
// 内側の淡い色（明るさはそのまま、amt で濃さ）
vec3 pastelTint(vec2 q, float t, float amt) {
  vec3 h = spectrumPure(fract(0.5 + 0.6 * orgNoise(q, t)));
  return vec3(1.0) + amt * 0.6 * (h / max(dot(h, vec3(1.0 / 3.0)), 1e-3) - vec3(1.0));
}
// 縁の光の割合（色ごと）。sd は縁からの符号つきの距離（中は負）。e = (色の帯の幅, ぼかしの幅, 外へ広がる光の明るさ, 外へ広がる幅)、
// lk = (色の濃さ, 外へ広がる光の色合い)。中は 1（白）。縁は、色 t ごとに縁の位置を 帯の幅 × (t − 0.5) だけずらして重ねるので虹色の帯になる。
// 外へは、縁の光が届かない分だけ淡い色の光を足し、外へ広がる幅で消えていく
vec3 organicEdge(float sd, vec4 e, vec2 lk) {
  vec3 sum = vec3(0.0), wsum = vec3(0.0);
  for (int j = 0; j < 7; j++) {
    float t = (float(j) + 0.5) / 7.0;
    vec3 c = spectrumPure(t);
    wsum += c;
    sum += c * (1.0 - smoothstep(-e.y, e.y, sd + (t - 0.5) * e.x));
  }
  vec3 col = sum / wsum;
  float l = dot(col, vec3(1.0 / 3.0));
  col = max(vec3(l) + (col - vec3(l)) * lk.x, vec3(0.0));
  float h = 1.0 - min(max(sd, 0.0) / e.w, 1.0);
  return col + (e.z * h * h * (1.0 - min(l, 1.0))) * (vec3(0.3) + 0.7 * spectrumPure(lk.y));
}

// E・F：点 p から日差しの向きに窓の面まで進んだ所の、窓の縁までの符号つきの距離（窓の面の上で測る m、中は負）。q はその窓の面の上の位置。
// 太陽が窓の外側になければ大きな値。天窓＋左の窓で 2 つが角でつながっているときは、つながっている辺は縁にしない（天井と壁の境目に色の帯が出ないように）
float windowSd(vec3 p, out vec2 q) {
  float best = 1e3;
  q = vec2(0.0);
  for (int k = 1; k <= 2; k++) {
    if (k == 2 && uWin2On < 0.5) break;
    if (dot(uSunDir, k == 2 ? vec3(0.0, 1.0, 0.0) : windowOutward()) <= 0.0) continue;
    int face = k == 2 ? 2 : uWinFace;
    float t = planeT(face, p, uSunDir);
    if (t <= 0.0) continue;
    vec3 h = p + uSunDir * t;
    vec2 uv = face == 2 ? h.xz : h.zy;
    vec4 r = k == 2 ? uWin2Rect : uWinRect;
    if (uWin2On > 0.5 && uWin2Rect.x <= uRoomMin.x + 1e-3 && uWinRect.w >= uRoomMax.y - 1e-3) {
      if (k == 1) r.w = 1e3; else r.x = -1e3;
    }
    vec2 dd = abs(uv - 0.5 * vec2(r.x + r.y, r.z + r.w)) - 0.5 * vec2(r.y - r.x, r.w - r.z);
    float sd = length(max(dd, 0.0)) + min(max(dd.x, dd.y), 0.0);
    if (sd < best) { best = sd; q = uv; }
  }
  return best;
}
// F：有機的な日だまりの縁。窓の面の上で縁を揺らぎでずらし、縁を虹色の帯にする（ふつうの直射日光の代わり）
vec3 organicSun(vec3 p, vec3 n) {
  float cl = dot(n, uSunDir);
  if (cl <= 0.0 || uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  vec2 q;
  float sd = windowSd(p, q);
  if (sd > 1e2) return vec3(0.0);
  vec2 qs = q / uOrgShape.y;
  vec3 m = organicEdge(sd + uOrgShape.x * orgNoise(qs, uOrgShape.z), uOrgEdge, uOrgLook);
  m *= pastelTint(qs * 0.3 + 3.1, uOrgShape.z * 0.5, uOrgShape.w);
  return uSunE * (cl * cloudTrans(p)) * m;
}

// H：水のきらめき。窓の面の上の位置で、ゆっくり動く点で区切った網目を作り、網目の線を明るくする（水底に映る光のように）。
// 赤・緑・青で網目を少しずつずらして読むので線の縁が虹色になり、線のまわりには薄い膜のような虹色をにじませる。日差しに掛ける倍率（色ごと）を返す
vec2 shimHash(vec2 c) {
  return fract(sin(vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)))) * 43758.5453);
}
// x のいちばん近い網目の線までの距離（網目の 1 つ分 = 1）
float shimCell(vec2 x, float t) {
  vec2 i = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0;
  for (int b = -1; b <= 1; b++) {
    for (int a = -1; a <= 1; a++) {
      vec2 g = vec2(float(a), float(b));
      vec2 r = g + 0.5 + 0.4 * sin(t + 6.2832 * shimHash(i + g)) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
  }
  return sqrt(d2) - sqrt(d1);
}
// 線の明るさ（芯と、まわりの淡い光）
float shimLine(float e, float w) {
  return exp(-e * e / (w * w)) + 0.25 * exp(-e / (3.0 * w));
}
// 色の並び（0〜1）の位置 s の色。選んだ色があればその間をつなぎ、なければ虹の色の範囲から取る
vec3 shimColorAt(float s) {
  if (uShimPalN < 1.5) return spectrumPure(mix(uShimColor.y, uShimColor.z, s));
  float k = clamp(s, 0.0, 1.0) * (uShimPalN - 1.0);
  int i = int(min(floor(k), uShimPalN - 2.0));
  return mix(uShimPal[i], uShimPal[i + 1], k - float(i));
}
// 色の濃さ（明るさはそのまま）
vec3 shimSat(vec3 c) {
  float l = dot(c, vec3(1.0 / 3.0));
  return max(vec3(l) + (c - vec3(l)) * uShimColor.w, vec3(0.0));
}
// 網目を置く位置。面に置くときは、面の向きに合わせた 2 つの軸（床・天井は左右と奥行き、左右の壁は奥行きと高さ、奥と手前の壁は左右と高さ）
vec3 shimmer(vec3 p, vec3 n) {
  vec2 q;
  if (uShimSurface > 0.5) q = abs(n.y) > 0.5 ? p.xz : (abs(n.x) > 0.5 ? p.zy : p.xy);
  else if (windowSd(p, q) > 1e2) return vec3(1.0);
  float t = uShimShape.w, w = uShimShape.y;
  vec2 x = q / uShimShape.x;
  x += uShimShape.z * vec2(orgNoise(x * 0.5, t), orgNoise(x * 0.5 + 7.3, 1.1 * t));
  vec2 dd = uShimLook.z * vec2(0.6, 0.8);
  float e = shimCell(x, t);
  // 線の縁：色の数だけ網目をずらして読み、色ごとの線を重ねる（ぴったり重なった所は色の平均、ずれた所は色が分かれる）
  float nc = uShimColor.x;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int j = 0; j < MAX_SHIM_COLORS; j++) {
    if (float(j) >= nc) break;
    float s = float(j) / (nc - 1.0);
    vec3 c = shimColorAt(s);
    sum += c * shimLine(shimCell(x + (2.0 * s - 1.0) * dd, t), w);
    wsum += dot(c, vec3(0.2126, 0.7152, 0.0722));
  }
  vec3 l = shimSat(sum / max(wsum, 1e-3));
  // 膜の色：色の並びを行って戻る（端の色から反対の端の色へ飛ばない）
  vec3 film = shimSat(shimColorAt(abs(2.0 * fract(0.5 * orgNoise(x * 0.4 + 2.7, 0.6 * t) + 2.0 * e) - 1.0)));
  film /= max(dot(film, vec3(1.0 / 3.0)), 1e-3);
  vec3 m = (uShimLook.x * uShimBaseCol + uShimLook.y * l * uShimLineCol) * mix(vec3(1.0), film, uShimLook.w * exp(-e / (4.0 * w)));
  return mix(vec3(1.0), m, uShimOn);
}

// G：虹のしみ。窓辺の見えない物 i（位置 P）を通った日差しが、日差しの向き d から稜 A のまわりに曲がって進み（向き L）、当たった面にしみを作る。
// 点 p を L に垂直な面で測った位置を、進んだ距離で広がる半径 R で割り、その向きごとに揺らぐ半径（丸みのある不定形）と比べて縁からの距離にする。
// 光は広がる分だけ淡くなる。斜めに当たる面では、日差しの向きに伸びた形になる
vec3 blobLight(vec3 p, vec3 n) {
  if (uBlobCount < 0.5 || uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  vec3 d = -uSunDir;
  float r0 = uBlobBeam.x;
  float reach = 1.0 + uBlobShape.x + 0.5 * abs(uBlobEdge.x) + uBlobEdge.y + (uBlobEdge.z > 0.0 ? uBlobEdge.w : 0.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < MAX_BLOBS; i++) {
    if (float(i) >= uBlobCount) break;
    vec3 P = uBlobPos[i];
    if (!seesOutside(P, uSunDir)) continue;
    vec3 A = uBlobAxis[i] - d * dot(uBlobAxis[i], d);
    if (dot(A, A) < 1e-6) continue;
    A = normalize(A);
    vec3 L = d * cos(uBlobBeam.z) + cross(A, d) * sin(uBlobBeam.z);
    vec3 v = p - P;
    float s = dot(v, L);
    if (s <= 0.0) continue;
    float c = dot(n, -L);
    if (c <= 0.0) continue;
    float R = r0 + uBlobBeam.y * s;
    vec3 w = v - L * s;
    vec2 xy = vec2(dot(w, A), dot(w, cross(L, A))) / R;
    float r = length(xy);
    if (r > reach) continue;
    float th = atan(xy.y, xy.x + 1e-6);
    float ph = float(i) * 2.399, t = uBlobShape.y;
    float rr = 1.0 + uBlobShape.x * (0.5 * sin(2.0 * th + ph + t) + 0.3 * sin(3.0 * th + 1.7 * ph - 0.8 * t) + 0.2 * sin(5.0 * th + 2.3 * ph + 1.3 * t));
    vec3 m = organicEdge(r - rr, uBlobEdge, uBlobLook) * pastelTint(xy + ph, 0.5 * t, uBlobShape.z);
    sum += m * ((r0 * r0) / (R * R) * c * cloudTrans(P));
  }
  return uSunE * (uBlobBeam.w * sum);
}

// プリズムで日差しに足す光（A・B・D と G。C と F は日差しそのものを置き換えるので sunLight で扱う）
vec3 prismLight(vec3 p, vec3 n) {
  return patternLight(p, n) + blobLight(p, n);
}
bool panelOn() { return uPrismOn > 0.5 && uPrismPattern > 1.5 && uPrismPattern < 2.5; }
vec3 causticRGB(int f, vec3 p, vec3 n) {
  float c = causticAt(f, p);
  if (uPrismCaus <= 0.0) return vec3(c);
  vec3 s = uSunDir - n * dot(uSunDir, n);
  vec3 d = dot(s, s) > 1e-6 ? normalize(s) : (abs(n.y) > 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0));
  // 面の縁（隣の面との境目）に近い所は、ずらして読む所が面の外にはみ出すので、色のずれを消していく
  vec3 q = min(p - uRoomMin, uRoomMax - p) + abs(n) * 1e3;
  float rim = smoothstep(0.0, max(uPrismFadeM, 0.1), min(q.x, min(q.y, q.z)));
  return mix(vec3(c), vec3(causticAt(f, p + d * uPrismCaus), c, causticAt(f, p - d * uPrismCaus)), rim);
}
// 水盤の底の光の揺らぎ。プリズムのときは、赤・緑・青を日差しの向きに少しずつずらして読む。
// 色のずれは fade（日なたの奥で 1、日なたと影の境目に近づくと 0）だけ効かせる
vec3 causticBottomRGB(vec3 b, float fade) {
  float c = causticBottom(b);
  if (fade <= 0.0 || uPrismCaus <= 0.0) return vec3(c);
  vec2 s = uSunDir.xz;
  vec2 d = (dot(s, s) > 1e-6 ? normalize(s) : vec2(1.0, 0.0)) * uPrismCaus;
  vec3 rgb = vec3(causticBottom(b + vec3(d.x, 0.0, d.y)), c, causticBottom(b - vec3(d.x, 0.0, d.y)));
  return mix(vec3(c), rgb, fade);
}
// 水面の点 o が、日なたの奥にどれだけ入っているか（0〜1）。o のまわりの半径 uPrismFadeM の輪の 8 点と o で、窓を通して太陽が見えるかを数え、
// 全部見えれば 1、半分（ちょうど境目）以下なら 0。境目から日なたへ uPrismFadeM くらいの幅で、なめらかに 0 → 1 になる（uPrismFadeM = 0 なら、o だけで決まる）
float sunInterior(vec3 o) {
  float v = seesOutside(o, uSunDir) ? 1.0 : 0.0;
  for (int k = 0; k < 8; k++) {
    float a = 0.7854 * float(k);
    if (seesOutside(o + vec3(cos(a), 0.0, sin(a)) * uPrismFadeM, uSunDir)) v += 1.0;
  }
  // 水盤の縁（壁ぎわ）でも消す（色ごとにずらして読む所が、水盤の外にはみ出さないように）
  float rim = min(min(o.x - uRoomMin.x, uRoomMax.x - o.x), min(o.z - uRoomMin.z, uRoomMax.z - o.z));
  return smoothstep(0.5, 1.0, v / 9.0) * smoothstep(0.0, max(uPrismFadeM, 0.1), rim);
}

vec3 sunDirect(vec3 p, vec3 n) {
  if (uSunE.x + uSunE.y + uSunE.z <= 0.0) return vec3(0.0);
  float sum = 0.0;
  int np = int(uSunPts); // 太陽の円盤の点の数（既定 12。軽くするときは減らす）
  for (int k = 0; k < 12; k++) {
    if (k >= np) break;
    vec2 u = vec2((float(k) + 0.5) / float(np), fract(float(k) * 0.618034));
    vec3 l = sunDirAt(u);
    float c = dot(n, l);
    if (c > 0.0 && seesOutside(p, l)) sum += c;
  }
  return sum > 0.0 ? uSunE * (sum / float(np) * cloudTrans(p)) : vec3(0.0);
}
// 画面に出すときの直射日光（プリズムを含む。C のときは、板で曲がった日差しに置き換える）
vec3 sunLight(vec3 p, vec3 n) {
  if (panelOn()) return panelLight(p, n) + blobLight(p, n);
  vec3 sun = uOrgOn > 0.5 ? organicSun(p, n) : sunDirect(p, n);
  if (uGlassMask > 0.5 && sun.x + sun.y + sun.z > 0.0) sun *= glassSunFactor(p, uSunDir, true); // ガラスを通った日差し（色・光の網目・虹）
  if (uShimOn > 0.0 && sun.x + sun.y + sun.z > 0.0) sun *= shimmer(p, n);
  return sun + prismLight(p, n);
}

// 照り返しの成分を、同じ面の近くの画素どうしでならす
vec3 smoothedIndirect(vec2 px, int face, vec3 pc) {
  vec3 center = texture(uAccum, px / uRes).rgb;
  if (uStride <= 0.0) return center;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  int rad = int(uSmoothR); // ならす範囲の半径（既定 3 = 7×7）
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      if (abs(i) > rad || abs(j) > rad) continue;
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
  return a * ind + a / PI * (sunLight(q + n * EPS, n) + uSunE * causticRGB(f, q, n) + spotIrradiance(q + n * EPS, n)) + screenLight(f, q, 2.0) + ambientPanel(f, q);
}

// 水盤の底に届く日差し。C（プリズムの板）のときは、板で曲がった日差し（水面の揺らぎは省く）
// E：水盤の日だまりの縁をずらす、ゆっくり進む大きな波（-1〜1 くらい）。向きの違う 3 つの波を重ね、少しゆがめて丸みを出す
float waveEdge(vec2 xz) {
  float k = 6.2832 / uWaveShape.y, t = uWaveShape.z;
  vec2 q = xz + 0.08 * uWaveShape.y * vec2(sin(xz.y * k * 0.7 + 0.3 * t), sin(xz.x * k * 0.6 - 0.4 * t));
  return 0.5 * sin(dot(q, vec2(0.8, 0.6)) * k - t) + 0.3 * sin(dot(q, vec2(-0.5, 0.87)) * k * 1.37 - 1.21 * t + 1.3)
    + 0.2 * sin(dot(q, vec2(0.96, -0.28)) * k * 2.11 - 1.6 * t + 0.4);
}
// E・F のときは、光の揺らぎ c を、縁の光の割合 edge（色ごと）で置き換える（日だまりの外へ広がった所は、平らな水面を通った日差しの量 flatSun）
vec3 bottomSun(vec3 b, float fade, vec3 edge, float flatSun, float inner) {
  vec3 top = vec3(b.x, EPS, b.z), up = vec3(0.0, 1.0, 0.0);
  if (panelOn()) return panelLight(top, up) * 0.97 + blobLight(top, up);
  vec3 c = causticBottomRGB(b, fade);
  if (uWaveOn > 0.5 || uOrgOn > 0.5) c = mix(vec3(flatSun), c, inner) * edge;
  if (uGlassMask > 0.5 && c.x + c.y + c.z > 0.0) c *= glassSunFactor(top, uSunDir, true);
  if (uShimOn > 0.0 && c.x + c.y + c.z > 0.0) c *= shimmer(top, up);
  return uSunE * c + prismLight(top, up);
}

// 水盤：水面で反射する光と、屈折して底から戻る光を、反射の割合（フレネル）で混ぜる
vec3 poolRadiance(vec3 p, vec3 d, vec3 ind) {
  // 壁の下が開いているときは、つながる面に近いほど窓の外の海と同じ波（WebGL2 の海は正弦波）
  float kSea = poolSeaInflow(p.xz);
  vec3 hwp = poolWave(p.xz);
  if (kSea > 1e-3) hwp = mix(hwp, seaSurface(p.xz, distance(uCamPos, p) * uPixAngle / sqrt(max(-d.y, 1e-3))).xyz, kSea);
  vec3 n = waveNormal(hwp);
  float F = fresnelWater(dot(-d, n));
  // 屈折して底へ。水に吸収されて、深いほど青緑になる（見る光の道のりと、日差しが底まで届く道のり）
  vec3 rd = refract(d, n, 1.0 / IOR);
  float tb = (-uPoolDepth - p.y) / min(rd.y, -1e-3);
  vec3 b = p + rd * tb;
  vec3 absorb = exp(-WATER_ABS * (tb + uPoolDepth));
  // 光の揺らぎのにじみ（A〜D）は、日なたと影の境目・水盤の縁で消す。
  // E：日差しが底の b へ届くときに水面を通った所で、日だまりの縁（窓の縁）からの距離を進む波でずらし、縁の光（虹色の帯と、外へ広がる光）を求める
  float fade = 0.0, flatSun = 0.0, inner = 1.0;
  vec3 edge = vec3(1.0);
  if (uPrismOn > 0.5 && (uPrismCaus > 0.0 || uWaveOn > 0.5 || uOrgOn > 0.5) && uSunE.x + uSunE.y + uSunE.z > 0.0) {
    vec3 ts = refract(-uSunDir, vec3(0.0, 1.0, 0.0), 1.0 / IOR);
    vec3 entry = b - ts * (b.y / min(ts.y, -1e-3));
    vec3 e0 = vec3(entry.x, EPS, entry.z);
    if (uPrismCaus > 0.0) fade = sunInterior(e0);
    if (uWaveOn > 0.5 || uOrgOn > 0.5) {
      vec2 qw;
      float pd = windowSd(e0, qw);
      if (uWaveOn > 0.5) edge = organicEdge(pd + uWaveShape.x * waveEdge(entry.xz), uWaveEdge, uWaveLook);
      else {
        // F（E がオフのとき）：部屋の面と同じく、窓の面の上の揺らぎで縁をずらす
        vec2 qs = qw / uOrgShape.y;
        edge = organicEdge(pd + uOrgShape.x * orgNoise(qs, uOrgShape.z), uOrgEdge, uOrgLook) * pastelTint(qs * 0.3 + 3.1, uOrgShape.z * 0.5, uOrgShape.w);
      }
      flatSun = max(uSunDir.y, 0.0) * (1.0 - fresnelWater(uSunDir.y)) * cloudTrans(e0);
      inner = smoothstep(0.0, -0.15, pd); // 日だまりの縁の近くは、光の揺らぎの画像の縁が見えないよう平らな水面の値に
    }
  }
  vec3 lb = texAlbedo(3, b, vec3(${POOL_ALBEDO.toFixed(3)}), -1.0) / PI * ((bottomSun(b, fade, edge, flatSun, inner) + PI * ind) * absorb + spotBottom(b) * exp(-WATER_ABS * tb));
  // 海とつながる面を、底に着く前に抜けると、その先は深い海の水（窓の外の海の水の色）。ガラスで仕切るときはガラスの色を掛ける
  int wf;
  float tw = poolSeaWall(p, rd, wf);
  if (tw < tb) lb = uPoolSea < 1.5 ? uSeaBody * uGlassTintF[wf] : uSeaBody;
  // 反射：窓の外（空・海と、映り込んだ太陽のきらめき）か、部屋の面
  vec3 rr = reflect(d, n);
  rr.y = abs(rr.y); // 海の波が入った急な波では、跳ね返りが下を向くことがある（窓の外の海と同じく、上へ折り返す）
  vec3 o = vec3(p.x, EPS, p.z);
  int f2;
  float t2 = exitRoom(o, rr, f2);
  vec3 q = o + rr * t2;
  vec3 lr;
  if (inWindow(f2, q)) {
    // 映り込んだ太陽のきらめき
    lr = outsideRadiance(q, rr) + uSunE * (sunLobe(rr) * cloudTrans(q));
  } else {
    lr = surfaceRadiance(f2, q, ind);
  }
  lr += spotLamp(o, rr, t2); // 水面に映るライトのきらめき
  return (1.0 - F) * lb + F * lr;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// ガラスの壁：外の景色（空・海）を透かし、部屋の中を映す。映る割合はフレネル反射（ガラスの屈折率 1.5、真正面で約 4%）。
// 斜めに見るほどガラスの中を長く通るので、ガラスの色（わずかな緑）が濃くなる。
// 映り込みは、画素の光線をガラスで反射させた先を、ふつうの画素と同じ処理で描いて、反射の割合を掛ける（水盤などの処理を 2 つ持たないため）
float glassFresnel(float c) { return 0.04 + 0.96 * pow(1.0 - c, 5.0); }
vec3 glassTint(int f, float c) { return pow(uGlassTintF[f], vec3(1.0 / max(c, 0.2))); }

// 無限大か NaN（GPU によっては isnan が最適化で消えるので、ビットで調べる）
bool isBad(vec3 v) {
  uvec3 e = floatBitsToUint(v) & uvec3(0x7f800000u);
  return any(equal(e, uvec3(0x7f800000u)));
}

// 画素の中の 1 点（q）の明るさ：窓の外・反射率・直射日光・光の揺らぎ
vec3 subSample(vec2 q, vec3 ind) {
  int f; vec3 p, d;
  if (!primaryHit(q, f, p, d)) return OUTSIDE;
  vec3 lamp = spotLamp(uCamPos, d, distance(uCamPos, p)); // ライトの器具そのもの
  if (lamp.x + lamp.y + lamp.z > 0.0) return lamp;
  // ガラスの壁：透けた外の景色を足し、光線を反射させて、その先を下の処理で描く（反射の割合 w を掛ける）
  float w = 1.0;
  vec3 ind2 = ind;
  vec3 col = vec3(0.0);
  if (isGlass(f, p)) {
    // 表面の形：傾きで面の向きを傾け（映り込みがゆがむ）、透けて見える向きを (n−1)·∇h だけ曲げる（外の景色がゆがむ）。虹がオンなら色ごとに曲げ方を変える
    vec2 gg; vec3 gH;
    glassWaves(f, glassUV(f, p), gg, gH);
    vec3 tu, tv;
    glassAxes(f, tu, tv);
    vec3 slope = gg.x * tu + gg.y * tv;
    vec3 gn = normalize(inwardNormal(f) - slope);
    float c = clamp(dot(-d, gn), 0.0, 1.0);
    w = glassFresnel(c);
    vec3 lt = outsideRadiance(p, normalize(d + 0.5 * slope));
    if (uGlassWaveB[f].x > 0.0 && uGlassWaveA[f].x > 0.5) {
      float dd = 0.012 * uGlassWaveB[f].x * 0.5;
      lt = vec3(outsideRadiance(p, normalize(d + (0.5 - dd) * slope)).r, lt.g, outsideRadiance(p, normalize(d + (0.5 + dd) * slope)).b);
    }
    col += (1.0 - w) * (lt + moonDisk(p, normalize(d + 0.5 * slope))) * glassTint(f, c);
    vec3 o2 = p + gn * EPS;
    d = reflect(d, gn);
    float t2 = exitRoom(o2, d, f);
    p = o2 + d * t2;
    col += w * spotLamp(o2, d, t2);
    if (inWindow(f, p)) return col + w * (outsideRadiance(p, d) + moonDisk(p, d) + uSunE * (sunLobe(d) * cloudTrans(p)));
    // 映った所の照り返しは、その所が画面に映っていればその画素の値を使う
    vec4 cc = uViewProj * vec4(p, 1.0);
    vec2 uv = cc.xy / max(cc.w, 1e-6) * 0.5 + 0.5;
    if (cc.w > 0.0 && all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) ind2 = texture(uAccum, uv).rgb;
  }
  if (inWindow(f, p)) return col + outsideRadiance(p, d) + moonDisk(p, d);
  if (uPoolOn == 1 && f == 3) return col + w * poolRadiance(p, d, ind2);
  vec3 n = inwardNormal(f);
  vec3 a = albedo(f, p);
  return col + w * (a * ind2 + a / PI * (sunLight(p + n * EPS, n) + uSunE * causticRGB(f, p, n) + spotIrradiance(p + n * EPS, n)) + screenLight(f, p, -1.0) + ambientPanel(f, p));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  gView = true;
  int fc; vec3 pc, dc;
  bool hitC = primaryHit(px, fc, pc, dc);
  vec3 ind = hitC && !inWindow(fc, pc) ? smoothedIndirect(px, fc, pc) : vec3(0.0);

  // 画素の中の 4 点で求める（縁のギザギザを抑える）。計算が壊れた点（NaN・無限大）は捨て、残りの点で埋める
  // （Windows の GPU では、うねりのあるガラスの所で、まれに壊れた値が出て黒い点や線になった。WebGPU 版と同じ）
  vec3 col = vec3(0.0);
  float good = 0.0;
  int ns = int(uSubN); // 4（既定）か 1（軽くするとき。画素の真ん中の 1 点）
  for (int k = 0; k < 4; k++) {
    if (k >= ns) break;
    vec2 o = ns == 1 ? vec2(0.0) : vec2(k == 1 || k == 3 ? 0.25 : -0.25, k >= 2 ? 0.25 : -0.25);
    vec3 c = subSample(px + o, ind);
    if (!isBad(c)) { col += c; good += 1.0; }
  }
  col *= 4.0 / max(good, 1.0);
  col = max(col, vec3(0.0)) * (0.25 * uExposure); // プリズムで白を減らした所が負にならないように
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
  private readonly core: RoomCore;
  /** 面に貼る画像の束（どの材質からも同じ物を参照する）と、送った画像の組 */
  private readonly texArr: { value: THREE.DataArrayTexture } = { value: new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1) };
  private texKey = '';

  constructor(core: RoomCore) {
    this.core = core;
    this.texArr.value.needsUpdate = true;
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
    const shared = { ...core.shared, uScreenTex: { value: this.screenTarget.texture }, uTexArr: this.texArr };
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
    if (this.core.textures.key !== this.texKey) this.uploadTextures();
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

    // 段階 1：空の光と照り返し（1 フレームおきにするときは、間のフレームは前の結果をそのまま使う）
    if (frame.trace) {
      this.traceMat.uniforms['uPrev']!.value = this.readT.texture;
      this.quad.material = this.traceMat;
      renderer.setRenderTarget(this.writeT);
      renderer.render(this.quadScene, this.quadCam);
      [this.readT, this.writeT] = [this.writeT, this.readT];
    }

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

  // 面に貼る画像を、画像の束（2D 配列テクスチャ）にまとめて送る。縮小の段は GPU で作る
  private uploadTextures(): void {
    const set = this.core.textures;
    this.texKey = set.key;
    const n = Math.max(1, set.pixels.length);
    const size = set.pixels.length ? TEX_SIZE : 1;
    const data = new Uint8Array(size * size * 4 * n);
    set.pixels.forEach((p, i) => data.set(p.levels[0]!, i * size * size * 4));
    const tex = new THREE.DataArrayTexture(data, size, size, n);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = set.pixels.length > 0;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    this.texArr.value.dispose();
    this.texArr.value = tex;
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
    this.texArr.value.dispose();
    this.screenScene?.inst.dispose();
    this.screenScene?.gl.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // 作り直しを繰り返しても WebGL コンテキストが溜まらないように
  }
}
