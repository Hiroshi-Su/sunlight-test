// room モードを WebGPU で描く。シェーダーは WGSL で、計算は WebGL2 版（src/room/gl.ts の GLSL）と同じ。
// 値は src/room/core.ts が決めたものを、1 つの storage バッファにまとめて渡す（並べ方は src/gpu/layout.ts が自動で決める）。
//
// 座標の向きの違い：WebGL の gl_FragCoord は左下が原点、WebGPU の画素の位置は左上が原点。
// 計算は WebGL と同じ向き（下から上）で行い、画像を読み書きするところだけ上下を入れ替える（accumAt・causTex・screenLight）
import * as THREE from 'three';
import { type Layout, buildLayout, writeLayout } from '../gpu/layout.ts';
import { FULLSCREEN_VS, FullscreenPipeline, type Gpu, MipGenerator, configureCanvas, textureCache } from '../gpu/webgpu.ts';
import { WGSL_SIMPLEX3 } from '../scenes/shader.ts';
import { CAUSTIC_FACES, CAUSTIC_SIZE, FLOOR_ALBEDO, POOL_ALBEDO, SCREEN_ALBEDO, SCREEN_IMAGE, WALL_ALBEDO, type CausticPass, type RoomCore, type RoomFrame } from './core.ts';
import type { RoomRenderer } from './gl.ts';
import { MAX_BLOBS, MAX_PRISMS, MAX_SHIM_COLORS, MAX_SHIM_PALETTE, MAX_SPOTS, type RoomScreenImage } from './model.ts';
import { GpuOcean, OCEAN_LODS, OCEAN_N } from './ocean.ts';
import { WATER_ABSORPTION, WATER_IOR, WATER_WGSL } from './water.ts';

const f3 = (n: number): string => n.toFixed(4);
const ACCUM: GPUTextureFormat = 'rgba32float';
const CAUSTIC: GPUTextureFormat = 'r16float';
const SCREEN: GPUTextureFormat = 'rgba8unorm';

