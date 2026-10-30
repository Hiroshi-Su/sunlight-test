// room モードの 1 フレームぶんの計算のうち、描く方式（WebGL2・WebGPU）によらない部分。
// 設定と日差しから、シェーダーに渡す値・光の揺らぎを描く網目の一覧・重ね合わせの重みを決める。
// 実際に描くのは src/room/gl.ts（WebGL2）と src/room/gpu.ts（WebGPU）
import * as THREE from 'three';
import { type WindowSide, wallWindowSide } from '../config.ts';
import { type RGB, kelvinToRgb } from '../palette.ts';
import { DriftBlend } from '../scenes/shader.ts';
import { SUN_ANGULAR_RADIUS_DEG, directSunFactor, skyBrightness } from './daylight.ts';
import { MAX_BLOBS, MAX_PRISMS, MAX_SHIM_COLORS, MAX_SHIM_PALETTE, MAX_SPOTS, GLASS_FACES, GLASS_FACE_INDEX, GLASS_SURFACES, type GlassSpec, TEX_SURFACES, moonLightCurve, moonPhaseBrightness, moonSkyCurve, PRISM_PATTERNS, type OrganicLook, type PrismMotion, type RoomGeometry, type RoomInput, type RoomRenderSettings, type RoomScreenImage, type SpotLight, cloudFlowDir, acesInverse, effectiveSeaLevel, poolSeaMask, lighthouseProfile, lighthouseWeight, moonDirection, moonWeight, spotPose, spotWeight, toThree, windowRect } from './model.ts';
import { MAX_ROOM_PRIMS, type RoomMesh, type RoomPrim, type Vec3 } from './step.ts';
import { MAX_TEXTURES, type TexturePixels, texturePixels } from './textures.ts';
import { OCEAN_CASCADES, OCEAN_LODS, type OceanSpectrum, buildOceanSpectrum } from './ocean.ts';
import { wavePhases } from './water.ts';

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
export const WALL_ALBEDO = 0.82; // 白い塗装の壁
export const FLOOR_ALBEDO = 0.72;
export const SCREEN_ALBEDO = 0.45;
export const POOL_ALBEDO = 0.62; // 水盤の底（明るい石）
// スポットライトの明るさの目盛り（光度、演出上の値）。明るさの倍率 1 で、真下 3m の床の放射照度が
// 晴れた日の直射日光の約 1/3（夜に露出 2.5 のとき、照らされた床がほどよく見える程度）
const SPOT_SCALE = 7.0;
/** 全体照明の明るさの目盛り。明るさ 1 で、10 × 6 × 3.2m の部屋の床の中央が、スポットライト 1 台の真下と同じくらいになる */
const AMBIENT_SCALE = 0.045;
// 月明かりの明るさの目盛り（演出上の値。実際の月の光は日差しの約 40 万分の 1 で、そのままでは見えない）。
// 倍率 1 で、月の光（光に垂直な面での放射照度）は晴れた日の直射日光の約 1/10、夜空の明るさは昼の空の約 1/8
const MOON_SCALE = 0.25;
const MOON_SKY_SCALE = SKY_SCALE * 0.12;
// 灯台の光の目盛り（演出上の値）。明るさ 1 で、帯がこちらを向いた瞬間に部屋に届く光（放射照度）が、既定の月の光（満月）の約 3 倍
const LIGHTHOUSE_SCALE = MOON_SCALE * 0.5 * 3;
/** 灯台の光の帯が見える、空気のもやの散乱の強さ（1/m、もやの濃さ 1 のとき）。夜空の前で帯がほどよく見える値 */
const LIGHTHOUSE_AIR = 1e-3;
/** こちらを向いたときの灯火のにじみ（にじみ 1 のとき）。灯火のまわり約 2° が光る */
const LIGHTHOUSE_GLARE = 0.002;
/** 灯台の光が見える距離の目安（m。これより遠い所の光の帯は、もやでかすむ） */
const LIGHTHOUSE_VIS = 10000;
/** 窓から見える月の円盤の明るさ（露出をかけた後の値。トーンマップで約 0.88 の白になり、表面の模様が見える） */
const MOON_DISK_EXPOSED = 1.6;
/** スポットライトの器具の大きさ（球の半径、m）。水面に映るライトのきらめきと、器具そのものの見え方に使う */
export const SPOT_RADIUS = 0.06;
export const CAUSTIC_SIZE = 512; // 光の揺らぎを記録する面ごとの画像の大きさ（画素）
/** 光の揺らぎの画像を持つ面：0 = 右の壁、1 = 左の壁、2 = 天井、4 = 手前、5 = 奥、6 = 水盤の底 */
export const CAUSTIC_FACES = [0, 1, 2, 4, 5, 6] as const;
/** スクリーンに映す映像を描く大きさ（展示と同じ 3840×1080。映像の中の px 単位の値がそのまま合う） */
export const SCREEN_IMAGE = { width: 3840, height: 1080 };
/** 雲の濃さのばらつきの大きさ（大きいほど、雲のかたまりと青空の差がはっきりする） */
const CLOUD_CONTRAST = 1.7;
// 1 つ目の窓の面。天窓＋左の窓のときは、1 つ目が左の壁、2 つ目（uWin2Rect）が天窓
const WINDOW_FACE: Record<WindowSide, number> = { right: 0, left: 1, ceiling: 2, 'ceiling-left': 1 };
// 光の揺らぎのにじみ（と E の視線の屈折のずれ）を、日なたと影の境目・面の縁で消す幅（m）
const PRISM_EDGE_FADE_M = 0.3;

/** 水面の光の揺らぎを 1 回描く（水面の網目 1 枚 × 届く先の面 1 つ） */
export interface CausticPass {
  grid: 'pool' | 'sea';
  /** 0 = 水盤、1 = 窓の外の水面 */
  source: number;
  /** 0 = 反射、1 = 屈折 */
  mode: number;
  /** 届く先の面（0〜5 = 部屋の面、6 = 水盤の底） */
  target: number;
  o: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  y: number;
}

export interface RoomFrame {
  caustics: CausticPass[];
  /** スクリーンに映す映像（映さないときは null） */
  screen: RoomScreenImage | null;
}

/** "#rrggbb"（sRGB）→ 0〜1。読めなければ白（three.js の Color は色を線形に直して読むので、ここでは使わない） */
export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** 色合いだけを残す（明るさ（輝度）を 1 にする。真っ黒なら白） */
const unitLum = (c: THREE.Vector3): THREE.Vector3 => {
  const lum = 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
  return lum > 1e-4 ? c.multiplyScalar(1 / lum) : new THREE.Vector3(1, 1, 1);
};

/**
 * ガラスの表面の曲がり具合の最大（正弦波ごとの 振幅 × 波数² の和の 6 割）から、光が集まり切る距離 ×（n−1）を決める。
 * シェーダーの正弦波（GLASS_W）と同じ並び：[波の長さの倍率, 深さと長さの倍率]
 */
function glassFocus(gs: GlassSpec): number {
  const L = Math.max(0.01, gs.scaleM), A = Math.max(0, gs.depthMM) / 1000;
  const waves: [number, number][] = gs.surface === 'reeded' ? [[1, 1]]
    : gs.surface === 'swell' ? [[1, 3], [0.73, 3], [1.31, 3]]
    : [[1, 1], [0.73, 1], [1.31, 1], [0.58, 1], [1.12, 1], [0.87, 1]];
  const hmax = 0.6 * waves.reduce((sum, [w, m]) => sum + A * m * (gs.surface === 'reeded' ? 1 : 0.45) * (2 * Math.PI / (L * w * m)) ** 2, 0);
  return hmax > 0 ? 1 / hmax : 1e3;
}

