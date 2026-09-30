// 全画面シェーダー 1 枚で描くシーン用の共通部品。
// 映像は GLSL（WebGL2 用）と WGSL（WebGPU 用）の 2 つのシェーダーを持ち、値（uniform）はどちらも同じ「名前 → { value }」で渡す。
// どちらで描くかは土台（src/stage.ts・src/gpu/stage.ts）が決める
import * as THREE from 'three';

/** 格子を NOISE_PERIOD で繰り返すタイル化ノイズ。流す量を wrap() で巻き戻しても継ぎ目が出ない */
export const NOISE_PERIOD = 256;

export const GLSL_NOISE = /* glsl */ `
const float NOISE_PERIOD = ${NOISE_PERIOD.toFixed(1)};
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float hashTiled(vec2 i) { return hash(mod(i, NOISE_PERIOD)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashTiled(i), hashTiled(i + vec2(1, 0)), u.x), mix(hashTiled(i + vec2(0, 1)), hashTiled(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; } return v; }
`;

/** GLSL_NOISE と同じもの（WGSL）。GLSL の mod(x, y) は x - y·floor(x / y)（WGSL の % とは負の数で結果が違う） */
export const WGSL_NOISE = /* wgsl */ `
const NOISE_PERIOD: f32 = ${NOISE_PERIOD.toFixed(1)};
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn hashTiled(i: vec2f) -> f32 { return hash(i - NOISE_PERIOD * floor(i / NOISE_PERIOD)); }
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f); // GLSL 版の u（WGSL では u が値の構造体の名前なので、別の名前にする）
  return mix(mix(hashTiled(i), hashTiled(i + vec2f(1.0, 0.0)), s.x), mix(hashTiled(i + vec2f(0.0, 1.0)), hashTiled(i + vec2f(1.0, 1.0)), s.x), s.y);
}
fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var v = 0.0;
  var a = 0.5;
  for (var i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}
`;

/** 長時間稼働で GPU の float 精度が落ちないよう、流す量を周期内に巻き戻す（CPU 側の倍精度で計算） */
export const wrap = (value: number, period = NOISE_PERIOD): number => ((value % period) + period) % period;

/**
 * 3 次元シンプレックスノイズ（-1〜1）。
 * webgl-noise（Ian McEwan, Stefan Gustavson / Ashima Arts）より。MIT ライセンス：
 * Copyright (C) 2011 Ashima Arts. Copyright (C) 2011-2016 by Stefan Gustavson.
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software ... (MIT License)
 * https://github.com/ashima/webgl-noise
 */
export const GLSL_SIMPLEX3 = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

/** GLSL_SIMPLEX3 と同じもの（WGSL）。webgl-noise（MIT ライセンス、上の表記のとおり）を WGSL に書き直したもの */
export const WGSL_SIMPLEX3 = /* wgsl */ `
fn mod289v3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289v4(x: vec4f) -> vec4f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute4(x: vec4f) -> vec4f { return mod289v4(((x * 34.0) + 1.0) * x); }
fn taylorInvSqrt4(r: vec4f) -> vec4f { return 1.79284291400159 - 0.85373472095314 * r; }
fn snoise(v: vec3f) -> f32 {
  let C = vec2f(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4f(0.0, 0.5, 1.0, 2.0);
  var i = floor(v + dot(v, C.yyy));
  let x0 = v - i + dot(i, C.xxx);
  let g = step(x0.yzx, x0.xyz);
  let l = 1.0 - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);
  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;
  i = mod289v3(i);
  let p = permute4(permute4(permute4(
      i.z + vec4f(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4f(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4f(0.0, i1.x, i2.x, 1.0));
  let n_ = 0.142857142857;
  let ns = n_ * D.wyz - D.xzx;
  let j = p - 49.0 * floor(p * ns.z * ns.z);
  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);
  let x = x_ * ns.x + ns.yyyy;
  let y = y_ * ns.x + ns.yyyy;
  let h = 1.0 - abs(x) - abs(y);
  let b0 = vec4f(x.xy, y.xy);
  let b1 = vec4f(x.zw, y.zw);
  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(h, vec4f(0.0));
  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;
  var p0 = vec3f(a0.xy, h.x);
  var p1 = vec3f(a0.zw, h.y);
  var p2 = vec3f(a1.xy, h.z);
  var p3 = vec3f(a1.zw, h.w);
  let norm = taylorInvSqrt4(vec4f(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  var m = max(0.6 - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
  m = m * m;
  return 42.0 * dot(m * m, vec4f(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

/**
 * 流れ・形の変化など、足し続ける動きの量（3 次元）。そのままだと大きくなって GPU の float の精度が落ち、動きがカクつく。
 * そこで量が limit を超えたら、0 から始まる同じ動き（b）へ blendSec 秒かけて移り、移り終えたら a = b に巻き戻す。
 * シェーダーでは a と b の 2 つの模様を blend の重みで混ぜる（blend = 0 のときは a だけ計算すればよい）
 */
export class DriftBlend {
  readonly a = new THREE.Vector3();
  readonly b = new THREE.Vector3();
  blend = 0;
  private readonly rewind = new THREE.Vector3();
  private readonly limit: number;
  private readonly blendSec: number;
  constructor(limit = 200, blendSec = 40) {
    this.limit = limit;
    this.blendSec = blendSec;
  }

  step(velocity: THREE.Vector3, dt: number): void {
    this.a.addScaledVector(velocity, dt);
    if (this.blend === 0 && Math.max(Math.abs(this.a.x), Math.abs(this.a.y), Math.abs(this.a.z)) > this.limit) {
      this.rewind.copy(this.a);
      this.blend = 1e-6;
    }
    if (this.blend > 0) {
      this.blend += dt / this.blendSec;
      if (this.blend >= 1) {
        this.a.sub(this.rewind); // 移り終えた：b（0 から始めた動き）がそのまま a になる
        this.blend = 0;
      }
    }
    this.b.copy(this.a).sub(this.rewind);
  }
}

/** 映像のシェーダー。wgsl は `fn frag(p: vec2f) -> vec3f` を定義する（p は WebGL の gl_FragCoord.xy と同じ向き。値は `u.名前`） */
export interface ShaderSource {
  glsl: string;
  wgsl: string;
}

/** 全画面を 1 枚のシェーダーで描く映像。どちらの方式で描くかは土台が決める */
export interface FullscreenPass extends ShaderSource {
  uniforms: Record<string, THREE.IUniform>;
}

export function fullscreenShader<U extends Record<string, THREE.IUniform>>(src: ShaderSource, uniforms: U) {
  return {
    uniforms,
    pass: { ...src, uniforms } as FullscreenPass,
    dispose(): void {},
  };
}

const VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** WebGL2（three.js）で描くための物を作る */
export function glPass(pass: FullscreenPass) {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: pass.glsl, uniforms: pass.uniforms });
  scene.add(new THREE.Mesh(geometry, material));
  return {
    scene,
    camera,
    dispose(): void { geometry.dispose(); material.dispose(); },
  };
}

// THREE.Color は sRGB の hex を線形色空間へ変換してしまう（暗くくすむ）ので使わない。シェーダーは sRGB の値のまま扱う
export const hexToVec3 = (hex: string): THREE.Vector3 => new THREE.Vector3(
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
);