// ---- 全段階で共通の部分：部屋・窓・太陽・空・雲・水面、カメラの光線 ----
const common = /* wgsl */ `
const PI = 3.14159265358979;
const EPS = 1e-4;
const IOR = ${WATER_IOR.toFixed(3)};
const WATER_ABS = vec3f(${WATER_ABSORPTION.map(f3).join(', ')});
const OUTSIDE = vec3f(0.02); // 部屋の外（カメラが外にあり、部屋に当たらない方向）
const MAX_SPOTS = ${MAX_SPOTS};
const MAX_PRISMS = ${MAX_PRISMS};
const MAX_BLOBS = ${MAX_BLOBS};
const MAX_SHIM_COLORS = ${MAX_SHIM_COLORS};
const MAX_SHIM_PALETTE = ${MAX_SHIM_PALETTE};

${WATER_WGSL}

// n を軸にした正規直交基底
struct Basis { t: vec3f, b: vec3f }
fn basis(n: vec3f) -> Basis {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let c = n.x * n.y * a;
  return Basis(vec3f(1.0 + s * n.x * n.x * a, s * c, -s * n.x), vec3f(c, s + n.y * n.y * a, -n.y));
}

fn safeDir(d: vec3f) -> vec3f { return select(d, vec3f(1e-8), abs(d) < vec3f(1e-8)); }

// 部屋（直方体）の内側から出る点。面：0 = +x, 1 = -x, 2 = +y（天井）, 3 = -y（床）, 4 = +z（手前）, 5 = -z（奥・スクリーン）
struct Exit { t: f32, face: i32 }
fn exitRoom(o: vec3f, d: vec3f) -> Exit {
  let dd = safeDir(d);
  let bound = mix(u.uRoomMin, u.uRoomMax, step(vec3f(0.0), dd));
  let t = (bound - o) / dd;
  if (t.x <= t.y && t.x <= t.z) { return Exit(t.x, select(1, 0, dd.x > 0.0)); }
  if (t.y <= t.z) { return Exit(t.y, select(3, 2, dd.y > 0.0)); }
  return Exit(t.z, select(5, 4, dd.z > 0.0));
}

// 面の平面（面の外側まで広げたもの）との交点までの距離
fn planeT(face: i32, o: vec3f, d: vec3f) -> f32 {
  let dd = safeDir(d);
  if (face == 0) { return (u.uRoomMax.x - o.x) / dd.x; }
  if (face == 1) { return (u.uRoomMin.x - o.x) / dd.x; }
  if (face == 2) { return (u.uRoomMax.y - o.y) / dd.y; }
  if (face == 3) { return (u.uRoomMin.y - o.y) / dd.y; }
  if (face == 4) { return (u.uRoomMax.z - o.z) / dd.z; }
  return (u.uRoomMin.z - o.z) / dd.z;
}

// 面の上の位置を 0〜1 の座標に（光の揺らぎの画像を読み書きするため。v は下が 0）
fn faceUV(face: i32, p: vec3f) -> vec2f {
  let q = (p - u.uRoomMin) / (u.uRoomMax - u.uRoomMin);
  if (face == 0 || face == 1) { return vec2f(q.z, q.y); }
  if (face == 2 || face == 3) { return vec2f(q.x, q.z); }
  return vec2f(q.x, q.y);
}

fn inwardNormal(face: i32) -> vec3f {
  if (face == 0) { return vec3f(-1.0, 0.0, 0.0); }
  if (face == 1) { return vec3f(1.0, 0.0, 0.0); }
  if (face == 2) { return vec3f(0.0, -1.0, 0.0); }
  if (face == 3) { return vec3f(0.0, 1.0, 0.0); }
  if (face == 4) { return vec3f(0.0, 0.0, -1.0); }
  return vec3f(0.0, 0.0, 1.0);
}

fn inWindow1(face: i32, p: vec3f) -> bool {
  if (face != i32(u.uWinFace)) { return false; }
  let uv = select(p.zy, p.xz, face == 2);
  return uv.x > u.uWinRect.x && uv.x < u.uWinRect.y && uv.y > u.uWinRect.z && uv.y < u.uWinRect.w;
}

// 2 つ目の窓（天窓＋左の窓のときの天窓）
fn inWindow2(face: i32, p: vec3f) -> bool {
  return u.uWin2On > 0.5 && face == 2 && p.x > u.uWin2Rect.x && p.x < u.uWin2Rect.y && p.z > u.uWin2Rect.z && p.z < u.uWin2Rect.w;
}

fn inWindow(face: i32, p: vec3f) -> bool {
  return inWindow1(face, p) || inWindow2(face, p);
}

fn windowPoint(r1: f32, r2: f32) -> vec3f {
  let a = mix(u.uWinRect.x, u.uWinRect.y, r1);
  let b = mix(u.uWinRect.z, u.uWinRect.w, r2);
  let wf = i32(u.uWinFace);
  if (wf == 0) { return vec3f(u.uRoomMax.x, b, a); }
  if (wf == 1) { return vec3f(u.uRoomMin.x, b, a); }
  return vec3f(a, u.uRoomMax.y, b);
}

fn windowOutward() -> vec3f {
  let wf = i32(u.uWinFace);
  if (wf == 0) { return vec3f(1.0, 0.0, 0.0); }
  if (wf == 1) { return vec3f(-1.0, 0.0, 0.0); }
  return vec3f(0.0, 1.0, 0.0);
}

fn onScreen(face: i32, p: vec3f) -> bool {
  return u.uScreenArea > 0.5 && face == 5 && p.x > u.uScreenRect.x && p.x < u.uScreenRect.y && p.y > u.uScreenRect.z && p.y < u.uScreenRect.w;
}

fn albedo(face: i32, p: vec3f) -> vec3f {
  if (face == 3) { return vec3f(${FLOOR_ALBEDO.toFixed(3)}); }
  if (onScreen(face, p)) { return vec3f(${SCREEN_ALBEDO.toFixed(3)}) * vec3f(0.92, 0.96, 1.05); }
  return vec3f(${WALL_ALBEDO.toFixed(3)});
}

fn skyRadiance(d: vec3f) -> vec3f {
  return mix(u.uSkyBottom, u.uSkyTop, sqrt(max(d.y, 0.0)));
}

${WGSL_SIMPLEX3}
// 雲の濃さ（0〜1）。visuals の「光の雲」と同じ作り方を、空の水平な面の上に置く
fn cloudSum(q: vec2f, off: vec3f, octaves: i32) -> f32 {
  var s = 0.0;
  var a = 0.55;
  var f = 1.0;
  for (var i = 0; i < 5; i++) {
    if (i >= octaves) { break; }
    s += a * snoise(vec3f((q + off.xy) * f + vec2f(17.3, -9.1) * f32(i), off.z * (1.0 + 0.35 * f32(i))));
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}
fn cloudDensity(xz: vec2f, octaves: i32) -> f32 {
  let q = xz * u.uCloudScale;
  var s = cloudSum(q, u.uCloudOffA, octaves);
  if (u.uCloudBlend > 0.0) {
    let w = u.uCloudBlend;
    s = (s * (1.0 - w) + cloudSum(q, u.uCloudOffB, octaves) * w) / sqrt((1.0 - w) * (1.0 - w) + w * w);
  }
  // 雲の量でしきい値を決め、それより濃い所を雲にする（量 0 で快晴、1 で全天の雲）。境目は少しぼかす
  let d = 0.5 + 0.5 * s * u.uCloudContrast;
  let th = 0.8 - 0.6 * u.uCloudAmount;
  return smoothstep(th - 0.12, th + 0.12, d);
}
// 日差しが雲を通り抜ける割合
fn cloudTrans(p: vec3f) -> f32 {
  if (u.uCloudOn < 0.5 || u.uCloudShadow < 0.5 || u.uSunDir.y <= 0.0) { return 1.0; }
  let t = (u.uCloudY - p.y) / max(u.uSunDir.y, 0.02);
  return 1.0 - u.uCloudOpacity * cloudDensity(p.xz + u.uSunDir.xz * t, 3);
}
// 雲のある空：点 o から向き d（上向き）に見える空の明るさ
fn cloudySky(o: vec3f, d: vec3f) -> vec3f {
  let sky = skyRadiance(d);
  if (u.uCloudOn < 0.5 || d.y <= 0.0) { return sky; }
  let t = (u.uCloudY - o.y) / max(d.y, 1e-3);
  let dens = cloudDensity(o.xz + d.xz * t, 5);
  let alpha = u.uCloudOpacity * dens * smoothstep(0.02, 0.2, d.y);
  let fwd = pow(max(dot(d, u.uSunDir), 0.0), 6.0);
  let lit = u.uSunE * (0.16 + 0.6 * fwd) * (1.0 - 0.45 * dens) + 0.5 * (u.uSkyTop + u.uSkyBottom);
  return mix(sky, lit, alpha);
}

// 太陽の円盤に向かう向きほど強い、鋭い山（水面に映る太陽のきらめき）
fn sunLobe(r: vec3f) -> f32 {
  return pow(max(dot(r, u.uSunDir), 0.0), 3000.0) * (3002.0 / (2.0 * PI));
}

// 窓の外の海：点 o から向き d（下向き）で見た水面の明るさ
@group(0) @binding(11) var ocean0: texture_2d<f32>;
@group(0) @binding(12) var ocean1: texture_2d<f32>;
@group(0) @binding(13) var oceanS: sampler;

// FFT の海面（src/room/ocean.ts）：2 枚の画像から、高さ・傾きと、描ききれない波の傾きの 2 乗平均を読んで足す。
// 画素の大きさ fw（水面の上で m）に合わせてミップマップの段を選ぶ（遠くの細かい波は平均されて消え、その分を粗さに回す）
fn oceanLayer(tex: texture_2d<f32>, size: f32, layer: i32, p: vec2f, fw: f32) -> vec4f {
  let lod = clamp(log2(max(fw * ${OCEAN_N}.0 / size, 1e-6)), 0.0, ${OCEAN_LODS - 1}.0);
  let s = textureSampleLevel(tex, oceanS, p / size, lod);
  let i0 = i32(floor(lod));
  let i1 = min(i0 + 1, ${OCEAN_LODS - 1});
  let m = mix(u.uOceanMss[layer * ${OCEAN_LODS} + i0], u.uOceanMss[layer * ${OCEAN_LODS} + i1], lod - f32(i0));
  return vec4f(s.xyz, m);
}
fn oceanSurface(p: vec2f, fw: f32) -> vec4f {
  return oceanLayer(ocean0, u.uOceanSize.x, 0, p, fw) + oceanLayer(ocean1, u.uOceanSize.y, 1, p, fw);
}
fn seaGlint(n: vec3f, v: vec3f, m2: f32) -> f32 {
  let l = u.uSunDir;
  let nl = dot(n, l);
  if (l.y <= 0.0 || nl <= 0.0) { return 0.0; }
  let h = normalize(v + l);
  let nh = max(dot(n, h), 1e-3);
  let c2 = nh * nh;
  let D = exp(-(1.0 - c2) / (c2 * m2)) / (PI * m2 * c2 * c2);
  return fresnelWater(dot(h, v)) * D / (4.0 * max(dot(n, v), 0.05));
}
fn seaRadiance(o: vec3f, d: vec3f) -> vec3f {
  let t = (u.uSeaY - o.y) / min(d.y, -1e-4);
  let x = o + d * t;
  let fw = t * u.uPixAngle / sqrt(max(-d.y, 1e-3));
  var sw: vec4f;
  if (u.uOceanOn > 0.5) { sw = oceanSurface(x.xz, fw); } else { sw = seaSurface(x.xz, fw); }
  let n = waveNormal(sw.xyz);
  let v = -d;
  let F = fresnelWater(dot(v, n));
  var r = reflect(d, n);
  r.y = abs(r.y);
  let crest = clamp(sw.x / select(0.03 * u.uWaveAmp + 1e-4, 2.0 * u.uOceanRms + 1e-4, u.uOceanOn > 0.5), 0.0, 1.0);
  let dh = normalize(d.xz + 1e-6);
  let sh = normalize(u.uSunDir.xz + 1e-6);
  let toward = pow(0.5 + 0.5 * dot(dh, sh), 4.0);
  let body = u.uSeaBody + u.uSunE * (vec3f(0.02, 0.09, 0.07) * (u.uSeaLook.y * crest * (0.25 + toward) * max(u.uSunDir.y, 0.0)));
  let c = F * cloudySky(x, r) + u.uSunE * (seaGlint(n, v, u.uSeaLook.x + sw.w) * cloudTrans(x)) + (1.0 - F) * body;
  return mix(c, skyRadiance(normalize(vec3f(d.x, 0.02, d.z))), 1.0 - exp(-t / 600.0));
}

// 窓の外の明るさ：上は空、下は海（オフなら地面）
fn outsideRadiance(o: vec3f, d: vec3f) -> vec3f {
  if (d.y >= 0.0) { return cloudySky(o, d); }
  if (u.uSeaOn > 0.5) { return seaRadiance(o, d); }
  return u.uGround;
}

// 空の光を部屋に取り込む計算用：波やきらめきを平均した明るさ
fn outsideRadianceAvg(d: vec3f) -> vec3f {
  if (d.y >= 0.0) { return skyRadiance(d); }
  if (u.uSeaOn < 0.5) { return u.uGround; }
  let F = fresnelWater(-d.y);
  return F * skyRadiance(vec3f(d.x, -d.y, d.z)) + (1.0 - F) * u.uSeaBody;
}

// 太陽の円盤の中の向き（2 つの値は 0〜1。円盤内に一様）
fn sunDirAt(r: vec2f) -> vec3f {
  let rad = sqrt(r.x) * u.uSunSinR;
  let phi = 2.0 * PI * r.y;
  let B = basis(u.uSunDir);
  return normalize(u.uSunDir + B.t * rad * cos(phi) + B.b * rad * sin(phi));
}

// その向きへの光線が窓を通って外へ出られるか（出られなければ壁の影）
fn seesOutside(p: vec3f, l: vec3f) -> bool {
  let e = exitRoom(p, l);
  return inWindow(e.face, p + l * e.t);
}

// 画面の画素（px、WebGL と同じく左下が原点）を通るカメラの光線が、部屋のどこに当たるか
struct Primary { ok: bool, face: i32, p: vec3f, dir: vec3f }
fn primaryHit(px: vec2f) -> Primary {
  let ndc = px / u.uRes * 2.0 - 1.0;
  let v = u.uProjInv * vec4f(ndc, 1.0, 1.0);
  let d = normalize((u.uCamWorld * vec4f(v.xyz / v.w, 0.0)).xyz);
  var o = u.uCamPos;
  let inside = all(o > u.uRoomMin) && all(o < u.uRoomMax);
  if (!inside) {
    let dd = safeDir(d);
    let t0 = (u.uRoomMin - o) / dd;
    let t1 = (u.uRoomMax - o) / dd;
    let tn = min(t0, t1);
    let tf = max(t0, t1);
    let tNear = max(max(tn.x, tn.y), tn.z);
    let tFar = min(min(tf.x, tf.y), tf.z);
    if (tNear > tFar || tFar < 0.0) { return Primary(false, 0, vec3f(0.0), d); }
    o += d * (tNear + 1e-3);
  }
  let e = exitRoom(o, d);
  return Primary(true, e.face, o + d * e.t, d);
}


// 鑑賞者の頭上のスポットライト（GLSL 版の説明を参照）
fn spotOne(i: i32, p: vec3f, n: vec3f) -> vec3f {
  var l = u.uSpotPos[i] - p;
  let d2 = max(dot(l, l), 1e-4);
  l *= inverseSqrt(d2);
  let c = dot(n, l);
  if (c <= 0.0) { return vec3f(0.0); }
  let cone = smoothstep(u.uSpotCos[i].x, u.uSpotCos[i].y, dot(-l, u.uSpotDir[i]));
  return u.uSpotI[i] * (cone * c / d2);
}
// 全体照明：天井の長方形がむらなく光る面。点 p に届く光は、長方形の 4 辺から式で求める（src/room/gl.ts と同じ）
fn ambEdge(a: vec3f, b: vec3f, n: vec3f) -> f32 {
  let c = cross(a, b);
  let l = length(c);
  if (l < 1e-6) { return 0.0; }
  return acos(clamp(dot(a, b), -1.0, 1.0)) * dot(n, c) / l;
}
fn ambientIrradiance(p: vec3f, n: vec3f) -> vec3f {
  if (u.uAmbL.x + u.uAmbL.y + u.uAmbL.z <= 0.0 || p.y > u.uRoomMax.y - 1e-3) { return vec3f(0.0); }
  let y = u.uRoomMax.y;
  let v0 = normalize(vec3f(u.uAmbRect.x, y, u.uAmbRect.z) - p);
  let v1 = normalize(vec3f(u.uAmbRect.y, y, u.uAmbRect.z) - p);
  let v2 = normalize(vec3f(u.uAmbRect.y, y, u.uAmbRect.w) - p);
  let v3 = normalize(vec3f(u.uAmbRect.x, y, u.uAmbRect.w) - p);
  return u.uAmbL * (0.5 * abs(ambEdge(v0, v1, n) + ambEdge(v1, v2, n) + ambEdge(v2, v3, n) + ambEdge(v3, v0, n)));
}
// 全体照明の光る面そのものの明るさ（目に見える天井パネル。見え方だけ）
fn ambientPanel(face: i32, p: vec3f) -> vec3f {
  if (face == 2 && p.x > u.uAmbRect.x && p.x < u.uAmbRect.y && p.z > u.uAmbRect.z && p.z < u.uAmbRect.w) { return u.uAmbL; }
  return vec3f(0.0);
}
fn spotIrradiance(p: vec3f, n: vec3f) -> vec3f {
  var e = ambientIrradiance(p, n);
  for (var i = 0; i < MAX_SPOTS; i++) {
    if (f32(i) >= u.uSpotCount) { break; }
    e += spotOne(i, p, n);
  }
  return e;
}
fn spotBottom(b: vec3f) -> vec3f {
  var e = vec3f(0.0);
  for (var i = 0; i < MAX_SPOTS; i++) {
    if (f32(i) >= u.uSpotCount) { break; }
    let l = normalize(u.uSpotPos[i] - b);
    e += spotOne(i, b, vec3f(0.0, 1.0, 0.0)) * exp(-WATER_ABS * u.uPoolDepth / max(l.y, 0.2));
  }
  e += ambientIrradiance(b, vec3f(0.0, 1.0, 0.0)) * exp(-WATER_ABS * u.uPoolDepth * 1.3);
  return e * 0.97;
}
fn spotLamp(o: vec3f, d: vec3f, tMax: f32) -> vec3f {
  var col = vec3f(0.0);
  if (u.uSpotLampOn < 0.5) { return col; }
  var best = tMax;
  for (var i = 0; i < MAX_SPOTS; i++) {
    if (f32(i) >= u.uSpotCount) { break; }
    let oc = o - u.uSpotPos[i];
    let b = dot(oc, d);
    let h = b * b - (dot(oc, oc) - u.uSpotR * u.uSpotR);
    if (h < 0.0) { continue; }
    let t = -b - sqrt(h);
    if (t < 0.0 || t > best) { continue; }
    best = t;
    let nn = normalize(o + d * t - u.uSpotPos[i]);
    col = max(u.uSpotI[i] / (PI * u.uSpotR * u.uSpotR) * smoothstep(-0.2, 0.4, dot(nn, u.uSpotDir[i])), vec3f(0.01));
  }
  return col;
}
`;