/** スポットライトの色（線形）。明るさの目盛りをそろえるため、色を変えても明るさ（輝度）は 1 にする */
export function spotColor(light: SpotLight): THREE.Vector3 {
  const c = linear(light.colorMode === 'color' ? hexToRgb(light.color) : kelvinToRgb(light.kelvin));
  const lum = 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
  return lum > 1e-4 ? c.multiplyScalar(1 / lum) : new THREE.Vector3(1, 1, 1);
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** 1 フレームで 1 画素あたり追う光線の本数（多いほど早くきれいになるが重い）。URL の ?spp= で変えられる */
export function samplesPerPixel(): number {
  return Math.max(1, Math.min(8, Number(new URLSearchParams(location.search).get('spp') ?? 2) || 2));
}

/** 面に貼る画像の組（使う画像を並べたもの。i 番目の画像が、画像の束の i 枚目） */
export interface TextureSet {
  key: string;
  ids: string[];
  pixels: TexturePixels[];
}

export class RoomCore {
  readonly windowSide: WindowSide;
  readonly room: RoomGeometry;
  readonly spp = samplesPerPixel();
  /** プリズムが回る角度の進み（ラジアン） */
  private prismPhase = 0;
  /** 風で揺れるときの揺れの進み（ラジアン。風が強いほど速く進む） */
  private prismWindPhase = 0;
  private wavePhase = 0;
  private orgPhase = 0;
  private blobPhase = 0;
  private shimPhase = 0;
  /** 窓の外の海の波のスペクトル（FFT の海。風速・向き・高さが変わったときだけ作り直す。version が変わったら GPU に送り直す） */
  ocean: { spectrum: OceanSpectrum; version: number; key: string } | null = null;
  /** 海面を作る時刻（秒、実際の時間） */
  oceanTime = 0;
  /** 水面の網目の細かさ（網目の大きさは、光の揺らぎの画像の画素の 2 倍程度。小さすぎると描き漏れが出る） */
  readonly poolGridSegs: [number, number];
  readonly seaGridSegs: [number, number] = [220, 220];

  /** 全段階で共通の値（シェーダーの uniform。WebGL2・WebGPU の両方がこのまま使う） */
  readonly shared;
  /** 空の光と照り返しの段階の値 */
  readonly trace = { uBlend: { value: 1 }, uFrame: { value: 0 }, uBounces: { value: 3 }, uSpp: { value: 2 } };
  /** 画面に出す段階の値 */
  readonly display = {
    uExposure: { value: 1 },
    uStride: { value: 2 },
    uSigmaP: { value: 0.2 },
    uViewProj: { value: new THREE.Matrix4() },
  };
  /** 光の揺らぎを使うか（段階 1・2） */
  readonly causOn = { value: 0 };
  /** 今使う面の画像（描き方の側が、key が変わったら GPU に送り直す） */
  textures: TextureSet = { key: '', ids: [], pixels: [] };

  private readonly facingAzimuth: number;
  private readonly winRect = new THREE.Vector4();
  private readonly win2Rect = new THREE.Vector4();
  private samples = 0;
  private frameNo = 0;
  private readonly lastCam = new THREE.Matrix4();
  private readonly lastProj = new THREE.Matrix4();
  private readonly refSun = new THREE.Vector3(0, -1, 0);
  private refKey = '';
  private refSpot = 0;
  private refMoon = 0;
  private refColor: number[] = [];
  /** 月明かりの今の点き具合（0〜1。状態表示に使う） */
  moonOn = 0;
  /** スポットライトの今の点き具合（0〜1。状態表示に使う） */
  spotOn = 0;
  /** 灯台の光の今の点き具合（0〜1）と、帯が部屋を向いている度合い（0〜1）。状態表示に使う */
  lighthouseOn = 0;
  lighthouseFacing = 0;
  /** 灯台の光の帯の向き（ラジアン。実際の時間で回す） */
  private lhAngle = 0;
  private readonly t0 = performance.now();
  private lastT = -1;
  // 雲の流れ（ノイズの座標で。足し続ける量は DriftBlend で巻き戻す）
  private readonly cloudDrift = new DriftBlend();
  private readonly cloudVel = new THREE.Vector3();

  constructor(windowSide: WindowSide, room: RoomGeometry, facingAzimuth: number) {
    this.windowSide = windowSide;
    this.room = room;
    this.facingAzimuth = facingAzimuth;
    const { widthM: W, depthM: D, heightM: H } = room;
    this.poolGridSegs = [256, Math.max(32, Math.round((256 * D) / W))];
    this.trace.uSpp.value = this.spp;

    // スクリーン（投影面、32:9）の目印。寸法は未計測なので、奥の壁に収まる大きさ
    const eyeY = Math.min(1.5, H * 0.5);
    const screenW = Math.min(W * 0.8, (H * 0.7 * 32) / 9);
    const screenH = (screenW * 9) / 32;
    const screenCy = Math.max(screenH / 2 + 0.2, eyeY);

    const phases = wavePhases(0);
    this.shared = {
      uRes: { value: new THREE.Vector2(1, 1) },
      uProjInv: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uRoomMin: { value: new THREE.Vector3(-W / 2, 0, -D) },
      uRoomMax: { value: new THREE.Vector3(W / 2, H, 0) },
      uWinFace: { value: WINDOW_FACE[windowSide] },
      uWinRect: { value: this.winRect },
      // 2 つ目の窓（天窓＋左の窓のときの天窓。天井いっぱい）
      uWin2On: { value: windowSide === 'ceiling-left' ? 1 : 0 },
      uWin2Rect: { value: this.win2Rect },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunSinR: { value: Math.sin((SUN_ANGULAR_RADIUS_DEG * Math.PI) / 180) },
      uSunE: { value: new THREE.Vector3() },
      uSkyTop: { value: new THREE.Vector3() },
      uSkyBottom: { value: new THREE.Vector3() },
      uViewSkyTop: { value: new THREE.Vector3() },    // 見える空（画面に出す段階だけ）
      uViewSkyBottom: { value: new THREE.Vector3() },
      uGround: { value: new THREE.Vector3() },
      uScreenRect: { value: new THREE.Vector4(-screenW / 2, screenW / 2, screenCy - screenH / 2, screenCy + screenH / 2) },
      uSeaOn: { value: 0 },
      uSeaY: { value: -1 },
      uSeaBody: { value: new THREE.Vector3() },
      uSeaHaze: { value: 600 },                                  // 海が空気でかすむ距離（m）
      uSeaHorizon: { value: 0 },                                 // 水平線：0 = 平らな海、1 = 地球の丸みと遠くの波の傾き
      uSeaLook: { value: new THREE.Vector2(0.004, 0.6) },        // 海面の細かい粗さ・波の山が透ける強さ
      uPixAngle: { value: 1e-3 },                                // 1 画素が見込む角度（ラジアン。遠くの細かい波を消すのに使う）
      uSeaGlintDir: { value: new THREE.Vector3(0, 1, 0) },        // 海に映すきらめきの光の向き（昼は太陽、夜は海に映す月）
      uSeaGlintE: { value: new THREE.Vector3() },                 // その光の強さ
      uMoonDisk: { value: new THREE.Vector3() },                  // 窓から見える月：描くか・見かけの半径の sin・満ち欠けの形を描くか
      uMoonDiskL: { value: new THREE.Vector3() },                 // 月の円盤の明るさ
      uMoonSunDir: { value: new THREE.Vector3(0, -1, 0) },        // 太陽のある方向（満ち欠けの形）
      uGlassMask: { value: 0 },                                  // ガラスの壁の面（ビット）
      uOpenMask: { value: 0 },                                   // 1 つ目・2 つ目の窓のほかに、壁いっぱいの窓にする面（ビット）
      // ガラスの仕様（面の番号ごと。0 = 右、1 = 左、2 = 天井、4 = 手前、5 = 奥）
      uGlassWaveA: { value: Array.from({ length: 6 }, () => new THREE.Vector3()) },  // 表面の形・模様の大きさ（m）・深さ（m）
      uGlassWaveB: { value: Array.from({ length: 6 }, () => new THREE.Vector3()) },  // 虹の強さ・光が集まり切る距離 ×（n−1）の上限
      uGlassTintF: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0.99, 0.995, 0.99)) }, // 真正面で通る光の割合（色ごと）
      uSeaSplit: { value: 0 },                                   // 1 = 海の手前側（窓の奥行きの真ん中より手前）は正弦波の海（比べるとき）
      uOceanOn: { value: 0 },                                    // 1 = 海の波を FFT の画像から読む（WebGPU のときだけ使う）
      uOceanSize: { value: new THREE.Vector2(OCEAN_CASCADES[0].sizeM, OCEAN_CASCADES[1].sizeM) },
      uOceanRms: { value: 0.1 },                                 // 海面の高さの標準偏差（m）
      uOceanMss: { value: new Float32Array(OCEAN_CASCADES.length * OCEAN_LODS) }, // 画像の段ごとの、描ききれない波の傾きの 2 乗平均
      uPoolOn: { value: 0 },
      uPoolSea: { value: 0 },                                    // 水盤と海のつなぎ方：0 = つながない、1 = ガラスで仕切る、2 = 壁の下が開いている
      uPoolSeaMask: { value: 0 },                                // 水盤が海とつながる面（ビット）
      uPoolSeaReach: { value: 2 },                               // 海の波が部屋に入る距離（m）
      uPoolDepth: { value: 0.3 },
      uWaveAmp: { value: 1 },
      uPOOLPh: { value: phases.pool },
      uSEAPh: { value: phases.sea },
      uFINEPh: { value: phases.fine },
      uCloudOn: { value: 0 },
      uCloudShadow: { value: 0 },
      uCloudY: { value: 1500 },
      uCloudScale: { value: 1 / 800 },
      uCloudAmount: { value: 0.45 },
      uCloudContrast: { value: CLOUD_CONTRAST },
      uCloudOpacity: { value: 0.8 },
      uCloudOffA: { value: new THREE.Vector3() },
      uCloudOffB: { value: new THREE.Vector3() },
      uCloudBlend: { value: 0 },
      uPrismOn: { value: 0 },
      uPrismPattern: { value: 1 },
      uPrismPhase: { value: 0 },
      uStreakAmount: { value: 0.8 },
      uStreakLen: { value: 1.2 },
      uStreakAngle: { value: 0 },
      uPanelRidge: { value: 0 },
      uPrismCount: { value: 0 },
      uPrismPos: { value: Array.from({ length: MAX_PRISMS }, () => new THREE.Vector3()) },
      uPrismAxis: { value: Array.from({ length: MAX_PRISMS }, () => new THREE.Vector3(1, 0, 0)) },
      uPrismStrength: { value: 1 },
      uPrismSize: { value: 0.08 },
      uPrismDev: { value: 0.5 },
      uPrismDisp: { value: 0.1 },
      uPrismVivid: { value: 1 },
      uPrismFacets: { value: 3 },
      uPrismCaus: { value: 0 },
      uBeamBlur: { value: 0.02 },
      uPrismFadeM: { value: 0.3 },
      // E・F・G の縁の見え方：Edge = (色の帯の幅, ぼかしの幅, 外へ広がる光の明るさ, 外へ広がる幅)、Look = (色の濃さ, 外へ広がる光の色合い)
      uWaveOn: { value: 0 },
      uWaveEdge: { value: new THREE.Vector4(0.15, 0.04, 0.3, 0.5) },
      uWaveLook: { value: new THREE.Vector2(1, 0.6) },
      uWaveShape: { value: new THREE.Vector3(0.12, 1.2, 0) },   // 縁が揺れる大きさ（m）・波の長さ（m）・波の進み（ラジアン）
      uOrgOn: { value: 0 },
      uOrgEdge: { value: new THREE.Vector4(0.08, 0.02, 0.25, 0.3) },
      uOrgLook: { value: new THREE.Vector2(1, 0.8) },
      uOrgShape: { value: new THREE.Vector4(0.06, 0.25, 0, 0.2) }, // 縁が揺れる大きさ（m）・模様の大きさ（m）・形の変化の進み・内側の淡い色
      uBlobCount: { value: 0 },
      uBlobPos: { value: Array.from({ length: MAX_BLOBS }, () => new THREE.Vector3()) },
      uBlobAxis: { value: Array.from({ length: MAX_BLOBS }, () => new THREE.Vector3(1, 0, 0)) },
      uBlobEdge: { value: new THREE.Vector4(0.3, 0.08, 0.4, 0.6) },
      uBlobLook: { value: new THREE.Vector2(1, 1) },
      uBlobShape: { value: new THREE.Vector4(0.35, 0, 0.5, 0) },    // 形の崩れ方・形の変化の進み・内側の淡い色・（使わない）
      uBlobBeam: { value: new THREE.Vector4(0.15, 0.12, 0.2, 1) },  // 半径（m、窓の所）・大きくなる割合・曲がる角度（ラジアン）・明るさ
      uShimOn: { value: 0 },                                       // H：重ねる強さ（0 = 出さない）
      uShimShape: { value: new THREE.Vector4(0.35, 0.06, 0.6, 0) }, // 網目の大きさ（m）・線の太さ・ゆがみ・形の変化の進み
      uShimLook: { value: new THREE.Vector4(0.6, 2, 0.04, 0.6) },   // 線のない所の明るさ・線の明るさ・虹のずれ・膜の虹色の濃さ
      uShimColor: { value: new THREE.Vector4(3, 0, 1, 1) },         // 色の数・虹の色の範囲の始め・終わり・色の濃さ
      uShimSurface: { value: 0 },                                  // 1 = 網目を面そのものに置く（大きさが変わらない）
      uShimPalN: { value: 0 },                                     // 選んだ色の数（0 = 虹の色の範囲を使う）
      uShimPal: { value: Array.from({ length: MAX_SHIM_PALETTE }, () => new THREE.Vector3(1, 1, 1)) },
      uShimLineCol: { value: new THREE.Vector3(1, 1, 1) },
      uShimBaseCol: { value: new THREE.Vector3(1, 1, 1) },
      uScreenArea: { value: 0 },
      uScreenOn: { value: 0 },
      uScreenGain: { value: 0.6 },
      uScreenOut: { value: new THREE.Vector2(0, 1) },
      uSpotCount: { value: 0 },
      uSpotPos: { value: Array.from({ length: MAX_SPOTS }, () => new THREE.Vector3()) },
      uSpotDir: { value: Array.from({ length: MAX_SPOTS }, () => new THREE.Vector3(0, -1, 0)) },
      uSpotI: { value: Array.from({ length: MAX_SPOTS }, () => new THREE.Vector3()) },
      uSpotCos: { value: Array.from({ length: MAX_SPOTS }, () => new THREE.Vector2(0.8, 0.9)) },
      uSpotR: { value: SPOT_RADIUS },
      uSpotLampOn: { value: 0 },
      uAmbL: { value: new THREE.Vector3() },
      uAmbRect: { value: new THREE.Vector4() },
      // 灯台の光（夜）。帯は水平で、上から見て時計回りに回る
      uLhOn: { value: 0 },                                          // 点き具合（0 = 消えている）
      uLhPos: { value: new THREE.Vector3(0, 30, -2000) },           // 灯火の位置
      uLhAxis: { value: new THREE.Vector4(0, 1, 0.05, 0.03) },      // 帯の向き（ラジアン）・帯の本数・広がりの半分の tan・明るさの広がり（ガウスの幅、ラジアン）
      uLhI: { value: new THREE.Vector3() },                         // 光度（色 × 強さ × 点き具合。距離² で割ると放射照度）
      uLhLook: { value: new THREE.Vector4(0, 0, LIGHTHOUSE_VIS, 0) }, // 空気の散乱の強さ・灯火のにじみ・もやで見える距離
      // 読み込んだ部屋の形（STEP）の面。面の数が 0 なら四角い部屋（src/room/step.ts）
      uPrimCount: { value: 0 },
      uPrimO: { value: Array.from({ length: MAX_ROOM_PRIMS }, () => new THREE.Vector3()) },    // 面の角
      uPrimU: { value: Array.from({ length: MAX_ROOM_PRIMS }, () => new THREE.Vector3()) },    // 面の 2 辺
      uPrimV: { value: Array.from({ length: MAX_ROOM_PRIMS }, () => new THREE.Vector3()) },
      uPrimInfo: { value: Array.from({ length: MAX_ROOM_PRIMS }, () => new THREE.Vector3()) }, // 面の番号（0〜5 = 外枠の面、8〜13 = 部屋の中の物）・1 なら三角形・1 なら軸にそった長方形（O・U が両端の角）
      uPrimBoxMin: { value: new THREE.Vector3() },  // 面をまとめて囲む直方体（光線がここを通らなければ、面を 1 枚ずつ確かめない）
      uPrimBoxMax: { value: new THREE.Vector3() },
      // 面に貼る画像（面のまとまりごと：0〜5 = 面の向き（右・左・天井・床・手前・奥）、6 = 部屋の中の物）
      uTexOn: { value: 0 },                                                          // 1 = どこかの面に画像を貼っている
      uTexA: { value: Array.from({ length: TEX_SURFACES.length }, () => new THREE.Vector3(-1, 1, 1)) }, // 画像の束の何枚目か（−1 = 貼らない）・1 / 画像の幅（m）・1 / 画像の高さ（m）
      uTexB: { value: Array.from({ length: TEX_SURFACES.length }, () => new THREE.Vector3(1, 0, 0)) },  // 明るさの倍率
    };
  }

  /** 部屋の形（STEP から読んだ面の一覧）を使う。null なら四角い部屋 */
  setMesh(mesh: RoomMesh | null): void {
    const s = this.shared;
    // 外枠の平面にぴったり重なる外枠の面は、四角い部屋の計算（外枠の直方体）と同じ結果になるので、シェーダーには渡さない（軽くするため）
    const lo = s.uRoomMin.value, hi = s.uRoomMax.value;
    const planes = [hi.x, lo.x, hi.y, lo.y, hi.z, lo.z];
    const onBox = (p: RoomPrim): boolean => {
      if (p.face >= 8) return false;
      const k = p.face >> 1;
      const c = [p.o, add3(p.o, p.u), add3(p.o, p.v)];
      return c.every((q) => Math.abs(q[k]! - planes[p.face]!) < 1e-6);
    };
    const prims = (mesh?.prims ?? []).filter((p) => !onBox(p)).slice(0, MAX_ROOM_PRIMS);
    s.uPrimCount.value = prims.length;
    const bmin = new THREE.Vector3(Infinity, Infinity, Infinity), bmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of prims) {
      for (const q of [p.o, add3(p.o, p.u), add3(p.o, p.v), add3(p.o, add3(p.u, p.v))]) {
        bmin.min(new THREE.Vector3(...q));
        bmax.max(new THREE.Vector3(...q));
      }
    }
    s.uPrimBoxMin.value.copy(bmin.subScalar(1e-3));
    s.uPrimBoxMax.value.copy(bmax.addScalar(1e-3));
    // 軸にそった長方形は、厚さ 0 の直方体（両端の角）として渡す（シェーダーで軽く確かめられる）。それ以外は角と 2 辺
    const aligned = (v: Vec3): boolean => v.filter((c) => Math.abs(c) > 1e-9).length === 1;
    prims.forEach((p, i) => {
      if (!p.tri && aligned(p.u) && aligned(p.v)) {
        const a = new THREE.Vector3(...p.o), b = new THREE.Vector3(...add3(p.o, add3(p.u, p.v)));
        s.uPrimO.value[i]!.copy(a).min(b).subScalar(1e-6);
        s.uPrimU.value[i]!.copy(a).max(b).addScalar(1e-6);
        s.uPrimInfo.value[i]!.set(p.face, 0, 1);
        return;
      }
      s.uPrimO.value[i]!.set(...p.o);
      s.uPrimU.value[i]!.set(...p.u);
      s.uPrimV.value[i]!.set(...p.v);
      s.uPrimInfo.value[i]!.set(p.face, p.tri ? 1 : 0, 0);
    });
  }

  /** 描く大きさが変わったとき */
  /**
   * 窓に吊るプリズムの位置と向き（プリズムの稜の向き）を決める。位置はプリズムごとの決まった乱数で、窓の幅に沿って並べる。
   * 壁の窓は、窓の上の端から dropM くらい下（窓の下端より上）で、窓から 12cm 内側。天窓は、天窓の範囲に格子に並べ、天井から dropM くらい下。
   * 天窓＋左の窓は、左の壁の窓に吊る。稜は縦から斜めに傾いていて、吊り糸のまわりにゆっくり回る（傾き・向き・速さはプリズムごとに違う）
   */
  /**
   * プリズム i の向きの、動きによる変わり分（ラジアン）。spin は一方向に回り続ける。sway は左右にねじれては戻る（周期はプリズムごとに 0.6〜1.4 倍）。
   * wind は sway と同じ揺れを、風速（雲を流す風）に合わせて大きく・速くし、ときどき強まる揺れ（突風）を重ねる。still は動かない
   */
  private prismMotion(i: number, motion: PrismMotion, swayDeg: number, windMS: number): number {
    const rnd = (k: number): number => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    const k = 0.6 + 0.8 * rnd(5);
    const ph = 6.2832 * rnd(8);
    const amp = swayDeg * Math.PI / 180;
    switch (motion) {
      case 'spin': return (rnd(4) < 0.5 ? -1 : 1) * this.prismPhase * k;
      case 'sway': return amp * Math.sin(this.prismPhase * 3 * k + ph);
      case 'wind': {
        const w = Math.min(1.5, 0.15 + windMS / 6);
        const t = this.prismWindPhase * 3 * k;
        return amp * w * (Math.sin(t + ph) * 0.8 + Math.sin(t * 2.3 + ph * 1.7) * 0.35 * Math.max(0, Math.sin(t * 0.21 + ph)));
      }
      case 'still': return 0;
    }
  }

  private placePrisms(n: number, dropM: number, side: WindowSide, turn: (i: number) => number): void {
    const s = this.shared;
    const { widthM: W, heightM: H } = this.room;
    const rnd = (i: number, k: number): number => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    const r = this.winRect;
    const face = WINDOW_FACE[side];
    const cols = Math.ceil(Math.sqrt(Math.max(1, n)));
    for (let i = 0; i < n; i++) {
      const drop = Math.max(0, dropM) * (0.6 + 0.8 * rnd(i, 2));
      const pos = s.uPrismPos.value[i]!;
      if (face === 2) {
        // 天窓：r = (x0, x1, z0, z1)
        const col = i % cols, row = Math.floor(i / cols), rows = Math.ceil(n / cols);
        pos.set(
          r.x + (r.y - r.x) * (col + 0.5 + (rnd(i, 1) - 0.5) * 0.5) / cols,
          Math.max(0.3, H - 0.05 - drop),
          r.z + (r.w - r.z) * (row + 0.5 + (rnd(i, 6) - 0.5) * 0.5) / rows,
        );
      } else {
        // 壁の窓：r = (z0, z1, y0, y1)。右の窓は x = W/2、左の窓は x = -W/2
        const u = (i + 0.5 + (rnd(i, 1) - 0.5) * 0.6) / n;
        pos.set(face === 0 ? W / 2 - 0.12 : -W / 2 + 0.12, Math.max(r.z + 0.1, Math.min(H - 0.05, r.w) - drop), r.x + (r.y - r.x) * u);
      }
      // 稜の向き：縦から 30〜75° 傾け（プリズムごとに違う）、吊り糸（縦）のまわりに回す
      const a = rnd(i, 3) * Math.PI * 2 + turn(i);
      const tilt = (30 + 45 * rnd(i, 7)) * Math.PI / 180;
      s.uPrismAxis.value[i]!.set(Math.sin(tilt) * Math.cos(a), Math.cos(tilt), Math.sin(tilt) * Math.sin(a));
    }
  }

  /**
   * D：窓ガラスに付けた小さなプリズム（光の束の出る所）の位置と稜の向きを決める。位置はプリズムごとの決まった乱数で窓の中に散らす（ガラスから 2cm 内側）。
   * 天窓＋左の窓は、偶数番を天窓・奇数番を左の窓に付ける。稜はガラスの面の中の向き（壁の窓は縦、天窓は奥行きの向きを 0°）を ridge だけ回し、
   * プリズムごとに ±20° ばらつかせて、動きの分 turn を足す
   */
  private placeBeams(n: number, ridge: number, side: WindowSide, turn: (i: number) => number): void {
    const s = this.shared;
    const { widthM: W, heightM: H } = this.room;
    const rnd = (i: number, k: number): number => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    for (let i = 0; i < n; i++) {
      const sky = side === 'ceiling' || (side === 'ceiling-left' && i % 2 === 0);
      const r = sky && side === 'ceiling-left' ? this.win2Rect : this.winRect;
      const u = 0.08 + 0.84 * rnd(i, 1), v = 0.08 + 0.84 * rnd(i, 6);
      const pos = s.uPrismPos.value[i]!;
      const a = ridge + (rnd(i, 3) - 0.5) * 0.7 + turn(i);
      if (sky) {
        // 天窓：r = (x0, x1, z0, z1)。稜は 0° で奥行き（z）の向き
        pos.set(r.x + (r.y - r.x) * u, H - 0.02, r.z + (r.w - r.z) * v);
        s.uPrismAxis.value[i]!.set(Math.sin(a), 0, Math.cos(a));
      } else {
        // 壁の窓：r = (z0, z1, y0, y1)。稜は 0° で縦
        pos.set(wallWindowSide(side) === 'right' ? W / 2 - 0.02 : -W / 2 + 0.02, r.z + (r.w - r.z) * v, r.x + (r.y - r.x) * u);
        s.uPrismAxis.value[i]!.set(0, Math.cos(a), Math.sin(a));
      }
    }
  }

  /**
   * G：光のしみを作る見えない物の位置と向き。位置は窓の中に散らす（ガラスから 2cm 内側。天窓＋左の窓は、偶数番を天窓・奇数番を左の窓）。
   * 向きは物ごとの決まった乱数で、形の変化に合わせてゆっくり振れる（しみがゆっくり動く）
   */
  /**
   * 見ている所から壁の窓の真ん中を見た水平の向き（天窓＋左は左の窓）を、奥（−z）の側へ offsetDeg だけ回し、高度 altDeg に置いた月の向き。
   * 窓から海を見たとき、月の光の道が窓の真ん中に見える
   */
  private lowMoonDir(camera: THREE.PerspectiveCamera, altDeg: number, offsetDeg: number): THREE.Vector3 {
    const s = this.shared;
    const r = this.winRect;
    const right = this.windowSide === 'right';
    let hx = (right ? s.uRoomMax.value.x : s.uRoomMin.value.x) - camera.position.x;
    let hz = 0.5 * (r.x + r.y) - camera.position.z;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl;
    hz /= hl;
    const turn = ((right ? -1 : 1) * offsetDeg * Math.PI) / 180;
    const cx = hx * Math.cos(turn) - hz * Math.sin(turn);
    const cz = hx * Math.sin(turn) + hz * Math.cos(turn);
    const alt = (Math.max(1, altDeg) * Math.PI) / 180;
    return new THREE.Vector3(cx * Math.cos(alt), Math.sin(alt), cz * Math.cos(alt)).normalize();
  }

  private placeBlobs(n: number, side: WindowSide): void {
    const s = this.shared;
    const { widthM: W, heightM: H } = this.room;
    const rnd = (i: number, k: number): number => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    for (let i = 0; i < n; i++) {
      const sky = side === 'ceiling' || (side === 'ceiling-left' && i % 2 === 0);
      const r = sky && side === 'ceiling-left' ? this.win2Rect : this.winRect;
      const u = 0.12 + 0.76 * rnd(i, 11), v = 0.12 + 0.76 * rnd(i, 16);
      const a = rnd(i, 13) * Math.PI * 2 + 0.4 * Math.sin(this.blobPhase * 0.5 + i * 1.7);
      const pos = s.uBlobPos.value[i]!;
      if (sky) {
        pos.set(r.x + (r.y - r.x) * u, H - 0.02, r.z + (r.w - r.z) * v);
        s.uBlobAxis.value[i]!.set(Math.sin(a), 0, Math.cos(a));
      } else {
        pos.set(wallWindowSide(side) === 'right' ? W / 2 - 0.02 : -W / 2 + 0.02, r.z + (r.w - r.z) * v, r.x + (r.y - r.x) * u);
        s.uBlobAxis.value[i]!.set(0, Math.cos(a), Math.sin(a));
      }
    }
  }

  resize(w: number, h: number): void {
    this.shared.uRes.value.set(w, h);
    this.samples = 0;
  }

  /** 1 画素あたり、これまでに追った光線の本数 */
  get raysPerPixel(): number {
    return this.samples * this.spp;
  }

  /** 1 フレームぶんの値を決める。camera は描く直前の状態（matrixWorld を更新済み） */
  frame(input: RoomInput, settings: RoomRenderSettings, camera: THREE.PerspectiveCamera): RoomFrame {
    const s = this.shared;
    const { light, sun } = input.solar;
    const windowSide = this.windowSide;

    // 太陽のある方向（光が進む向きの逆）と、大気を通った直射日光の強さ。
    // 太陽が沈んだあと月明かりがオンなら、太陽の代わりに月の向きと強さを入れる（あとの計算は太陽と同じ）
    const moon = settings.moon;
    const moonW = moonWeight(moon, sun.altitude);
    const sunUp = sun.altitude > 0;
    // 本物の月：位置は日時と緯度経度から（input.moon）。real は満ち欠けで明るさを変える（半月で満月の約 1/10、新月でほぼ 0）。
    // realFull はいつも満月の明るさで、月が地平線の下にある間は、決めた方位・高度の月で同じ明るさの光を入れる（夜はいつも同じ明るさ）
    // realSky は月の光は real と同じで、夜空だけ skyCurve の割合。「満ち欠けを試す」では、位相角（と月が出ていない）を日時によらず決める
    // （試している間、本物の月が地平線の下なら、決めた方位・高度の月で照らす）
    const sky = moon.mode === 'realSky' || moon.mode === 'realFloor';
    const preview = sky && moon.phasePreview !== 'real' ? moon.phasePreview : null;
    const realPos = (moon.mode === 'real' || moon.mode === 'realFull' || sky) && input.moon ? input.moon : null;
    const fallback = !!realPos && realPos.altitude <= 0 && (moon.mode === 'realFull' || (preview !== null && preview !== 'none'));
    const real = realPos && !fallback ? realPos : null;
    const moonUp = preview === 'none' ? false : preview !== null ? true : (real?.altitude ?? 0) > 0;
    const moonAlt = preview === 'none' ? -1 : real ? real.altitude : moon.altitudeDeg;
    const phaseAngle = preview !== null && preview !== 'none' ? Number(preview) : (realPos?.phaseAngle ?? 0);
    const phaseK = moon.mode === 'real' && real ? real.brightness
      : moon.mode === 'realFloor' && realPos ? moonLightCurve(moon.lightCurve, phaseAngle, moonUp)
      : sky && realPos ? moonPhaseBrightness(phaseAngle) : 1;
    const useMoon = !sunUp && moonW > 0 && moonAlt > 0;
    const moonCol = linear(hexToRgb(moon.color));
    const moonLum = 0.2126 * moonCol.x + 0.7152 * moonCol.y + 0.0722 * moonCol.z;
    if (moonLum > 1e-4) moonCol.multiplyScalar(1 / moonLum);
    // 窓の真ん中の向きの低い月（A と、前の作り方の海）。天窓だけのときは使えない
    const lowMoon = windowSide !== 'ceiling' ? this.lowMoonDir(camera, moon.seaRoadAltDeg, moon.seaRoadOffsetDeg) : null;
    const sunDir = useMoon
      ? (moon.mode === 'low' && lowMoon
        ? lowMoon.clone()
        : moonDirection(real ? { ...moon, azimuthDeg: real.azimuth, altitudeDeg: real.altitude } : moon, this.facingAzimuth))
      : toThree(light).negate().normalize();
    const sunOn = sunUp || useMoon;
    const sunE = sunUp
      ? linear(input.lightColor).multiplyScalar(SUN_SCALE * directSunFactor(sun.altitude))
      : moonCol.clone().multiplyScalar(useMoon ? MOON_SCALE * moon.strength * moonW * phaseK : 0);
    const skyL = SKY_SCALE * skyBrightness(sun.altitude);
    // 夜空：月明かりの点き具合に応じて、月の色の空の光を足す（上ほど明るく、地平線の近くは少し暗い）
    // 本物の月のときは、夜空の明るさも月の明るさに合わせる（月が出ていない・新月の夜でも、真っ暗にはせず 15% は残す）
    const skyK = sky && realPos ? moonSkyCurve(moon.skyCurve, phaseAngle, moonUp)
      : real && moon.mode === 'real' ? Math.max(0.15, moonAlt > 0 ? phaseK : 0) : 1;
    const nightSky = moonCol.clone().multiplyScalar(MOON_SKY_SCALE * moon.skyStrength * moonW * skyK);
    const top = linear(input.sky.top).multiplyScalar(skyL).add(nightSky);
    const bottom = linear(input.sky.bottom).multiplyScalar(skyL).addScaledVector(nightSky, 0.7);
    this.moonOn = useMoon ? moonW : 0;
    // 窓から見える月の円盤：本物の見かけの大きさ（月までの距離から。決めた月のときは平均の 0.259°）× 倍率。
    // 本物の月のときは、太陽の向き（夜は地平線の下）から満ち欠けの形を決める。明るさは、露出をかけた後に白く飛ばず、
    // 表面の模様が見える値（本物どおりの明るさ（月の光 ÷ 円盤の大きさ）は数千倍明るく、真っ白になる）。色は月明かりの色を少しだけ
    const moonR = Math.asin(Math.min(0.02, 1737.4 / (real?.distanceKm ?? 384400))) * Math.max(0, moon.diskScale);
    s.uMoonDisk.value.set(useMoon && moonR > 0 ? 1 : 0, Math.sin(Math.max(moonR, 1e-5)), real ? 1 : 0);
    s.uMoonDiskL.value.set(1, 1, 1).lerp(moonCol, 0.25).multiplyScalar((MOON_DISK_EXPOSED / (0.25 * Math.max(0.05, settings.exposure))) * moonW);
    s.uMoonSunDir.value.copy(moonDirection({ ...moon, azimuthDeg: sun.azimuth, altitudeDeg: sun.altitude }, this.facingAzimuth));
    // 窓の外の地面：日差しと空の光を受けて、反射率ぶんだけ明るい
    const horizSun = sunE.clone().multiplyScalar(Math.max(0, Math.sin((sun.altitude * Math.PI) / 180)));
    const ground = horizSun.add(top.clone().add(bottom).multiplyScalar(0.5 * Math.PI)).multiplyScalar(GROUND_ALBEDO / Math.PI);

    if (windowSide === 'ceiling-left') {
      // 天井＋左：左の窓は左の壁いっぱい（奥行き全部・床から天井まで、枠なし）、天井の窓はパネルの窓の大きさ（天井いっぱいか天窓）
      const { depthM: D, heightM: H } = this.room;
      this.winRect.set(-D, 0, 0, H);
      this.win2Rect.fromArray(windowRect('ceiling', this.room, settings.window));
    } else {
      this.winRect.fromArray(windowRect(windowSide, this.room, settings.window));
    }
    const now = (performance.now() - this.t0) / 1000;
    const dt = this.lastT < 0 ? 0 : Math.min(0.25, now - this.lastT);
    this.lastT = now;

    // 雲：風が吹いてくる方位から、部屋の向き（右 = +x、スクリーン = -z）での流れる向きに直す。雲は風下へ流れる
    const cloudsOn = settings.clouds;
    const flow = cloudFlowDir(settings.windFromDeg, this.facingAzimuth);
    const scale = 1 / Math.max(10, settings.cloudSizeM);
    // ノイズを読む位置をずらすと、模様はその逆へ動いて見える。流れは「m/s × 1/大きさ」、形の変化は大きさに関係なく少しずつ
    this.cloudVel.set(-flow.x * settings.windMS * scale, -flow.z * settings.windMS * scale, 0.02);
    this.cloudDrift.step(this.cloudVel, dt);

    // プリズム：画面に出す段階で毎フレーム足す光なので、値を変えても重ね合わせはやり直さない
    const pz = settings.prism;
    const deg = Math.PI / 180;
    this.prismPhase = (this.prismPhase + dt * pz.speed) % (Math.PI * 2000);
    this.prismWindPhase = (this.prismWindPhase + dt * pz.speed * (0.3 + settings.windMS / 4)) % (Math.PI * 2000);
    const turn = (i: number): number => this.prismMotion(i, pz.motion, pz.swayDeg, settings.windMS);
    s.uPrismOn.value = pz.on ? 1 : 0;
    s.uPrismPattern.value = PRISM_PATTERNS.indexOf(pz.pattern);
    s.uPrismPhase.value = this.prismPhase;
    s.uPrismVivid.value = Math.min(1, Math.max(0, pz.vividness));
    // A：日だまりの中の虹色の筋
    const st = pz.streaks;
    if (pz.pattern === 'streaks') s.uPrismStrength.value = st.strength;
    s.uStreakAmount.value = st.amount;
    s.uStreakLen.value = Math.max(0.05, st.lengthM);
    s.uStreakAngle.value = st.angleDeg * deg;
    // B：窓に吊るプリズム
    const hg = pz.hung;
    const np = pz.on && pz.pattern === 'hung' ? Math.min(MAX_PRISMS, Math.max(1, Math.round(hg.count))) : 0;
    if (pz.pattern !== 'beams') {
      this.placePrisms(np, hg.dropM, windowSide, turn);
      s.uPrismCount.value = np;
      s.uPrismSize.value = Math.max(0.01, hg.sizeM);
    }
    s.uPrismFacets.value = Math.min(4, Math.max(1, Math.round(hg.facets)));
    if (pz.pattern === 'hung') {
      s.uPrismStrength.value = hg.strength;
      s.uPrismDev.value = hg.deviationDeg * deg;
      s.uPrismDisp.value = Math.max(0.1, hg.dispersionDeg) * deg;
    }
    // C：窓を覆うプリズムの板
    const pn = pz.panel;
    s.uPanelRidge.value = pn.ridgeAngleDeg * deg;
    if (pz.pattern === 'panel') {
      s.uPrismStrength.value = pn.strength;
      s.uPrismDev.value = pn.deviationDeg * deg;
      s.uPrismDisp.value = Math.max(0.1, pn.dispersionDeg) * deg;
    }
    // D：日差しの先の虹の筋（窓ガラスのプリズムから出る細い光の束）
    const bm = pz.beams;
    if (pz.pattern === 'beams') {
      const nb = pz.on ? Math.min(MAX_PRISMS, Math.max(1, Math.round(bm.count))) : 0;
      this.placeBeams(nb, bm.ridgeAngleDeg * deg, windowSide, turn);
      s.uPrismCount.value = nb;
      s.uPrismSize.value = Math.max(0.01, bm.widthM);
      s.uBeamBlur.value = Math.max(0, bm.blur);
      s.uPrismStrength.value = bm.strength;
      s.uPrismDev.value = bm.deviationDeg * deg;
      s.uPrismDisp.value = Math.max(0.1, bm.dispersionDeg) * deg;
    }
    s.uPrismCaus.value = pz.on ? Math.max(0, pz.causticSpreadM) : 0;
    const look = (o: OrganicLook, edge: THREE.Vector4, lk: THREE.Vector2): void => {
      edge.set(o.fringe, Math.max(1e-3, o.soft), Math.max(0, o.halo), Math.max(1e-3, o.haloWidth));
      lk.set(Math.max(0, o.saturation), Math.min(1, Math.max(0, o.haloHue)));
    };
    // E：波のプリズム（水盤の日だまりの縁が、進む波で揺れて虹色になる）
    const wv = pz.waves;
    const waveLen = Math.max(0.05, wv.waveLengthM);
    this.wavePhase = (this.wavePhase + dt * wv.speed * 2 * Math.PI / waveLen) % (Math.PI * 2000);
    s.uWaveOn.value = pz.on && wv.on ? 1 : 0;
    look(wv, s.uWaveEdge.value, s.uWaveLook.value);
    s.uWaveShape.value.set(Math.max(0, wv.wobbleM), waveLen, this.wavePhase);
    // F：有機的な日だまりの縁
    const og = pz.organic;
    this.orgPhase = (this.orgPhase + dt * og.speed) % (Math.PI * 2000);
    s.uOrgOn.value = pz.on && og.on ? 1 : 0;
    look(og, s.uOrgEdge.value, s.uOrgLook.value);
    s.uOrgShape.value.set(Math.max(0, og.wobbleM), Math.max(0.02, og.scaleM), this.orgPhase, Math.min(1, Math.max(0, og.pastel)));
    // G：虹のしみ
    const bl = pz.blobs;
    this.blobPhase = (this.blobPhase + dt * bl.speed) % (Math.PI * 2000);
    const nBlob = pz.on && bl.on ? Math.min(MAX_BLOBS, Math.max(1, Math.round(bl.count))) : 0;
    this.placeBlobs(nBlob, windowSide);
    s.uBlobCount.value = nBlob;
    look(bl, s.uBlobEdge.value, s.uBlobLook.value);
    s.uBlobShape.value.set(Math.max(0, bl.wobble), this.blobPhase, Math.min(1, Math.max(0, bl.pastel)), 0);
    s.uBlobBeam.value.set(Math.max(0.01, 0.5 * bl.sizeM), Math.max(0, bl.grow), bl.deviationDeg * deg, Math.max(0, bl.strength));
    // H：水のきらめき
    const sh = pz.shimmer;
    this.shimPhase = (this.shimPhase + dt * sh.speed) % (Math.PI * 2000);
    s.uShimOn.value = pz.on && sh.on ? Math.min(1, Math.max(0, sh.amount)) : 0;
    s.uShimShape.value.set(Math.max(0.02, sh.scaleM), Math.max(0.005, sh.lineWidth), Math.max(0, sh.warp), this.shimPhase);
    s.uShimLook.value.set(Math.max(0, sh.base), Math.max(0, sh.gain), sh.dispersion, Math.min(1, Math.max(0, sh.iridescence)));
    s.uShimSurface.value = sh.anchor === 'surface' ? 1 : 0;
    s.uShimColor.value.set(Math.min(MAX_SHIM_COLORS, Math.max(3, Math.round(sh.colorCount))), sh.hueStart, sh.hueEnd, Math.max(0, sh.saturation));
    const nPal = Math.min(MAX_SHIM_PALETTE, Math.max(2, Math.round(sh.paletteCount)));
    s.uShimPalN.value = sh.colorMode === 'palette' ? nPal : 0;
    for (let i = 0; i < MAX_SHIM_PALETTE; i++) s.uShimPal.value[i]!.copy(linear(hexToRgb(sh.palette[i] ?? '#ffffff')));
    s.uShimLineCol.value.copy(unitLum(linear(hexToRgb(sh.lineColor))));
    s.uShimBaseCol.value.copy(unitLum(linear(hexToRgb(sh.baseColor))));
    s.uPrismFadeM.value = PRISM_EDGE_FADE_M;
    s.uCloudOn.value = cloudsOn ? 1 : 0;
    s.uCloudShadow.value = cloudsOn && settings.cloudShadow ? 1 : 0;
    s.uCloudY.value = settings.cloudHeightM;
    s.uCloudScale.value = scale;
    s.uCloudAmount.value = settings.cloudAmount;
    s.uCloudOpacity.value = settings.cloudOpacity;
    s.uCloudOffA.value.copy(this.cloudDrift.a);
    s.uCloudOffB.value.copy(this.cloudDrift.b);
    s.uCloudBlend.value = this.cloudDrift.blend;

    // スクリーンの映像
    const screen = settings.screen && input.screen ? input.screen : null;
    s.uScreenArea.value = settings.screenArea || screen ? 1 : 0;
    s.uScreenOn.value = screen ? 1 : 0;
    s.uScreenGain.value = settings.screenGain;
    if (screen) s.uScreenOut.value.set(screen.outMin, screen.outMax);

    // スポットライト：点き具合は太陽の高度で決まる（自動のとき）。点いているライトを配列の先頭から詰める
    const sp = settings.spot;
    const spotW = spotWeight(sp, sun.altitude);
    let n = 0;
    const ambient = sp.kind === 'ambient';
    if (spotW > 0 && !ambient) {
      for (const light of sp.lights.slice(0, Math.min(MAX_SPOTS, Math.max(0, Math.round(sp.count))))) {
        if (light.strength <= 0) continue;
        const pose = spotPose(light, this.room);
        const half = (Math.min(170, Math.max(1, light.beamDeg)) * Math.PI) / 360;
        const inner = half * (1 - Math.min(1, Math.max(0, light.softness)));
        s.uSpotPos.value[n]!.copy(pose.pos);
        s.uSpotDir.value[n]!.copy(pose.dir);
        s.uSpotI.value[n]!.copy(spotColor(light)).multiplyScalar(SPOT_SCALE * light.strength * spotW);
        s.uSpotCos.value[n]!.set(Math.cos(half), Math.cos(Math.min(inner, half - 1e-3)));
        n++;
      }
    }
    s.uSpotCount.value = n;
    s.uSpotLampOn.value = sp.showLamp ? 1 : 0;
    // 全体照明：天井の長方形が光る面になる（光る面の明るさ = 放射輝度）
    const amb = sp.ambient;
    const ambOn = ambient && spotW > 0 && amb.strength > 0;
    const { widthM: W, depthM: D } = this.room;
    const m = Math.min(Math.max(0, amb.marginM), Math.min(W, D) / 2 - 0.05);
    s.uAmbRect.value.set(-W / 2 + m, W / 2 - m, -D + m, -m);
    if (ambOn) s.uAmbL.value.copy(spotColor({ colorMode: 'kelvin', kelvin: amb.kelvin, color: '#ffffff' } as SpotLight)).multiplyScalar(SPOT_SCALE * AMBIENT_SCALE * amb.strength * spotW);
    else s.uAmbL.value.set(0, 0, 0);
    this.spotOn = n > 0 || ambOn ? spotW : 0;

    // 灯台の光：奥の壁の真ん中から、正面（−z）を offsetDeg だけ右へ回した向きの沖に置く。帯は実際の時間で回す（早送りしても速さは変わらない）
    const lh = settings.lighthouse;
    const lhW = lighthouseWeight(lh, sun.altitude);
    const lhBeams = Math.min(4, Math.max(1, Math.round(lh.beams)));
    this.lhAngle = (this.lhAngle + (dt * 2 * Math.PI) / Math.max(1, lh.periodS)) % (2 * Math.PI);
    const off = (lh.offsetDeg * Math.PI) / 180;
    const lhDist = Math.max(50, lh.distanceM);
    const lhPos = new THREE.Vector3(lhDist * Math.sin(off), effectiveSeaLevel(settings) + Math.max(1, lh.heightM), -this.room.depthM - lhDist * Math.cos(off));
    const lhHalf = (Math.min(60, Math.max(0.5, lh.beamDeg)) * Math.PI) / 360;
    s.uLhOn.value = lhW;
    s.uLhPos.value.copy(lhPos);
    s.uLhAxis.value.set(this.lhAngle, lhBeams, Math.tan(lhHalf), 0.6 * lhHalf);
    const lhCol = linear(hexToRgb(lh.color));
    const lhLum = 0.2126 * lhCol.x + 0.7152 * lhCol.y + 0.0722 * lhCol.z;
    if (lhLum > 1e-4) lhCol.multiplyScalar(1 / lhLum);
    s.uLhI.value.copy(lhCol).multiplyScalar(LIGHTHOUSE_SCALE * Math.max(0, lh.strength) * lhW * lhDist * lhDist);
    s.uLhLook.value.set(LIGHTHOUSE_AIR * Math.max(0, lh.haze), LIGHTHOUSE_GLARE * Math.max(0, lh.glare), LIGHTHOUSE_VIS, 0);
    const toRoom = new THREE.Vector3(0, 1.5, -this.room.depthM / 2).sub(lhPos).normalize();
    this.lighthouseOn = lhW;
    this.lighthouseFacing = lhW > 0 ? lighthouseProfile(toRoom, this.lhAngle, lhBeams, lh.beamDeg) : 0;

    // 重ね合わせのやり直し：視点や設定（窓の大きさを含む）が変わったら最初から
    const key = [
      sp.mode, sp.kind, JSON.stringify(sp.ambient), sp.count, JSON.stringify(sp.lights.slice(0, sp.count)),
      lh.mode, lh.distanceM, lh.offsetDeg, lh.heightM, lh.beams, lh.beamDeg, lh.strength, lh.color,
      moon.on, moon.strength, moon.skyStrength, moon.color, moon.azimuthDeg, moon.altitudeDeg, moon.mode, real ? Math.round(phaseK * 100) : 0, preview, JSON.stringify(moon.skyCurve), JSON.stringify(moon.lightCurve), moon.seaRoadAltDeg, moon.seaRoadOffsetDeg, JSON.stringify(settings.glass), JSON.stringify(settings.glassSpecs), JSON.stringify(settings.openings), JSON.stringify(settings.textures), this.textures.key,
      settings.bounces, settings.seaView, settings.seaRipples, settings.pool, settings.poolReflect, settings.waveAmp, settings.poolDepthM, settings.seaLevelM, settings.poolSea, settings.poolSeaReachM, this.winRect.toArray(),
      cloudsOn, settings.cloudShadow, settings.cloudAmount, settings.cloudOpacity, settings.cloudSizeM, settings.cloudHeightM,
      settings.screenArea, !!screen, screen?.def.id, settings.screenGain,
    ].join();
    if (!this.lastCam.equals(camera.matrixWorld) || !this.lastProj.equals(camera.projectionMatrix) || key !== this.refKey) {
      this.samples = 0;
      this.lastCam.copy(camera.matrixWorld);
      this.lastProj.copy(camera.projectionMatrix);
      this.refKey = key;
    }
    // 太陽が 0.06° 動いたら、直近 16 枚ぶんの重みまで下げて新しい太陽に追従させる（照り返しはなだらかなので少し遅れても目立たない）
    if (sunDir.angleTo(this.refSun) > 1e-3) {
      this.samples = Math.min(this.samples, 16);
      this.refSun.copy(sunDir);
    }
    // 日差し・空の色が変わったとき（パネルの「日差しと空の色」、または時刻とともに）も、同じように追従させる
    const colorKey = [...input.lightColor, ...input.sky.top, ...input.sky.bottom];
    if (colorKey.some((v, i) => Math.abs(v - (this.refColor[i] ?? -1)) > 0.004)) {
      this.samples = Math.min(this.samples, 16);
      this.refColor = colorKey;
    }
    // 夕方にスポットライト・月明かりが少しずつ明るくなる間も、同じように追従させる
    if (Math.abs(spotW - this.refSpot) > 0.01 || Math.abs(moonW - this.refMoon) > 0.01) {
      this.samples = Math.min(this.samples, 16);
      this.refSpot = spotW;
      this.refMoon = moonW;
    }
    // 雲の影・スクリーンの映像は絶えず動くので、照り返しが遅れすぎないよう、直近 32 枚ぶんまでの平均にとどめる
    // （直射日光と映像そのものは毎フレーム計算し直すので遅れない。遅れるのは、それが周りを照らす照り返しの部分だけ）
    if ((cloudsOn && settings.cloudShadow) || screen) this.samples = Math.min(this.samples, 32);
    // 灯台の帯が部屋の近くを通る間は、照り返しが帯に遅れて付いてこないよう、直近 8 枚ぶんまでの平均にとどめる（帯は約 0.2 秒で通り過ぎる）
    if (this.lighthouseFacing > 0.003) this.samples = Math.min(this.samples, 8);

    // 波は実際の時間で動かす（早送りしても波の速さは変わらない）
    const ph = wavePhases(now);
    s.uPOOLPh.value = ph.pool;
    s.uSEAPh.value = ph.sea;
    s.uFINEPh.value = ph.fine;
    s.uWaveAmp.value = settings.waveAmp;
    // 窓の組み合わせ：1 つ目の窓（左 > 右）と天井の窓（2 つ目）で表せない壁の窓は、面ぜんたいを開ける（右の壁、天井だけ＋右 など）
    const op = settings.openings;
    s.uOpenMask.value = (op.right && windowSide !== 'right' ? 1 : 0) + (op.left && windowSide !== 'left' && windowSide !== 'ceiling-left' ? 2 : 0);
    // ガラスの壁：面ぜんたいが窓になる。壁がガラスなら、天窓だけのときも海が見える
    s.uGlassMask.value = GLASS_FACES.reduce((m, f) => m + (settings.glass[f] ? 1 << GLASS_FACE_INDEX[f] : 0), 0);
    const glassWall = (s.uGlassMask.value & 0b110011) !== 0;
    // ガラスの仕様（面ごと）：種類ごとの色（真正面で通る光の割合）× 透過率。表面の形と虹
    for (const face of GLASS_FACES) {
      const gs = settings.glassSpecs[face];
      const i = GLASS_FACE_INDEX[face];
      const tint = gs.kind === 'float' ? new THREE.Vector3(0.94, 0.975, 0.965)
        : gs.kind === 'lowIron' ? new THREE.Vector3(0.99, 0.995, 0.99)
        : linear(hexToRgb(gs.color));
      s.uGlassTintF.value[i]!.copy(tint.multiplyScalar(Math.max(0, gs.transmission)));
      s.uGlassWaveA.value[i]!.set(GLASS_SURFACES.indexOf(gs.surface), Math.max(0.01, gs.scaleM), Math.max(0, gs.depthMM) / 1000);
      s.uGlassWaveB.value[i]!.set(gs.prism ? Math.max(0, gs.prismStrength) : 0, glassFocus(gs), 0);
    }
    this.updateTextures(settings);
    s.uSeaOn.value = settings.seaView && (windowSide !== 'ceiling' || glassWall || s.uOpenMask.value > 0) ? 1 : 0;
    s.uSeaY.value = effectiveSeaLevel(settings);
    s.uSeaBody.value.set(0.12, 0.35, 0.42).multiplyScalar(skyL * 0.25);
    s.uSeaLook.value.set(Math.max(1e-4, settings.seaRoughness), Math.max(0, settings.seaScatter));
    s.uSeaHaze.value = Math.max(50, settings.seaHazeM);
    s.uSeaHorizon.value = settings.seaHorizon === 'real' ? 1 : 0;
    // FFT の海：風速・向き・高さが変わったら波のスペクトルを作り直す
    s.uOceanOn.value = s.uSeaOn.value && settings.seaWaves === 'fft' ? 1 : 0;
    if (s.uOceanOn.value) {
      const dir = cloudFlowDir(settings.windFromDeg, this.facingAzimuth);
      const key = [settings.seaWindMS, settings.seaWaveScale, dir.x.toFixed(4), dir.z.toFixed(4)].join();
      if (this.ocean?.key !== key) {
        const spectrum = buildOceanSpectrum({ windMS: settings.seaWindMS, dirX: dir.x, dirZ: dir.z, heightScale: settings.seaWaveScale });
        this.ocean = { spectrum, key, version: (this.ocean?.version ?? 0) + 1 };
        s.uOceanMss.value.set(spectrum.unresolvedMss);
        s.uOceanRms.value = spectrum.rmsHeight;
      }
      this.oceanTime = now;
    }
    s.uPixAngle.value = 2 / (Math.max(1e-3, camera.projectionMatrix.elements[5]) * Math.max(1, this.shared.uRes.value.y));
    s.uPoolOn.value = settings.pool ? 1 : 0;
    s.uPoolDepth.value = settings.poolDepthM;
    // 水盤を海とつなぐ：つながる面（ガラスの壁）がなければ、つながない
    s.uPoolSeaMask.value = poolSeaMask(settings);
    s.uPoolSea.value = s.uPoolSeaMask.value ? (settings.poolSea === 'open' ? 2 : 1) : 0;
    s.uPoolSeaReach.value = Math.max(0.1, settings.poolSeaReachM);
    this.causOn.value = settings.pool || (settings.seaRipples && windowSide !== 'ceiling') ? 1 : 0;

    s.uSunDir.value.copy(sunDir);
    s.uSunE.value.copy(sunE);
    // 海に映すきらめき：昼は太陽。夜は月の置き方による（A・B は部屋を照らす月と同じ向き、前の作り方は窓の真ん中の向きの低い月）。
    // 夜の明るさは「海に映す月の光の明るさ」を掛ける
    s.uSeaGlintDir.value.copy(sunDir);
    s.uSeaGlintE.value.copy(sunE);
    if (useMoon) {
      if (moon.mode === 'split' && lowMoon) s.uSeaGlintDir.value.copy(lowMoon);
      s.uSeaGlintE.value.multiplyScalar(Math.max(0, moon.seaRoadStrength));
    }
    s.uSeaSplit.value = settings.seaCompare && s.uOceanOn.value ? 1 : 0;
    s.uSkyTop.value.copy(top);
    s.uSkyBottom.value.copy(bottom);
    // 空の見え方が「選んだ色のまま」なら、見える空だけ、露出と仕上げ（ACES）を通した後に選んだ色になる明るさにする。
    // 太陽の高度による明るさ（skyBrightness）と夜空（月）は使わない（高度ごとの色の表が、明るさも決める）
    if (settings.skyLook === 'picked') {
      const view = (c: RGB): THREE.Vector3 => {
        const l = linear(c);
        const k = 1 / Math.max(0.05, settings.exposure);
        return l.set(acesInverse(l.x) * k, acesInverse(l.y) * k, acesInverse(l.z) * k);
      };
      s.uViewSkyTop.value.copy(view(input.sky.top));
      s.uViewSkyBottom.value.copy(view(input.sky.bottom));
    } else {
      s.uViewSkyTop.value.copy(top);
      s.uViewSkyBottom.value.copy(bottom);
    }
    s.uGround.value.copy(ground);
    s.uProjInv.value.copy(camera.projectionMatrixInverse);
    s.uCamWorld.value.copy(camera.matrixWorld);
    s.uCamPos.value.copy(camera.position);

    // 段階 1：空の光と照り返し。前のフレームまでの平均と 1 / (枚数 + 1) の重みで重ねる
    this.trace.uBounces.value = Math.round(settings.bounces);
    this.trace.uFrame.value = this.frameNo++ % 1_000_000;
    this.trace.uBlend.value = 1 / (this.samples + 1);
    this.samples = Math.min(this.samples + 1, 100_000);

    // 段階 2：画面に出す。ならす範囲は、重ねた枚数が増えるほど狭くする
    const k = Math.min(1, Math.sqrt(32 / (this.samples * this.spp)));
    this.display.uExposure.value = settings.exposure;
    this.display.uStride.value = settings.smooth ? Math.max(1, 3 * k) : 0;
    this.display.uSigmaP.value = 0.05 + 0.25 * k;
    this.display.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    return { caustics: this.causticPasses(sunDir, sunOn, settings), screen };
  }

  /** 面に貼る画像：使う画像を読み込み（読み終えるまでは貼らない）、面のまとまりごとに画像の束の何枚目かを決める */
  private updateTextures(settings: RoomRenderSettings): void {
    const s = this.shared;
    const ids: string[] = [];
    const pixels: TexturePixels[] = [];
    let on = 0;
    TEX_SURFACES.forEach((g, i) => {
      const t = settings.textures[g];
      const px = t.image !== 'none' ? texturePixels(t.image) : null;
      let layer = -1;
      if (px) {
        layer = ids.indexOf(t.image);
        if (layer < 0 && ids.length < MAX_TEXTURES) { layer = ids.length; ids.push(t.image); pixels.push(px); }
      }
      const w = Math.max(0.01, t.sizeM);
      s.uTexA.value[i]!.set(layer, 1 / w, 1 / (w * (px?.aspect ?? 1)));
      s.uTexB.value[i]!.set(Math.max(0, t.gain), 0, 0);
      if (layer >= 0) on = 1;
    });
    s.uTexOn.value = on;
    const key = ids.join('|');
    if (key !== this.textures.key) this.textures = { key, ids, pixels };
  }

  // 段階 0：水面の光の揺らぎを描く網目の一覧
  private causticPasses(sunDir: THREE.Vector3, sunOn: boolean, settings: RoomRenderSettings): CausticPass[] {
    const { widthM: W, depthM: D } = this.room;
    const passes: CausticPass[] = [];
    if (sunOn && settings.pool) {
      const o = new THREE.Vector3(-W / 2, 0, -D), u = new THREE.Vector3(W, 0, 0), v = new THREE.Vector3(0, 0, D);
      if (settings.poolReflect) for (const target of [0, 1, 2, 4, 5]) passes.push({ grid: 'pool', source: 0, mode: 0, target, o, u, v, y: 0 });
      passes.push({ grid: 'pool', source: 0, mode: 1, target: 6, o, u, v, y: 0 });
    }
    const seaY = effectiveSeaLevel(settings);
    const patch = sunOn && settings.seaRipples ? this.seaPatch(sunDir, seaY) : null;
    if (patch) {
      for (const target of [0, 1, 2, 4, 5]) passes.push({ grid: 'sea', source: 1, mode: 0, target, ...patch, y: seaY });
    }
    return passes;
  }

  // 窓の外の水面のうち、反射した日差しが窓を通る範囲（窓の四隅から、反射した光の向きを逆にたどって水面に下ろす）
  private seaPatch(sunDir: THREE.Vector3, seaY: number): { o: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 } | null {
    const wall = wallWindowSide(this.windowSide);
    const W = this.room.widthM;
    if (!wall || sunDir.y < 0.02) return null;
    const r = new THREE.Vector3(-sunDir.x, sunDir.y, -sunDir.z); // 平らな水面で反射した光の進む向き
    const wx = wall === 'right' ? W / 2 : -W / 2;
    if ((wall === 'right' && r.x >= 0) || (wall === 'left' && r.x <= 0)) return null; // 太陽が窓の側にない
    const down = (y: number, z: number): THREE.Vector3 => {
      const c = new THREE.Vector3(wx, y, z);
      return c.addScaledVector(r, -(y - seaY) / r.y);
    };
    const [z0, z1, y0, y1] = [this.winRect.x, this.winRect.y, this.winRect.z, this.winRect.w];
    const a = down(y0, z0), b = down(y0, z1), c = down(y1, z0);
    const u = b.clone().sub(a), v = c.clone().sub(a);
    // 波で光の向きがずれるぶん、少し広めにとる
    const center = a.clone().addScaledVector(u, 0.5).addScaledVector(v, 0.5);
    u.multiplyScalar(1.4);
    v.multiplyScalar(1.4);
    const o = center.addScaledVector(u, -0.5).addScaledVector(v, -0.5);
    return { o, u, v };
  }
}
