// 部屋の中央の光の軌跡：描く部分。部屋の画面の上に重ねた透明な canvas に、WebGL2（three.js）で描く。
// - 部屋の光の計算（WebGPU・WebGL2）とは別の画面なので、計算の解像度を下げていても、線は出す大きさ（3840×1080 など）で描く
// - 重ねるときは CSS の mix-blend-mode: plus-lighter で明るさを足す（光の線なので、下の部屋の絵に光が加わる）
// - カメラは部屋と同じもの（マウスの視点・パース合わせの視点）を使い、四隅の位置合わせも部屋の画面と一緒に掛かる
// 線は細い帯（点ごとに 2 頂点）にして、画面の上での太さを決める。先頭が太く明るく、後ろほど細く暗くなる
import * as THREE from 'three';
import { hexToRgb, spotColor } from './core.ts';
import { type RoomGeometry, type SpotSettings, type TrailSettings } from './model.ts';
import { TrailSim, type TrailMotion } from './trails-sim.ts';

export const TRAIL_MAX_COUNT = 4096;
export const TRAIL_MAX_POINTS = 128;
// 点の位置は、使う本数 × 点の数ちょうどの画像で毎フレーム GPU へ送る（既定の 1,024 本 × 32 点で 512KB）
/** 太さの基準の幅（3840×1080 で出したときの画素で太さを決める） */
const WIDTH_REF = 3840;

const vertexShader = /* glsl */ `
uniform sampler2D uPos;
uniform vec2 uRes;
uniform float uWidth;
uniform float uPoints;
in float aLine;
in float aPoint;
in float aSide;
out float vT;
out float vSide;
out float vLine;
vec3 P(float i) { return texelFetch(uPos, ivec2(int(i), int(aLine)), 0).xyz; }
void main() {
  float i = aPoint;
  vec4 c = projectionMatrix * viewMatrix * vec4(P(i), 1.0);
  vec4 ca = projectionMatrix * viewMatrix * vec4(P(max(i - 1.0, 0.0)), 1.0);
  vec4 cb = projectionMatrix * viewMatrix * vec4(P(min(i + 1.0, uPoints - 1.0)), 1.0);
  vT = i / (uPoints - 1.0);
  vSide = aSide;
  vLine = aLine;
  if (c.w <= 0.0 || ca.w <= 0.0 || cb.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // 目の後ろ
  // 画面の上での線の向きに垂直に、太さぶん広げる（画素で）
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uRes;
  vec2 n = length(d) > 1e-6 ? normalize(vec2(-d.y, d.x)) : vec2(0.0, 1.0);
  float w = uWidth * (1.0 - 0.75 * vT);
  c.xy += n * aSide * w / uRes * c.w;
  gl_Position = c;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uMode;      // 0 = 日差し・ライトの色、1 = 線ごとに色相をずらす、2 = 選んだ色
uniform float uHue;       // 基準の色相（0〜1）
uniform float uSpread;    // 色相をずらす幅
uniform float uCount;
uniform float uBright;
uniform float uTime;
in float vT;
in float vSide;
in float vLine;
out vec4 fragColor;
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
float hash(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
void main() {
  // 帯の幅の方向は中心ほど明るく（光の線のにじみ）、後ろほど暗くなる
  float across = 1.0 - vSide * vSide;
  float along = pow(1.0 - vT, 1.5);
  float a = across * along * uBright;
  vec3 col = uColor;
  if (uMode > 0.5 && uMode < 1.5) col = hsv(fract(uHue + uSpread * (vLine / max(1.0, uCount)) + uTime * 0.01), 0.75, 1.0);
  // 線ごとに明るさを少しばらつかせる（同じ色でも単調にならないように）
  a *= 0.6 + 0.4 * hash(vLine + 1.0);
  fragColor = vec4(col * a, a);
}
`;

/** 「日差し・ライトの色に合わせる」ときの色（sRGB、いちばん明るい成分を 1 にする） */
export function trailSceneColor(sunColor: readonly [number, number, number], sunAltDeg: number, spot: SpotSettings, spotOn: number): THREE.Color {
  // 昼は日差しの色。太陽が沈むにつれて、点いているライトの色（平均）へ移る
  const day = Math.min(1, Math.max(0, (sunAltDeg + 2) / 8));
  const lights = spot.lights.slice(0, spot.count).filter((l) => l.strength > 0);
  const night = new THREE.Vector3(1, 0.85, 0.7);
  if (spotOn > 0 && lights.length) {
    night.set(0, 0, 0);
    for (const l of lights) night.add(spotColor(l));
    night.multiplyScalar(1 / lights.length);
    night.set(night.x ** (1 / 2.2), night.y ** (1 / 2.2), night.z ** (1 / 2.2)); // 線形 → sRGB のおおよそ
  }
  const c = new THREE.Vector3(...sunColor).multiplyScalar(day).addScaledVector(night, 1 - day);
  const m = Math.max(c.x, c.y, c.z, 1e-3);
  return new THREE.Color(c.x / m, c.y / m, c.z / m);
}