// ---- 段階 1・2 で読む画像：光の揺らぎ（面ごと）とスクリーンの映像 ----
const textures = /* wgsl */ `
@group(0) @binding(2) var caus0: texture_2d<f32>;
@group(0) @binding(3) var caus1: texture_2d<f32>;
@group(0) @binding(4) var caus2: texture_2d<f32>;
@group(0) @binding(5) var caus4: texture_2d<f32>;
@group(0) @binding(6) var caus5: texture_2d<f32>;
@group(0) @binding(7) var causB: texture_2d<f32>;
@group(0) @binding(8) var linearS: sampler;
@group(0) @binding(9) var screenTex: texture_2d<f32>;
@group(0) @binding(10) var screenS: sampler;

const CAUS_TEXEL = ${(1 / CAUSTIC_SIZE).toFixed(6)};
// 光の揺らぎの画像は、網目を WebGL と同じ向き（v が下から上）に描いているので、画像の上下を入れ替えて読む
fn causTex(face: i32, uv: vec2f) -> f32 {
  let t = vec2f(uv.x, 1.0 - uv.y);
  if (face == 0) { return textureSampleLevel(caus0, linearS, t, 0.0).r; }
  if (face == 1) { return textureSampleLevel(caus1, linearS, t, 0.0).r; }
  if (face == 2) { return textureSampleLevel(caus2, linearS, t, 0.0).r; }
  if (face == 4) { return textureSampleLevel(caus4, linearS, t, 0.0).r; }
  if (face == 5) { return textureSampleLevel(caus5, linearS, t, 0.0).r; }
  return textureSampleLevel(causB, linearS, t, 0.0).r;
}
// 太陽には大きさ（0.53°）があるので、水面から数 m 先に届く光の模様は数 cm ぼける。その程度に近くの 5 点を平均する
fn blurTap(face: i32, uv: vec2f) -> f32 {
  let o = vec2f(1.2 * CAUS_TEXEL);
  return (2.0 * causTex(face, uv) + causTex(face, uv + o) + causTex(face, uv - o)
    + causTex(face, uv + vec2f(o.x, -o.y)) + causTex(face, uv + vec2f(-o.x, o.y))) / 6.0;
}
fn causticAt(face: i32, p: vec3f) -> f32 {
  if (u.uCausOn < 0.5 || face == 3) { return 0.0; }
  return blurTap(face, faceUV(face, p));
}
// 水盤の底に屈折して届く日差し
fn causticBottom(p: vec3f) -> f32 {
  if (u.uCausOn < 0.5) { return 0.0; }
  return causTex(6, faceUV(3, p));
}

// スクリーンに映した映像が出す光（放射輝度）。lod < 0 なら、隣の画素との差（gScreenDx・gScreenDy）からぼかしの段を決める
var<private> gScreenDx: vec2f;
var<private> gScreenDy: vec2f;
fn screenUV(p: vec3f) -> vec2f {
  let uv = vec2f((p.x - u.uScreenRect.x) / (u.uScreenRect.y - u.uScreenRect.x), (p.y - u.uScreenRect.z) / (u.uScreenRect.w - u.uScreenRect.z));
  return vec2f(uv.x, 1.0 - uv.y); // 映像の画像は上が 0
}
fn screenLight(face: i32, p: vec3f, lod: f32) -> vec3f {
  if (u.uScreenOn < 0.5 || !onScreen(face, p)) { return vec3f(0.0); }
  let t = screenUV(p);
  var c: vec3f;
  if (lod < 0.0) { c = textureSampleGrad(screenTex, screenS, t, gScreenDx, gScreenDy).rgb; }
  else { c = textureSampleLevel(screenTex, screenS, t, lod).rgb; }
  c = clamp(c, vec3f(u.uScreenOut.x), vec3f(u.uScreenOut.y));
  return u.uScreenGain * pow(c, vec3f(2.2)); // 映像の色（sRGB）→ 光の強さ（線形）
}

fn isBad(v: vec3f) -> bool {
  let e = bitcast<vec3u>(v) & vec3u(0x7f800000u);
  return any(e == vec3u(0x7f800000u)); // 無限大か NaN
}
`;

// ---- 段階 0：水面の光の揺らぎ（コースティクス）----
// 水面の網目の各点で、日差しを反射（屈折）させた先を求め、その面の画像の上に網目を描き直す。
// 網目が小さく縮んだ所ほど光が集まって明るい（明るさ = 元の網目の面積 / 届いた先の面積）。重なった所は足し合わせる
const causticShader = /* wgsl */ `
${common}
struct CausticPass {
  gridO: vec3f,
  waterY: f32,
  gridU: vec3f,
  source: f32, // 0 = 水盤、1 = 窓の外の水面
  gridV: vec3f,
  mode: f32,   // 0 = 反射、1 = 屈折
  dest: f32,   // 届く先：0〜5 = 部屋の面、6 = 水盤の底
}
@group(1) @binding(0) var<uniform> cp: CausticPass;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) vOld: vec3f,
  @location(1) vNew: vec3f,
  @location(2) vW: f32,
}

@vertex fn vs(@location(0) uv: vec2f) -> VOut {
  let p0 = cp.gridO + uv.x * cp.gridU + uv.y * cp.gridV;
  var hw: vec3f;
  if (cp.source < 0.5) { hw = poolWave(p0.xz); } else { hw = seaWave(p0.xz); }
  let n = waveNormal(hw);
  let p = vec3f(p0.x, cp.waterY + hw.x, p0.z);
  let ci = dot(n, u.uSunDir);
  let F = fresnelWater(ci);
  let refr = cp.mode > 0.5;
  var L: vec3f;
  if (refr) { L = refract(-u.uSunDir, n, 1.0 / IOR); } else { L = reflect(-u.uSunDir, n); }
  // 水面が受ける日差しの量（傾きの余弦）× 反射または屈折する割合
  var w = max(ci, 0.0) * select(F, 1.0 - F, refr) * cloudTrans(p);
  var o: vec3f;
  if (cp.source < 0.5) {
    // 水盤：その点に日差しが窓から届いているか
    o = vec3f(p.x, max(p.y, 0.0) + 1e-3, p.z);
    if (!seesOutside(o, u.uSunDir)) { w = 0.0; }
    if (refr) { o = vec3f(p.x, min(p.y, 0.0), p.z); }
  } else {
    // 窓の外の水面：反射した光が窓の開口を通るか
    let wx = select(u.uRoomMin.x, u.uRoomMax.x, i32(u.uWinFace) == 0);
    let t = (wx - p.x) / select(L.x, 1e-6, abs(L.x) < 1e-6);
    let q = p + L * t;
    if (!(t > 0.0 && q.z > u.uWinRect.x && q.z < u.uWinRect.y && q.y > u.uWinRect.z && q.y < u.uWinRect.w)) { w = 0.0; }
    o = q + L * 1e-3;
  }
  var x: vec3f;
  var tuv: vec2f;
  let dest = i32(cp.dest);
  if (dest == 6) {
    let t = clamp((-u.uPoolDepth - o.y) / min(L.y, -1e-4), 0.0, 1e3);
    x = o + L * t;
    tuv = faceUV(3, x);
  } else {
    let e = exitRoom(o, L);
    if (e.face != dest) { w = 0.0; }
    let t = clamp(planeT(dest, o, L), 0.0, 1e3);
    x = o + L * t;
    tuv = faceUV(dest, x);
  }
  var out: VOut;
  out.pos = vec4f(tuv * 2.0 - 1.0, 0.0, 1.0);
  out.vOld = p0;
  out.vNew = x;
  out.vW = w;
  return out;
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let oldA = length(cross(dpdx(v.vOld), dpdy(v.vOld)));
  let newA = length(cross(dpdx(v.vNew), dpdy(v.vNew)));
  return vec4f(min(v.vW * oldA / max(newA, 1e-9), 60.0), 0.0, 0.0, 1.0);
}
`;

// ---- 段階 1：空の光と照り返しを、光の経路を追って求め、前のフレームまでの平均と重ねる ----
// 保存する値は「その点が受ける光（直射日光と、画面に出す段階で足す光の揺らぎを除く）/ π」
const traceShader = /* wgsl */ `
${common}
${textures}
@group(0) @binding(1) var prevTex: texture_2d<f32>;

var<private> rngState: u32;
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd() -> f32 { rngState = pcg(rngState); return f32(rngState) * (1.0 / 4294967296.0); }

// 余弦に比例した向き（拡散反射の跳ね返り）
fn cosineSample(n: vec3f) -> vec3f {
  let u1 = rnd();
  let u2 = rnd();
  let r = sqrt(u1);
  let phi = 2.0 * PI * u2;
  let B = basis(n);
  return normalize(B.t * r * cos(phi) + B.b * r * sin(phi) + n * sqrt(max(0.0, 1.0 - u1)));
}

// 窓から見える空（と海）から受ける光（窓の面の 1 点を選ぶ）
// 窓から入る空の光。2 通りの選び方を混ぜる（多重重点サンプリング。GLSL 版の説明を参照）
// 窓が 2 つ（天窓＋左の窓）のときは、どちらの窓の点を選ぶかを半々で決める（GLSL 版の説明を参照）
fn windowSel() -> f32 { return select(1.0, 0.5, u.uWin2On > 0.5); }
fn windowOutwardK(k: i32) -> vec3f { return select(windowOutward(), vec3f(0.0, 1.0, 0.0), k == 2); }
fn windowPdf(k: i32, w: vec3f, d2: f32) -> f32 {
  let r = select(u.uWinRect, u.uWin2Rect, k == 2);
  let area = (r.y - r.x) * (r.w - r.z);
  return windowSel() * d2 / (max(dot(windowOutwardK(k), w), 1e-6) * area);
}
fn skyNee(p: vec3f, n: vec3f) -> vec3f {
  var k = 1;
  if (u.uWin2On > 0.5 && rnd() < 0.5) { k = 2; }
  let r1 = rnd();
  let r2 = rnd();
  var q = windowPoint(r1, r2);
  if (k == 2) { q = vec3f(mix(u.uWin2Rect.x, u.uWin2Rect.y, r1), u.uRoomMax.y, mix(u.uWin2Rect.z, u.uWin2Rect.w, r2)); }
  var w = q - p;
  let d2 = dot(w, w);
  w *= inverseSqrt(d2);
  let cp = dot(n, w);
  let cq = dot(windowOutwardK(k), w);
  if (cp <= 0.0 || cq <= 0.0) { return vec3f(0.0); }
  return outsideRadianceAvg(w) * cp / (windowPdf(k, w, d2) + cp / PI);
}
fn skyBsdf(n: vec3f, d: vec3f, t: f32, k: i32) -> vec3f {
  let pc = dot(n, d) / PI;
  return outsideRadianceAvg(d) * pc / (windowPdf(k, d, t * t) + pc);
}

fn sunIrradiance(p: vec3f, n: vec3f) -> vec3f {
  if (u.uSunE.x + u.uSunE.y + u.uSunE.z <= 0.0) { return vec3f(0.0); }
  let r1 = rnd();
  let r2 = rnd();
  let l = sunDirAt(vec2f(r1, r2));
  let c = dot(n, l);
  if (c > 0.0 && seesOutside(p, l)) { return u.uSunE * (c * cloudTrans(p)); }
  return vec3f(0.0);
}

fn indirect(p0: vec3f, n0: vec3f) -> vec3f {
  var p = p0;
  var n = n0;
  var acc = skyNee(p, n) / PI;
  var thr = vec3f(1.0);
  // b 回目の光線で照り返しを 1 回たどる。照り返しの回数ぶんたどった後の 1 本は、空の光の 2 つ目の見本だけに使う
  for (var b = 0; b <= 6; b++) {
    let d = cosineSample(n);
    let e = exitRoom(p, d);
    let f = e.face;
    var q = p + d * e.t;
    if (inWindow(f, q)) { acc += thr * skyBsdf(n, d, e.t, select(1, 2, inWindow2(f, q))); break; } // 窓から外へ出た：空の光の 2 つ目の見本
    if (b >= i32(u.uBounces)) { break; }
    acc += thr * screenLight(f, q, 5.0); // スクリーンに映した映像の光が、部屋をほんのり照らす
    let n2 = inwardNormal(f);
    var a: vec3f;
    var em: vec3f;
    q += n2 * EPS;
    if (u.uPoolOn > 0.5 && f == 3) {
      // 水盤の底：屈折して届いた日差し（光の揺らぎ）を、水に吸収されながら返す
      let absorb = exp(-WATER_ABS * 2.0 * u.uPoolDepth);
      a = vec3f(${POOL_ALBEDO.toFixed(3)}) * absorb;
      em = u.uSunE * causticBottom(q) + skyNee(q, n2) + spotIrradiance(q, n2) * 0.97;
    } else {
      a = albedo(f, q);
      em = sunIrradiance(q, n2) + u.uSunE * causticAt(f, q) + skyNee(q, n2) + spotIrradiance(q, n2);
    }
    acc += thr * a / PI * em;
    thr *= a; // 余弦に比例して向きを選ぶので、反射率を掛けるだけでよい
    p = q;
    n = n2;
  }
  return acc;
}

${FULLSCREEN_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let fc = vec2f(pos.x, u.uRes.y - pos.y); // WebGL の gl_FragCoord と同じ（乱数の種も同じになる）
  rngState = pcg(u32(fc.x) + pcg(u32(fc.y) + pcg(u32(u.uFrame))));
  var sum = vec3f(0.0);
  let spp = i32(u.uSpp);
  for (var s = 0; s < spp; s++) {
    let r1 = rnd();
    let r2 = rnd();
    let h = primaryHit(fc - 0.5 + vec2f(r1, r2));
    if (!h.ok || inWindow(h.face, h.p)) { continue; } // 窓の外と部屋の外は画面に出す段階で描く
    let n = inwardNormal(h.face);
    sum += indirect(h.p + n * EPS, n);
  }
  var col = sum / f32(spp);
  if (isBad(col)) { col = vec3f(0.0); }
  let prev = textureLoad(prevTex, vec2i(pos.xy), 0).rgb;
  return vec4f(mix(prev, col, u.uBlend), 1.0);
}
`;