/** 色の色相（0〜1） */
const hueOf = (hex: string): number => {
  const hsl = { h: 0, s: 0, l: 0 };
  const [r, g, b] = hexToRgb(hex);
  new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace).getHSL(hsl, THREE.SRGBColorSpace);
  return hsl.h;
};

/**
 * 光の軌跡の層。部屋を作り直しても線の動きが続くように、部屋とは別に 1 つだけ作る（src/main.ts）
 */
export class TrailLayer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly sim = new TrailSim(TRAIL_MAX_COUNT, TRAIL_MAX_POINTS);
  private texData = new Float32Array(4);
  private tex: THREE.DataTexture;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly scene = new THREE.Scene();
  private builtFor = '';
  private lastT = -1;
  private drawn = false;
  private readonly t0 = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.tex = this.makeTexture(1, 1);
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader, fragmentShader,
      uniforms: {
        uPos: { value: this.tex }, uRes: { value: new THREE.Vector2(1, 1) }, uWidth: { value: 2 }, uPoints: { value: 2 },
        uColor: { value: new THREE.Color(1, 1, 1) }, uMode: { value: 0 }, uHue: { value: 0 }, uSpread: { value: 1 },
        uCount: { value: 1 }, uBright: { value: 1 }, uTime: { value: 0 },
      },
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, // 帯の三角形の向きは線の向きで変わるので、両面を描く
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  private makeTexture(points: number, count: number): THREE.DataTexture {
    this.texData = new Float32Array(points * count * 4);
    const tex = new THREE.DataTexture(this.texData, points, count, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  /** 描く大きさ（出す大きさの画素。部屋の計算の解像度とは別） */
  setSize(w: number, h: number): void {
    const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
    if (this.canvas.width !== W || this.canvas.height !== H) this.renderer.setSize(W, H, false);
  }

  /** 線の並び（本数・点の数が変わったときだけ作り直す） */
  private build(count: number, points: number): void {
    const key = `${count}x${points}`;
    if (key === this.builtFor) return;
    this.builtFor = key;
    const n = count * points * 2;
    const line = new Float32Array(n), point = new Float32Array(n), side = new Float32Array(n);
    let k = 0;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < points; j++) {
        for (const sd of [-1, 1]) { line[k] = i; point[k] = j; side[k] = sd; k++; }
      }
    }
    const index: number[] = [];
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < points - 1; j++) {
        const a = (i * points + j) * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.geometry.setAttribute('aLine', new THREE.BufferAttribute(line, 1));
    this.geometry.setAttribute('aPoint', new THREE.BufferAttribute(point, 1));
    this.geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    // three.js は position を探すので、使わない値を入れておく
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setIndex(index);
    this.tex.dispose();
    this.tex = this.makeTexture(points, count);
    this.material.uniforms['uPos']!.value = this.tex;
  }

  /** 1 フレーム進めて描く。消すときは画面を空にする */
  render(camera: THREE.Camera, t: TrailSettings, room: RoomGeometry, color: THREE.Color): void {
    const now = (performance.now() - this.t0) / 1000;
    const dt = this.lastT < 0 ? 1 / 60 : now - this.lastT;
    this.lastT = now;
    if (!t.on) {
      if (this.drawn) { this.renderer.clear(); this.drawn = false; }
      return;
    }
    const motion: TrailMotion = {
      count: Math.min(TRAIL_MAX_COUNT, Math.max(1, Math.round(t.count))),
      points: Math.min(TRAIL_MAX_POINTS, Math.max(2, Math.round(t.points))),
      speed: t.speed, turbulence: t.turbulence, spread: t.spread, radiusM: t.radiusM,
      center: { x: 0, y: t.centerHeightM, z: -(t.centerFromFrontM > 0 ? t.centerFromFrontM : room.depthM / 2) },
      minY: 0.05, maxY: room.heightM - 0.05,
    };
    this.sim.step(motion, dt);
    const count = this.sim.activeCount, points = this.sim.activePoints;
    this.build(count, points);
    // 点の位置を画像に詰める（1 行 = 1 本の線）
    const P = this.sim.positions, D = this.texData;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < points; j++) {
        const s = (i * TRAIL_MAX_POINTS + j) * 3, d = (i * points + j) * 4;
        D[d] = P[s]!; D[d + 1] = P[s + 1]!; D[d + 2] = P[s + 2]!;
      }
    }
    this.tex.needsUpdate = true;
    const u = this.material.uniforms;
    u['uRes']!.value.set(this.canvas.width, this.canvas.height);
    u['uWidth']!.value = (Math.max(0.5, t.widthPx) * this.canvas.width) / WIDTH_REF;
    u['uPoints']!.value = points;
    u['uCount']!.value = count;
    u['uBright']!.value = t.brightness;
    u['uTime']!.value = now;
    u['uMode']!.value = t.colorMode === 'hue' ? 1 : t.colorMode === 'color' ? 2 : 0;
    u['uHue']!.value = hueOf(t.color);
    u['uSpread']!.value = t.hueSpread;
    if (t.colorMode === 'color') {
      const [r, g, b] = hexToRgb(t.color);
      u['uColor']!.value.setRGB(r, g, b);
    } else {
      u['uColor']!.value.copy(color);
    }
    this.renderer.render(this.scene, camera);
    this.drawn = true;
  }
}