// ---- 段階 2：画面に出す。照り返しの成分をならし、反射率・直射日光・光の揺らぎを加えて、露出 → トーンマッピング → sRGB ----
const displayShader = /* wgsl */ `
${common}
${textures}
@group(0) @binding(1) var accumTex: texture_2d<f32>;

// 重ねた結果を、WebGL と同じ向きの画素の位置（左下が原点）で読む
fn accumAt(q: vec2f) -> vec3f {
  let last = vec2i(textureDimensions(accumTex)) - 1;
  let t = clamp(vec2i(i32(floor(q.x)), i32(floor(u.uRes.y - q.y))), vec2i(0), last);
  return textureLoad(accumTex, t, 0).rgb;
}

// 太陽の円盤の決まった 12 点から、窓を通って届く直射日光（影の縁のぼけは円盤の大きさで決まる）
// ---- プリズム（画面に出す段階で足す光。src/room/gl.ts と同じ）----
fn spectrum(t: f32) -> vec3f {
  let c = clamp(abs(fract(t * 0.8 + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return mix(c, vec3f(0.6), 0.3);
}
fn hungLight(p: vec3f, n: vec3f) -> vec3f {
  if (u.uSunE.x + u.uSunE.y + u.uSunE.z <= 0.0) { return vec3f(0.0); }
  let d = -u.uSunDir;
  let cl = dot(n, u.uSunDir);
  let lit = cl > 0.0 && seesOutside(p, u.uSunDir);
  let hs = 0.5 * u.uPrismSize;
  var sum = vec3f(0.0);
  var shade = 0.0;
  var cover = 0.0;
  var hue = vec3f(0.0);
  for (var i = 0; i < MAX_PRISMS; i++) {
    if (f32(i) >= u.uPrismCount) { break; }
    let P = u.uPrismPos[i];
    if (!seesOutside(P, u.uSunDir)) { continue; }
    let sunP = cloudTrans(P);
    let v = p - P;
    let s = dot(v, d);
    if (lit && s > 0.0) { let r = length(v - d * s) / hs; shade += exp(-r * r) * sunP; }
    let D = length(v);
    if (D < 0.05) { continue; }
    let uu = v / D;
    let c = dot(n, -uu);
    if (c <= 0.0) { continue; }
    let A0 = normalize(u.uPrismAxis[i] - d * dot(u.uPrismAxis[i], d));
    let B0 = cross(d, A0);
    let b = hs / D;
    let spread = u.uPrismSize / (u.uPrismDisp * D + u.uPrismSize);
    for (var f = 0; f < 4; f++) {
      if (f32(f) >= u.uPrismFacets) { break; }
      let th = 6.2832 * f32(f) / u.uPrismFacets;
      let A = A0 * cos(th) + B0 * sin(th);
      let e = cross(A, d);
      let phi = atan2(dot(uu, e), dot(uu, d)) - u.uPrismDev * (0.75 + 0.25 * f32(f));
      let inFan = smoothstep(-b, b, phi) * (1.0 - smoothstep(-b, b, phi - u.uPrismDisp));
      let w = dot(uu, A) * D / hs;
      let m = inFan * exp(-w * w);
      if (m <= 1e-4) { continue; }
      let col = spectrum(clamp(phi / u.uPrismDisp, 0.0, 1.0));
      sum += col * (2.0 * m * spread * c * sunP / u.uPrismFacets);
      hue += col * (m * sunP);
      cover += m * sunP;
    }
  }
  sum *= u.uPrismStrength;
  // 日なたに落ちた虹は、白い日差しを虹の色に置き換える（src/room/gl.ts と同じ）
  if (!lit) { return u.uSunE * sum; }
  let sunHere = cl * cloudTrans(p);
  let k = u.uPrismVivid * min(cover, 1.0);
  let swap = hue / max(cover, 1e-4) * 1.6;
  return u.uSunE * (sum + sunHere * (k * (swap - vec3f(1.0)) - vec3f(min(shade, 1.0) * 0.35)));
}
// ---- A：日だまりの中の虹色の筋（src/room/gl.ts と同じ）----
fn prismHash(c: vec2f) -> vec2f {
  var q = fract(c.xyx * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}
fn streakPattern(q: vec2f) -> vec4f {
  let s = u.uStreakLen;
  let cell = s * 1.3;
  let gi = floor(q / cell);
  var sum = vec4f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = gi + vec2f(f32(i), f32(j));
      let h = prismHash(c);
      let h2 = prismHash(c + 17.0);
      if (h2.x > u.uStreakAmount) { continue; }
      let ctr = (c + 0.2 + 0.6 * h) * cell;
      let ang = u.uStreakAngle + (h2.y - 0.5) * 0.6 + 0.25 * sin(u.uPrismPhase + 6.2832 * h.x);
      let e = vec2f(cos(ang), sin(ang));
      let d = q - ctr;
      let a = dot(d, e) / s + 0.5;
      let w = dot(d, vec2f(-e.y, e.x)) / (s * 0.25);
      let m = smoothstep(0.0, 0.2, a) * (1.0 - smoothstep(0.8, 1.0, a)) * exp(-w * w * 3.0);
      sum += vec4f(spectrum(clamp(a, 0.0, 1.0)), 1.0) * m;
    }
  }
  return sum;
}
fn streakLight(p: vec3f, n: vec3f) -> vec3f {
  if (u.uSunE.x + u.uSunE.y + u.uSunE.z <= 0.0) { return vec3f(0.0); }
  let c = dot(n, u.uSunDir);
  if (c <= 0.0 || !seesOutside(p, u.uSunDir)) { return vec3f(0.0); }
  let bs = basis(u.uSunDir);
  let pat = streakPattern(vec2f(dot(p, bs.t), dot(p, bs.b)));
  let delta = pat.rgb * (2.0 * u.uPrismStrength) - vec3f(min(pat.a, 1.0) * min(u.uPrismStrength, 1.0));
  return u.uSunE * (c * cloudTrans(p)) * delta;
}

// ---- C：窓をプリズムの板で覆う（src/room/gl.ts と同じ）----
const PANEL_SAMPLES = 16;
fn spectrumPure(t: f32) -> vec3f {
  return clamp(abs(fract(t * 0.8 + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
}
fn panelLight(p: vec3f, n: vec3f) -> vec3f {
  if (u.uSunE.x + u.uSunE.y + u.uSunE.z <= 0.0) { return vec3f(0.0); }
  var sum = vec3f(0.0);
  var wsum = vec3f(0.0);
  for (var j = 0; j < PANEL_SAMPLES; j++) { wsum += spectrumPure((f32(j) + 0.5) / f32(PANEL_SAMPLES)); }
  for (var k = 1; k <= 2; k++) {
    if (k == 2 && u.uWin2On < 0.5) { break; }
    if (dot(u.uSunDir, select(windowOutward(), vec3f(0.0, 1.0, 0.0), k == 2)) <= 0.0) { continue; }
    let face = select(i32(u.uWinFace), 2, k == 2);
    var A = vec3f(0.0, sin(u.uPanelRidge), cos(u.uPanelRidge));
    if (face == 2) { A = vec3f(cos(u.uPanelRidge), 0.0, sin(u.uPanelRidge)); }
    let axs = cross(A, u.uSunDir);
    let ad = dot(A, u.uSunDir);
    for (var j = 0; j < PANEL_SAMPLES; j++) {
      let t = (f32(j) + 0.5) / f32(PANEL_SAMPLES);
      let ang = u.uPrismDev + u.uPrismDisp * t;
      let L = u.uSunDir * cos(ang) + axs * sin(ang) + A * ad * (1.0 - cos(ang));
      let c = dot(n, L);
      if (c <= 0.0) { continue; }
      let e = exitRoom(p, L);
      let q = p + L * e.t;
      var hit = inWindow1(e.face, q);
      if (k == 2) { hit = inWindow2(e.face, q); }
      if (hit) { sum += spectrumPure(t) * c; }
    }
  }
  return u.uSunE * (cloudTrans(p) * u.uPrismStrength) * sum / wsum;
}

// ---- D：日差しの先の虹の筋（窓ガラスのプリズムから出る細い光の束）----
const BEAM_SAMPLES = 7;
fn beamLight(p: vec3f, n: vec3f) -> vec3f {
  if (u.uSunE.x + u.uSunE.y + u.uSunE.z <= 0.0) { return vec3f(0.0); }
  let d = -u.uSunDir;
  let cl = dot(n, u.uSunDir);
  let lit = cl > 0.0 && seesOutside(p, u.uSunDir);
  let r0 = 0.5 * u.uPrismSize;
  var wsum = vec3f(0.0);
  for (var j = 0; j < BEAM_SAMPLES; j++) { wsum += spectrumPure((f32(j) + 0.5) / f32(BEAM_SAMPLES)); }
  var sum = vec3f(0.0);
  var hue = vec3f(0.0);
  var cover = 0.0;
  for (var i = 0; i < MAX_PRISMS; i++) {
    if (f32(i) >= u.uPrismCount) { break; }
    let P = u.uPrismPos[i];
    if (!seesOutside(P, u.uSunDir)) { continue; }
    var A = u.uPrismAxis[i] - d * dot(u.uPrismAxis[i], d);
    if (dot(A, A) < 1e-6) { continue; }
    A = normalize(A);
    let e = cross(A, d);
    let v = p - P;
    let sunP = cloudTrans(P);
    var mMax = 0.0;
    for (var j = 0; j < BEAM_SAMPLES; j++) {
      let t = (f32(j) + 0.5) / f32(BEAM_SAMPLES);
      let ang = u.uPrismDev + u.uPrismDisp * t;
      let L = d * cos(ang) + e * sin(ang);
      let s = dot(v, L);
      if (s <= 0.0) { continue; }
      let c = dot(n, -L);
      if (c <= 0.0) { continue; }
      let R = r0 + u.uBeamBlur * s;
      let w = v - L * s;
      let m = exp(-2.0 * dot(w, w) / (R * R));
      if (m <= 1e-4) { continue; }
      let col = spectrumPure(t);
      sum += col * (m * (r0 * r0) / (R * R) * c * sunP);
      hue += col * (m * sunP);
      mMax = max(mMax, m);
    }
    cover += mMax * sunP;
  }
  sum *= u.uPrismStrength / max(dot(wsum, vec3f(1.0 / 3.0)), 1e-4);
  if (!lit) { return u.uSunE * sum; }
  let sunHere = cl * cloudTrans(p);
  let k = u.uPrismVivid * min(cover, 1.0);
  let swap = hue / max(dot(hue, vec3f(1.0 / 3.0)), 1e-4);
  return u.uSunE * (sum + sunHere * k * (swap - vec3f(1.0)));
}

fn patternLight(p: vec3f, n: vec3f) -> vec3f {
  if (u.uPrismOn < 0.5) { return vec3f(0.0); }
  if (u.uPrismPattern < 0.5) { return streakLight(p, n); }
  if (u.uPrismPattern < 1.5) { return hungLight(p, n); }
  if (u.uPrismPattern > 2.5 && u.uPrismPattern < 3.5) { return beamLight(p, n); }
  return vec3f(0.0);
}

// ---- E・F・G 共通：有機的な縁（src/room/gl.ts と同じ）----
fn orgNoise(q: vec2f, t: f32) -> f32 {
  let w = q + 0.6 * vec2f(sin(q.y * 1.7 + t * 0.9), sin(q.x * 1.3 - t * 0.7));
  return 0.5 * sin(w.x * 2.1 + t) + 0.35 * sin(w.y * 2.7 - 1.3 * t + 1.1) + 0.15 * sin((w.x + w.y) * 4.3 + 0.7 * t);
}
fn pastelTint(q: vec2f, t: f32, amt: f32) -> vec3f {
  let h = spectrumPure(fract(0.5 + 0.6 * orgNoise(q, t)));
  return vec3f(1.0) + amt * 0.6 * (h / max(dot(h, vec3f(1.0 / 3.0)), 1e-3) - vec3f(1.0));
}
fn organicEdge(sd: f32, e: vec4f, lk: vec2f) -> vec3f {
  var sum = vec3f(0.0);
  var wsum = vec3f(0.0);
  for (var j = 0; j < 7; j++) {
    let t = (f32(j) + 0.5) / 7.0;
    let c = spectrumPure(t);
    wsum += c;
    sum += c * (1.0 - smoothstep(-e.y, e.y, sd + (t - 0.5) * e.x));
  }
  var col = sum / wsum;
  let l = dot(col, vec3f(1.0 / 3.0));
  col = max(vec3f(l) + (col - vec3f(l)) * lk.x, vec3f(0.0));
  let h = 1.0 - min(max(sd, 0.0) / e.w, 1.0);
  return col + (e.z * h * h * (1.0 - min(l, 1.0))) * (vec3f(0.3) + 0.7 * spectrumPure(lk.y));
}
// F：窓の縁までの符号つきの距離（窓の面の上、中は負）と、窓の面の上の位置（xy = 位置、z = 距離）
fn windowSd(p: vec3f) -> vec3f {
  var best = vec3f(0.0, 0.0, 1e3);
  for (var k = 1; k <= 2; k++) {
    if (k == 2 && u.uWin2On < 0.5) { break; }
    if (dot(u.uSunDir, select(windowOutward(), vec3f(0.0, 1.0, 0.0), k == 2)) <= 0.0) { continue; }
    let face = select(i32(u.uWinFace), 2, k == 2);
    let t = planeT(face, p, u.uSunDir);
    if (t <= 0.0) { continue; }
    let h = p + u.uSunDir * t;
    let uv = select(h.zy, h.xz, face == 2);
    var r = select(u.uWinRect, u.uWin2Rect, k == 2);
    if (u.uWin2On > 0.5 && u.uWin2Rect.x <= u.uRoomMin.x + 1e-3 && u.uWinRect.w >= u.uRoomMax.y - 1e-3) {
      if (k == 1) { r.w = 1e3; } else { r.x = -1e3; }
    }
    let dd = abs(uv - 0.5 * vec2f(r.x + r.y, r.z + r.w)) - 0.5 * vec2f(r.y - r.x, r.w - r.z);
    let sd = length(max(dd, vec2f(0.0))) + min(max(dd.x, dd.y), 0.0);
    if (sd < best.z) { best = vec3f(uv, sd); }
  }
  return best;
}
fn organicSun(p: vec3f, n: vec3f) -> vec3f {
  let cl = dot(n, u.uSunDir);
  if (cl <= 0.0 || u.uSunE.x + u.uSunE.y + u.uSunE.z <= 0.0) { return vec3f(0.0); }
  let w = windowSd(p);
  if (w.z > 1e2) { return vec3f(0.0); }
  let qs = w.xy / u.uOrgShape.y;
  var m = organicEdge(w.z + u.uOrgShape.x * orgNoise(qs, u.uOrgShape.z), u.uOrgEdge, u.uOrgLook);
  m *= pastelTint(qs * 0.3 + 3.1, u.uOrgShape.z * 0.5, u.uOrgShape.w);
  return u.uSunE * (cl * cloudTrans(p)) * m;
}
// H：水のきらめき（src/room/gl.ts と同じ）
fn shimHash(c: vec2f) -> vec2f {
  return fract(sin(vec2f(dot(c, vec2f(127.1, 311.7)), dot(c, vec2f(269.5, 183.3)))) * 43758.5453);
}
fn shimCell(x: vec2f, t: f32) -> f32 {
  let i = floor(x);
  let f = fract(x);
  var d1 = 8.0;
  var d2 = 8.0;
  for (var b = -1; b <= 1; b++) {
    for (var a = -1; a <= 1; a++) {
      let g = vec2f(f32(a), f32(b));
      let r = g + 0.5 + 0.4 * sin(t + 6.2832 * shimHash(i + g)) - f;
      let d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return sqrt(d2) - sqrt(d1);
}
fn shimLine(e: f32, w: f32) -> f32 {
  return exp(-e * e / (w * w)) + 0.25 * exp(-e / (3.0 * w));
}
fn shimColorAt(s: f32) -> vec3f {
  if (u.uShimPalN < 1.5) { return spectrumPure(mix(u.uShimColor.y, u.uShimColor.z, s)); }
  let k = clamp(s, 0.0, 1.0) * (u.uShimPalN - 1.0);
  let i = i32(min(floor(k), u.uShimPalN - 2.0));
  return mix(u.uShimPal[i], u.uShimPal[i + 1], k - f32(i));
}
fn shimSat(c: vec3f) -> vec3f {
  let l = dot(c, vec3f(1.0 / 3.0));
  return max(vec3f(l) + (c - vec3f(l)) * u.uShimColor.w, vec3f(0.0));
}
fn shimmer(p: vec3f, n: vec3f) -> vec3f {
  var q: vec2f;
  if (u.uShimSurface > 0.5) {
    q = select(select(p.xy, p.zy, abs(n.x) > 0.5), p.xz, abs(n.y) > 0.5);
  } else {
    let ws = windowSd(p);
    if (ws.z > 1e2) { return vec3f(1.0); }
    q = ws.xy;
  }
  let t = u.uShimShape.w;
  let w = u.uShimShape.y;
  var x = q / u.uShimShape.x;
  x += u.uShimShape.z * vec2f(orgNoise(x * 0.5, t), orgNoise(x * 0.5 + 7.3, 1.1 * t));
  let dd = u.uShimLook.z * vec2f(0.6, 0.8);
  let e = shimCell(x, t);
  let nc = u.uShimColor.x;
  var sum = vec3f(0.0);
  var wsum = 0.0;
  for (var j = 0; j < MAX_SHIM_COLORS; j++) {
    if (f32(j) >= nc) { break; }
    let s = f32(j) / (nc - 1.0);
    let c = shimColorAt(s);
    sum += c * shimLine(shimCell(x + (2.0 * s - 1.0) * dd, t), w);
    wsum += dot(c, vec3f(0.2126, 0.7152, 0.0722));
  }
  let l = shimSat(sum / max(wsum, 1e-3));
  var film = shimSat(shimColorAt(abs(2.0 * fract(0.5 * orgNoise(x * 0.4 + 2.7, 0.6 * t) + 2.0 * e) - 1.0)));
  film /= max(dot(film, vec3f(1.0 / 3.0)), 1e-3);
  let m = (u.uShimLook.x * u.uShimBaseCol + u.uShimLook.y * l * u.uShimLineCol) * mix(vec3f(1.0), film, u.uShimLook.w * exp(-e / (4.0 * w)));
  return mix(vec3f(1.0), m, u.uShimOn);
}
// G：虹のしみ（src/room/gl.ts と同じ）
fn blobLight(p: vec3f, n: vec3f) -> vec3f {
  if (u.uBlobCount < 0.5 || u.uSunE.x + u.uSunE.y + u.uSunE.z <= 0.0) { return vec3f(0.0); }
  let d = -u.uSunDir;
  let r0 = u.uBlobBeam.x;
  let reach = 1.0 + u.uBlobShape.x + 0.5 * abs(u.uBlobEdge.x) + u.uBlobEdge.y + select(0.0, u.uBlobEdge.w, u.uBlobEdge.z > 0.0);
  var sum = vec3f(0.0);
  for (var i = 0; i < MAX_BLOBS; i++) {
    if (f32(i) >= u.uBlobCount) { break; }
    let P = u.uBlobPos[i];
    if (!seesOutside(P, u.uSunDir)) { continue; }
    var A = u.uBlobAxis[i] - d * dot(u.uBlobAxis[i], d);
    if (dot(A, A) < 1e-6) { continue; }
    A = normalize(A);
    let L = d * cos(u.uBlobBeam.z) + cross(A, d) * sin(u.uBlobBeam.z);
    let v = p - P;
    let s = dot(v, L);
    if (s <= 0.0) { continue; }
    let c = dot(n, -L);
    if (c <= 0.0) { continue; }
    let R = r0 + u.uBlobBeam.y * s;
    let w = v - L * s;
    let xy = vec2f(dot(w, A), dot(w, cross(L, A))) / R;
    let r = length(xy);
    if (r > reach) { continue; }
    let th = atan2(xy.y, xy.x + 1e-6);
    let ph = f32(i) * 2.399;
    let t = u.uBlobShape.y;
    let rr = 1.0 + u.uBlobShape.x * (0.5 * sin(2.0 * th + ph + t) + 0.3 * sin(3.0 * th + 1.7 * ph - 0.8 * t) + 0.2 * sin(5.0 * th + 2.3 * ph + 1.3 * t));
    let m = organicEdge(r - rr, u.uBlobEdge, u.uBlobLook) * pastelTint(xy + ph, 0.5 * t, u.uBlobShape.z);
    sum += m * ((r0 * r0) / (R * R) * c * cloudTrans(P));
  }
  return u.uSunE * (u.uBlobBeam.w * sum);
}

// プリズムで日差しに足す光（A・B・D と G。C と F は日差しそのものを置き換えるので sunLight で扱う）
fn prismLight(p: vec3f, n: vec3f) -> vec3f {
  return patternLight(p, n) + blobLight(p, n);
}
fn panelOn() -> bool { return u.uPrismOn > 0.5 && u.uPrismPattern > 1.5 && u.uPrismPattern < 2.5; }

fn causticRGB(f: i32, p: vec3f, n: vec3f) -> vec3f {
  let c = causticAt(f, p);
  if (u.uPrismCaus <= 0.0) { return vec3f(c); }
  let s = u.uSunDir - n * dot(u.uSunDir, n);
  var d = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.5);
  if (dot(s, s) > 1e-6) { d = normalize(s); }
  let q = min(p - u.uRoomMin, u.uRoomMax - p) + abs(n) * 1e3;
  let rim = smoothstep(0.0, max(u.uPrismFadeM, 0.1), min(q.x, min(q.y, q.z)));
  return mix(vec3f(c), vec3f(causticAt(f, p + d * u.uPrismCaus), c, causticAt(f, p - d * u.uPrismCaus)), rim);
}
fn causticBottomRGB(b: vec3f, fade: f32) -> vec3f {
  let c = causticBottom(b);
  if (fade <= 0.0 || u.uPrismCaus <= 0.0) { return vec3f(c); }
  let s = u.uSunDir.xz;
  var d = vec2f(1.0, 0.0);
  if (dot(s, s) > 1e-6) { d = normalize(s); }
  d *= u.uPrismCaus;
  let rgb = vec3f(causticBottom(b + vec3f(d.x, 0.0, d.y)), c, causticBottom(b - vec3f(d.x, 0.0, d.y)));
  return mix(vec3f(c), rgb, fade);
}
fn sunInterior(o: vec3f) -> f32 {
  var v = select(0.0, 1.0, seesOutside(o, u.uSunDir));
  for (var k = 0; k < 8; k++) {
    let a = 0.7854 * f32(k);
    if (seesOutside(o + vec3f(cos(a), 0.0, sin(a)) * u.uPrismFadeM, u.uSunDir)) { v += 1.0; }
  }
  let rim = min(min(o.x - u.uRoomMin.x, u.uRoomMax.x - o.x), min(o.z - u.uRoomMin.z, u.uRoomMax.z - o.z));
  return smoothstep(0.5, 1.0, v / 9.0) * smoothstep(0.0, max(u.uPrismFadeM, 0.1), rim);
}

fn sunDirect(p: vec3f, n: vec3f) -> vec3f {
  if (u.uSunE.x + u.uSunE.y + u.uSunE.z <= 0.0) { return vec3f(0.0); }
  var sum = 0.0;
  for (var k = 0; k < 12; k++) {
    let r = vec2f((f32(k) + 0.5) / 12.0, fract(f32(k) * 0.618034));
    let l = sunDirAt(r);
    let c = dot(n, l);
    if (c > 0.0 && seesOutside(p, l)) { sum += c; }
  }
  if (sum > 0.0) { return u.uSunE * (sum / 12.0 * cloudTrans(p)); }
  return vec3f(0.0);
}
// 画面に出すときの直射日光（プリズムを含む。C のときは、板で曲がった日差しに置き換える）
fn sunLight(p: vec3f, n: vec3f) -> vec3f {
  if (panelOn()) { return panelLight(p, n) + blobLight(p, n); }
  var sun: vec3f;
  if (u.uOrgOn > 0.5) { sun = organicSun(p, n); } else { sun = sunDirect(p, n); }
  if (u.uShimOn > 0.0 && sun.x + sun.y + sun.z > 0.0) { sun *= shimmer(p, n); }
  return sun + prismLight(p, n);
}

// 照り返しの成分を、同じ面の近くの画素どうしでならす
fn smoothedIndirect(px: vec2f, face: i32, pc: vec3f) -> vec3f {
  let center = accumAt(px);
  if (u.uStride <= 0.0) { return center; }
  let screenC = onScreen(face, pc);
  var sum = vec3f(0.0);
  var wsum = 0.0;
  for (var j = -3; j <= 3; j++) {
    for (var i = -3; i <= 3; i++) {
      let q = px + vec2f(f32(i), f32(j)) * u.uStride;
      if (q.x < 0.0 || q.y < 0.0 || q.x > u.uRes.x || q.y > u.uRes.y) { continue; }
      let h = primaryHit(q);
      if (!h.ok || h.face != face || inWindow(h.face, h.p) || onScreen(h.face, h.p) != screenC) { continue; }
      let dp = h.p - pc;
      let w = exp(-f32(i * i + j * j) / 8.0 - dot(dp, dp) / (2.0 * u.uSigmaP * u.uSigmaP));
      sum += w * accumAt(q);
      wsum += w;
    }
  }
  if (wsum > 0.0) { return sum / wsum; }
  return center;
}

// 水面に映った部屋の面の明るさ（照り返しの成分は、その点が画面に映っていればその画素の値を使う）
fn surfaceRadiance(f: i32, q: vec3f, fallback: vec3f) -> vec3f {
  let n = inwardNormal(f);
  let a = albedo(f, q);
  var ind = fallback;
  let c = u.uViewProj * vec4f(q, 1.0);
  if (c.w > 0.0) {
    let uv = c.xy / c.w * 0.5 + 0.5;
    if (all(uv > vec2f(0.0)) && all(uv < vec2f(1.0))) { ind = accumAt(uv * u.uRes); }
  }
  return a * ind + a / PI * (sunLight(q + n * EPS, n) + u.uSunE * causticRGB(f, q, n) + spotIrradiance(q + n * EPS, n)) + screenLight(f, q, 2.0) + ambientPanel(f, q);
}

// 水盤の底に届く日差し。C（プリズムの板）のときは、板で曲がった日差し（水面の揺らぎは省く）
// E：日だまりの縁をずらす、進む波（src/room/gl.ts と同じ）
fn waveEdge(xz: vec2f) -> f32 {
  let k = 6.2832 / u.uWaveShape.y;
  let t = u.uWaveShape.z;
  let q = xz + 0.08 * u.uWaveShape.y * vec2f(sin(xz.y * k * 0.7 + 0.3 * t), sin(xz.x * k * 0.6 - 0.4 * t));
  return 0.5 * sin(dot(q, vec2f(0.8, 0.6)) * k - t) + 0.3 * sin(dot(q, vec2f(-0.5, 0.87)) * k * 1.37 - 1.21 * t + 1.3)
    + 0.2 * sin(dot(q, vec2f(0.96, -0.28)) * k * 2.11 - 1.6 * t + 0.4);
}
fn bottomSun(b: vec3f, fade: f32, edge: vec3f, flatSun: f32, inner: f32) -> vec3f {
  let top = vec3f(b.x, EPS, b.z);
  let up = vec3f(0.0, 1.0, 0.0);
  if (panelOn()) { return panelLight(top, up) * 0.97 + blobLight(top, up); }
  var c = causticBottomRGB(b, fade);
  if (u.uWaveOn > 0.5 || u.uOrgOn > 0.5) { c = mix(vec3f(flatSun), c, inner) * edge; }
  if (u.uShimOn > 0.0 && c.x + c.y + c.z > 0.0) { c *= shimmer(top, up); }
  return u.uSunE * c + prismLight(top, up);
}

// 水盤：水面で反射する光と、屈折して底から戻る光を、反射の割合（フレネル）で混ぜる
fn poolRadiance(p: vec3f, d: vec3f, ind: vec3f) -> vec3f {
  let n = waveNormal(poolWave(p.xz));
  let F = fresnelWater(dot(-d, n));
  let rd = refract(d, n, 1.0 / IOR);
  let tb = (-u.uPoolDepth - p.y) / min(rd.y, -1e-3);
  let b = p + rd * tb;
  let absorb = exp(-WATER_ABS * (tb + u.uPoolDepth));
  // 光の揺らぎのにじみ（A〜D）と、E の波で揺れる縁（src/room/gl.ts と同じ）
  var fade = 0.0;
  var flatSun = 0.0;
  var inner = 1.0;
  var edge = vec3f(1.0);
  if (u.uPrismOn > 0.5 && (u.uPrismCaus > 0.0 || u.uWaveOn > 0.5 || u.uOrgOn > 0.5) && u.uSunE.x + u.uSunE.y + u.uSunE.z > 0.0) {
    let ts = refract(-u.uSunDir, vec3f(0.0, 1.0, 0.0), 1.0 / IOR);
    let entry = b - ts * (b.y / min(ts.y, -1e-3));
    let e0 = vec3f(entry.x, EPS, entry.z);
    if (u.uPrismCaus > 0.0) { fade = sunInterior(e0); }
    if (u.uWaveOn > 0.5 || u.uOrgOn > 0.5) {
      let w = windowSd(e0);
      let pd = w.z;
      if (u.uWaveOn > 0.5) { edge = organicEdge(pd + u.uWaveShape.x * waveEdge(entry.xz), u.uWaveEdge, u.uWaveLook); }
      else {
        let qs = w.xy / u.uOrgShape.y;
        edge = organicEdge(pd + u.uOrgShape.x * orgNoise(qs, u.uOrgShape.z), u.uOrgEdge, u.uOrgLook) * pastelTint(qs * 0.3 + 3.1, u.uOrgShape.z * 0.5, u.uOrgShape.w);
      }
      flatSun = max(u.uSunDir.y, 0.0) * (1.0 - fresnelWater(u.uSunDir.y)) * cloudTrans(e0);
      inner = smoothstep(0.0, -0.15, pd);
    }
  }
  let lb = vec3f(${POOL_ALBEDO.toFixed(3)}) / PI * ((bottomSun(b, fade, edge, flatSun, inner) + PI * ind) * absorb + spotBottom(b) * exp(-WATER_ABS * tb));
  let rr = reflect(d, n);
  let o = vec3f(p.x, EPS, p.z);
  let e = exitRoom(o, rr);
  let q = o + rr * e.t;
  var lr: vec3f;
  if (inWindow(e.face, q)) {
    lr = outsideRadiance(q, rr) + u.uSunE * (sunLobe(rr) * cloudTrans(q));
  }
  else { lr = surfaceRadiance(e.face, q, ind); }
  lr += spotLamp(o, rr, e.t); // 水面に映るライトのきらめき
  return (1.0 - F) * lb + F * lr;
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn toSrgb(c: vec3f) -> vec3f {
  return select(c * 12.92, 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c >= vec3f(0.0031308));
}

${FULLSCREEN_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let px = vec2f(pos.x, u.uRes.y - pos.y); // WebGL の gl_FragCoord と同じ
  let hc = primaryHit(px);
  // スクリーンの映像を読むぼかしの段は、隣の画素との差から決める（WGSL では分岐の中で求められないので、先に求めておく）
  let st = screenUV(hc.p);
  gScreenDx = dpdx(st);
  gScreenDy = dpdy(st);
  var ind = vec3f(0.0);
  if (hc.ok && !inWindow(hc.face, hc.p)) { ind = smoothedIndirect(px, hc.face, hc.p); }

  // 画素の中の 4 点で、窓の外・反射率・直射日光・光の揺らぎを求める（縁のギザギザを抑える）
  var col = vec3f(0.0);
  for (var k = 0; k < 4; k++) {
    let o = vec2f(select(-0.25, 0.25, k == 1 || k == 3), select(-0.25, 0.25, k >= 2));
    let h = primaryHit(px + o);
    if (!h.ok) { col += OUTSIDE; continue; }
    let lamp = spotLamp(u.uCamPos, h.dir, distance(u.uCamPos, h.p)); // ライトの器具そのもの
    if (lamp.x + lamp.y + lamp.z > 0.0) { col += lamp; continue; }
    if (inWindow(h.face, h.p)) { col += outsideRadiance(h.p, h.dir); continue; }
    if (u.uPoolOn > 0.5 && h.face == 3) { col += poolRadiance(h.p, h.dir, ind); continue; }
    let n = inwardNormal(h.face);
    let a = albedo(h.face, h.p);
    col += a * ind + a / PI * (sunLight(h.p + n * EPS, n) + u.uSunE * causticRGB(h.face, h.p, n) + spotIrradiance(h.p + n * EPS, n)) + screenLight(h.face, h.p, -1.0) + ambientPanel(h.face, h.p);
  }
  col = max(col, vec3f(0.0)) * (0.25 * u.uExposure); // プリズムで白を減らした所が負にならないように
  col = toSrgb(aces(col));
  let nz = fract(sin(dot(px, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  return vec4f(col + nz / 255.0, 1.0);
}
`;

/** テスト用：各段階の WGSL（値の名前がそろっているかを確かめる） */
export const ROOM_WGSL = { caustic: causticShader, trace: traceShader, display: displayShader };

const CAUSTIC_PASS_BYTES = 64;
const CAUSTIC_PASS_STRIDE = 256; // 動的なずらし（dynamic offset）の単位
const MAX_CAUSTIC_PASSES = 16;

export class GpuRoomRenderer implements RoomRenderer {
  readonly canvas = document.createElement('canvas');
  private readonly gpu: Gpu;
  private readonly ctx: GPUCanvasContext;
  private readonly uniforms: Record<string, { value: unknown }>;
  private readonly layout: Layout;
  private readonly data: Float32Array;
  private readonly buffer: GPUBuffer;
  private readonly passBuffer: GPUBuffer;
  private readonly passData = new Float32Array((CAUSTIC_PASS_STRIDE / 4) * MAX_CAUSTIC_PASSES);
  private readonly mainLayout: GPUBindGroupLayout;
  private readonly tracePipeline: GPURenderPipeline;
  private readonly displayPipeline: GPURenderPipeline;
  private readonly causticPipeline: GPURenderPipeline;
  private readonly causticBinds: [GPUBindGroup, GPUBindGroup];
  private readonly causticTex = new Map<number, GPUTexture>();
  private readonly screenTex: GPUTexture;
  private readonly linearS: GPUSampler;
  private readonly screenS: GPUSampler;
  private readonly grids: Record<'pool' | 'sea', { vertex: GPUBuffer; index: GPUBuffer; format: GPUIndexFormat; count: number }>;
  private readonly mips: MipGenerator;
  private readonly core: RoomCore;
  private readonly ocean: GpuOcean;
  private readonly oceanS: GPUSampler;
  private oceanVersion = 0;
  private accum: [GPUTexture, GPUTexture] | null = null;
  private traceBinds: GPUBindGroup[] = [];
  private displayBinds: GPUBindGroup[] = [];
  private current = 0; // 最後に書いた重ね合わせの画像（0 か 1）
  private screenScene: { id: string; inst: ReturnType<RoomScreenImage['def']['create']>; pipeline: FullscreenPipeline } | null = null;

  constructor(gpu: Gpu, core: RoomCore) {
    this.gpu = gpu;
    const device = gpu.device;
    this.ctx = configureCanvas(gpu, this.canvas);
    this.mips = new MipGenerator(device);
    this.core = core;
    this.ocean = new GpuOcean(device);
    this.oceanS = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });

    // 値はすべて core の同じ物を参照する（core が書き換えれば、そのまま描く値になる）
    this.uniforms = { ...core.shared, uCausOn: core.causOn, ...core.trace, ...core.display };
    this.layout = buildLayout(this.uniforms, 'Room');
    this.data = new Float32Array(this.layout.size / 4);
    this.buffer = device.createBuffer({ size: this.layout.size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'room-values' });
    this.passBuffer = device.createBuffer({ size: this.passData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'room-caustic-passes' });
    const head = `${this.layout.wgsl}\n@group(0) @binding(0) var<storage, read> u: Room;\n`;

    this.linearS = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.screenS = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    for (const face of CAUSTIC_FACES) {
      this.causticTex.set(face, device.createTexture({
        size: [CAUSTIC_SIZE, CAUSTIC_SIZE], format: CAUSTIC, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: `caustic-${face}`,
      }));
    }
    // スクリーンに映す映像を描く画像。遠くから見ると縮小されるので、ミップマップを作ってちらつきを抑える
    this.screenTex = device.createTexture({
      size: [SCREEN_IMAGE.width, SCREEN_IMAGE.height], format: SCREEN,
      mipLevelCount: Math.floor(Math.log2(SCREEN_IMAGE.width)) + 1,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: 'room-screen',
    });

    // 段階 1・2 の結び付け方（値・重ね合わせの画像・光の揺らぎの画像 6 枚・スクリーンの映像）
    const tex = (binding: number, sampleType: GPUTextureSampleType = 'float'): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType } });
    this.mainLayout = device.createBindGroupLayout({
      label: 'room-main',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        tex(1, 'unfilterable-float'),
        tex(2), tex(3), tex(4), tex(5), tex(6), tex(7),
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        tex(9),
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        tex(11), tex(12),
        { binding: 13, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const fullscreen = (code: string, format: GPUTextureFormat, label: string): GPURenderPipeline => {
      const module = device.createShaderModule({ code: head + code, label });
      return device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.mainLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      });
    };
    this.tracePipeline = fullscreen(traceShader, ACCUM, 'room-trace');
    this.displayPipeline = fullscreen(displayShader, gpu.format, 'room-display');

    // 段階 0：網目を描いて、届いた先の面の画像に足し込む（加算合成）
    const causticLayout0 = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }],
    });
    const causticLayout1 = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: CAUSTIC_PASS_BYTES } }],
    });
    const cmodule = device.createShaderModule({ code: head + causticShader, label: 'room-caustic' });
    const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
    this.causticPipeline = device.createRenderPipeline({
      label: 'room-caustic',
      layout: device.createPipelineLayout({ bindGroupLayouts: [causticLayout0, causticLayout1] }),
      vertex: { module: cmodule, entryPoint: 'vs', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] },
      fragment: { module: cmodule, entryPoint: 'fs', targets: [{ format: CAUSTIC, blend: { color: add, alpha: add } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, // 届いた先で網目が裏返ることがある
    });
    this.causticBinds = [
      device.createBindGroup({ layout: causticLayout0, entries: [{ binding: 0, resource: { buffer: this.buffer } }] }),
      device.createBindGroup({ layout: causticLayout1, entries: [{ binding: 0, resource: { buffer: this.passBuffer, size: CAUSTIC_PASS_BYTES } }] }),
    ];

    // 水面の網目（uv だけ使う）
    const grid = (segs: [number, number]) => {
      const g = new THREE.PlaneGeometry(1, 1, ...segs);
      const uv = g.getAttribute('uv').array as Float32Array;
      const idx = g.getIndex()!.array as Uint16Array | Uint32Array;
      const format: GPUIndexFormat = idx instanceof Uint32Array ? 'uint32' : 'uint16';
      const vertex = device.createBuffer({ size: uv.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(vertex, 0, uv);
      // 書き込みは 4 バイト単位なので、uint16 の個数が奇数なら 1 つ足す
      const padded = format === 'uint16' && idx.length % 2 ? Uint16Array.from([...idx, 0]) : idx;
      const index = device.createBuffer({ size: padded.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(index, 0, padded);
      g.dispose();
      return { vertex, index, format, count: idx.length };
    };
    this.grids = { pool: grid(core.poolGridSegs), sea: grid(core.seaGridSegs) };
  }

  resize(w: number, h: number): void {
    this.canvas.width = w;
    this.canvas.height = h;
    const device = this.gpu.device;
    this.accum?.forEach((t) => t.destroy());
    const make = (i: number): GPUTexture => device.createTexture({
      size: [w, h], format: ACCUM, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: `room-accum-${i}`,
    });
    this.accum = [make(0), make(1)];
    const bind = (accumView: GPUTextureView): GPUBindGroup => device.createBindGroup({
      layout: this.mainLayout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer } },
        { binding: 1, resource: accumView },
        ...[0, 1, 2, 4, 5, 6].map((face, i) => ({ binding: 2 + i, resource: this.causticTex.get(face)!.createView() })),
        { binding: 8, resource: this.linearS },
        { binding: 9, resource: this.screenTex.createView() },
        { binding: 10, resource: this.screenS },
        { binding: 11, resource: this.ocean.textures[0].createView() },
        { binding: 12, resource: this.ocean.textures[1].createView() },
        { binding: 13, resource: this.oceanS },
      ],
    });
    // 段階 1 は前の結果（i）を読んで、もう片方に書く。段階 2 は書いたばかりの方を読む
    this.traceBinds = [bind(this.accum[0].createView()), bind(this.accum[1].createView())];
    this.displayBinds = this.traceBinds;
    this.current = 0;
  }

  render(frame: RoomFrame): void {
    if (!this.accum) return;
    const device = this.gpu.device;
    writeLayout(this.layout, this.uniforms, this.data);
    device.queue.writeBuffer(this.buffer, 0, this.data);
    const encoder = device.createCommandEncoder();

    if (frame.screen) this.renderScreenImage(frame.screen, encoder);
    // FFT の海：スペクトルが変わったら送り直し、毎フレーム海面の画像を作る
    const oc = this.core.ocean;
    if (this.uniforms.uOceanOn!.value && oc) {
      if (oc.version !== this.oceanVersion) {
        this.ocean.upload(oc.spectrum);
        this.oceanVersion = oc.version;
      }
      this.ocean.run(encoder, this.core.oceanTime);
    }
    this.renderCaustics(frame.caustics, encoder);

    // 段階 1：空の光と照り返し
    const next = 1 - this.current;
    const trace = encoder.beginRenderPass({ colorAttachments: [{ view: this.accum[next]!.createView(), loadOp: 'clear', storeOp: 'store' }] });
    trace.setPipeline(this.tracePipeline);
    trace.setBindGroup(0, this.traceBinds[this.current]!);
    trace.draw(3);
    trace.end();
    this.current = next;

    // 段階 2：画面に出す
    const display = encoder.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    display.setPipeline(this.displayPipeline);
    display.setBindGroup(0, this.displayBinds[this.current]!);
    display.draw(3);
    display.end();

    device.queue.submit([encoder.finish()]);
  }

  // 段階 0：水面の光の揺らぎ。面ごとの画像を毎フレーム消してから、その面に届く網目を足し込む
  private renderCaustics(passes: CausticPass[], encoder: GPUCommandEncoder): void {
    const list = passes.slice(0, MAX_CAUSTIC_PASSES);
    list.forEach((p, i) => {
      const o = (i * CAUSTIC_PASS_STRIDE) / 4;
      this.passData.set([p.o.x, p.o.y, p.o.z, p.y, p.u.x, p.u.y, p.u.z, p.source, p.v.x, p.v.y, p.v.z, p.mode, p.target], o);
    });
    if (list.length) this.gpu.device.queue.writeBuffer(this.passBuffer, 0, this.passData, 0, (list.length * CAUSTIC_PASS_STRIDE) / 4);
    for (const [face, tex] of this.causticTex) {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(this.causticPipeline);
      pass.setBindGroup(0, this.causticBinds[0]);
      list.forEach((p, i) => {
        if (p.target !== face) return;
        const g = this.grids[p.grid];
        pass.setBindGroup(1, this.causticBinds[1], [i * CAUSTIC_PASS_STRIDE]);
        pass.setVertexBuffer(0, g.vertex);
        pass.setIndexBuffer(g.index, g.format);
        pass.drawIndexed(g.count);
      });
      pass.end();
    }
  }

  finish(): Promise<void> {
    return this.gpu.device.queue.onSubmittedWorkDone();
  }

  private renderScreenImage(img: RoomScreenImage, encoder: GPUCommandEncoder): void {
    if (this.screenScene?.id !== img.def.id) {
      this.screenScene?.inst.dispose();
      this.screenScene?.pipeline.dispose();
      const inst = img.def.create(SCREEN_IMAGE);
      const pipeline = new FullscreenPipeline(this.gpu, inst.pass.wgsl, inst.pass.uniforms, SCREEN, textureCache(this.gpu), `room-screen-${img.def.id}`);
      this.screenScene = { id: img.def.id, inst, pipeline };
    }
    this.screenScene.inst.update(img.input, img.params);
    this.screenScene.pipeline.encode(encoder, this.screenTex.createView({ baseMipLevel: 0, mipLevelCount: 1 }), SCREEN_IMAGE);
    this.mips.generate(this.screenTex, encoder);
  }

  dispose(): void {
    this.accum?.forEach((t) => t.destroy());
    for (const t of this.causticTex.values()) t.destroy();
    this.screenTex.destroy();
    this.buffer.destroy();
    this.passBuffer.destroy();
    for (const g of Object.values(this.grids)) { g.vertex.destroy(); g.index.destroy(); }
    this.screenScene?.inst.dispose();
    this.screenScene?.pipeline.dispose();
    this.ctx.unconfigure();
  }
}
