// room モードの型と、描く方式によらない計算（部屋の座標・窓の範囲・雲の流れる向き）
import * as THREE from 'three';
import type { ParamValues, WindowSide } from '../config.ts';
import type { RGB } from '../palette.ts';
import type { SceneDef, SceneInput } from '../scenes/types.ts';
import type { SolarState } from '../solar.ts';

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

/** スクリーンに映す映像（visuals の映像をそのまま使う） */
export interface RoomScreenImage {
  def: SceneDef;
  params: ParamValues;
  input: SceneInput;
  /** 出力の明るさの範囲（config/visuals.json の output。展示と同じ） */
  outMin: number;
  outMax: number;
}

export interface RoomInput {
  solar: SolarState;
  lightColor: RGB;
  sky: { top: RGB; bottom: RGB };
  /** スクリーンに映す映像（映さないときは null） */
  screen?: RoomScreenImage | null;
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
  /** 水盤の水面で跳ね返った日差しが、壁・天井に揺らぎを映す（オフでも、水盤の底の光の網目と水面の映り込みは残る） */
  poolReflect: boolean;
  /** 波の強さの倍率 */
  waveAmp: number;
  /** 水盤の深さ（m） */
  poolDepthM: number;
  /** 窓の外の水面の高さ（床を 0 とした m。負なら床より下） */
  seaLevelM: number;
  /** 窓の大きさ（パネルで変えられる。初期値は config/site.json） */
  window: WindowGeometry;
  /** 窓の外の空に雲を浮かべる */
  clouds: boolean;
  /** 雲が太陽を横切ると日差しが弱まる（雲の影） */
  cloudShadow: boolean;
  /** 雲の量（0〜1）・厚さ（日差しをさえぎる割合 0〜1） */
  cloudAmount: number;
  cloudOpacity: number;
  /** 雲のかたまりの大きさ（m）・高さ（m） */
  cloudSizeM: number;
  cloudHeightM: number;
  /** 雲の高さでの風速（m/s）と、風が吹いてくる方位（度、真北 0・東 90） */
  windMS: number;
  windFromDeg: number;
  /** スクリーンに映像を映す（映像は RoomInput.screen） */
  screen: boolean;
  /** スクリーンの明るさ（プロジェクターの明るさ） */
  screenGain: number;
  /** 鑑賞者の頭上のスポットライト（夜に部屋を照らす） */
  spot: SpotSettings;
  /** 部屋の中央の光の軌跡（src/room/trails.ts） */
  trails: TrailSettings;
}

/** 光の軌跡の色の決め方：scene = 日差し・ライトの色に合わせる、hue = 線ごとに色相をずらす（元の演出に近い）、color = 色を選ぶ */
export type TrailColorMode = 'scene' | 'hue' | 'color';
export const TRAIL_COLOR_MODES: readonly TrailColorMode[] = ['scene', 'hue', 'color'];

/** 部屋の中央の光の軌跡 */
export interface TrailSettings {
  on: boolean;
  /** 線の本数・1 本あたりの点の数（多いほど軌跡が長い。点の間隔は 1/60 秒ぶん進む距離） */
  count: number;
  points: number;
  /** 線の太さ（3840×1080 で出したときの画素。出す大きさに合わせて変わる） */
  widthPx: number;
  /** 速さ（m/s の目安）・流れの細かさ（1/m） */
  speed: number;
  turbulence: number;
  /** 線ごとのばらつき（0 で全部の線が同じ流れに乗る。大きいほど線がばらける） */
  spread: number;
  /** 漂う範囲（中心からの半径、m）・中心の高さ（床から m）・中心の位置（部屋の手前の端から奥へ m、0 なら部屋の中央） */
  radiusM: number;
  centerHeightM: number;
  centerFromFrontM: number;
  /** 明るさ */
  brightness: number;
  colorMode: TrailColorMode;
  /** 色を選ぶとき・色相をずらすときの基準の色（#rrggbb） */
  color: string;
  /** 色相をずらす幅（0〜1。1 で全部の色相） */
  hueSpread: number;
}

/** スポットライトの点け方：auto = 太陽が沈むにつれて点く、on = いつも点ける、off = 消す */
export type SpotMode = 'auto' | 'on' | 'off';
export const SPOT_MODES: readonly SpotMode[] = ['auto', 'on', 'off'];
/** スポットライトの最大の台数（シェーダーの配列の大きさ） */
export const MAX_SPOTS = 4;

/**
 * 鑑賞者の頭上のスポットライト（全体の設定）。点け方と自動で点く高度は全部のライトで共通、
 * 明るさ・形・向き・位置・色はライトごと（lights の先頭から count 台を使う）
 */
export interface SpotSettings {
  mode: SpotMode;
  /** 使う台数（1〜MAX_SPOTS） */
  count: number;
  /** 自動のとき：点き始める太陽の高度（度）と、最大の明るさになる太陽の高度（度） */
  onAltDeg: number;
  fullAltDeg: number;
  /** ライトの器具（小さな球）と、水面に映るそのきらめきを描くか。オフでも、照らす光は変わらない */
  showLamp: boolean;
  lights: SpotLight[];
}

/**
 * スポットライト 1 台。位置は部屋の手前の端（鑑賞者の側、z = 0）から測る。
 * 向きは、真下を 0° として、スクリーン（奥）の方へ傾ける角度（tiltDeg）と、左右の向き（panDeg、右が正）
 */
export interface SpotLight {
  /** 明るさの倍率（1 で、夜に露出 2.5 のとき照らされた床がほどよく見える程度） */
  strength: number;
  /** 光の広がり（円すいの全角、度） */
  beamDeg: number;
  /** 縁のぼけ（0 = くっきり、1 = 中心から縁まで徐々に暗くなる） */
  softness: number;
  tiltDeg: number;
  panDeg: number;
  /** 手前の端からの距離（m）・天井からの距離（m）・左右の位置（m、右が正） */
  fromFrontM: number;
  belowCeilingM: number;
  xM: number;
  /** 色の決め方：kelvin = 色温度（白熱灯〜昼光の白）、color = 色を直接選ぶ */
  colorMode: 'kelvin' | 'color';
  /** 色温度（K） */
  kelvin: number;
  /** 色（#rrggbb、sRGB） */
  color: string;
}

/** 自動のときの点き具合（0〜1）。太陽の高度が onAltDeg から fullAltDeg へ下がる間に、なめらかに明るくなる */
export function spotWeight(spot: SpotSettings, sunAltDeg: number): number {
  if (spot.mode === 'off') return 0;
  if (spot.mode === 'on') return 1;
  const span = spot.onAltDeg - spot.fullAltDeg;
  if (span <= 0) return sunAltDeg <= spot.fullAltDeg ? 1 : 0;
  const t = Math.min(1, Math.max(0, (spot.onAltDeg - sunAltDeg) / span));
  return t * t * (3 - 2 * t);
}

/** スポットライトの位置と向き（three.js の座標：右 = +x、上 = +y、スクリーン = -z）。位置は部屋の中に収める */
export function spotPose(light: SpotLight, room: RoomGeometry): { pos: THREE.Vector3; dir: THREE.Vector3 } {
  const r = Math.PI / 180;
  const pos = new THREE.Vector3(
    Math.min(room.widthM / 2 - 0.05, Math.max(-room.widthM / 2 + 0.05, light.xM)),
    Math.max(0.1, room.heightM - light.belowCeilingM),
    -Math.min(room.depthM - 0.05, Math.max(0.05, light.fromFrontM)),
  );
  const t = light.tiltDeg * r, p = light.panDeg * r;
  const dir = new THREE.Vector3(Math.sin(p) * Math.sin(t), -Math.cos(t), -Math.cos(p) * Math.sin(t)).normalize();
  return { pos, dir };
}

/**
 * 現地に合わせた視点（パース合わせ）。映像が映る面（投影面）と、見る人の目の位置を実寸で決めると、
 * 目から投影面を覗いた見え方（軸外し投影）になる。投影面は部屋の座標の中に置く（部屋の手前の端 = 0、奥へ正）。
 * 投影面の高さは、幅と出す画面の縦横比（3840×1080 なら 32:9）から決まる
 */
export interface ViewCalibration {
  /** free = マウスで自由に動かす、fixed = この値で決めた視点 */
  mode: 'free' | 'fixed';
  /** 投影面の幅（m）・下端の高さ（床から m）・位置（部屋の手前の端から奥へ m）・左右のずれ（m、右が正） */
  planeWidthM: number;
  planeBottomM: number;
  planeDepthM: number;
  planeXM: number;
  /** 投影面の向き（度）：左右に振る（右へ振ると正）・上下に倒す（上の縁を奥へ倒すと正）・画面の中で回す（時計回りが正） */
  planeYawDeg: number;
  planePitchDeg: number;
  planeRollDeg: number;
  /** 目の位置：投影面からの距離（m、手前が正）・高さ（床から m）・左右（投影面の中心から m、右が正） */
  eyeDistM: number;
  eyeHeightM: number;
  eyeXM: number;
}

/** 部屋の大きさから決める、パース合わせの初期値（マウスで動かす前の視点とほぼ同じ見え方） */
export function defaultCalibration(room: RoomGeometry): ViewCalibration {
  const eyeHeightM = Math.min(1.5, room.heightM * 0.5);
  const planeWidthM = room.widthM;
  return {
    mode: 'free',
    planeWidthM, planeBottomM: Math.max(0, eyeHeightM - (planeWidthM * 9) / 32 / 2), planeDepthM: 0, planeXM: 0,
    planeYawDeg: 0, planePitchDeg: 0, planeRollDeg: 0,
    eyeDistM: room.depthM * 0.4, eyeHeightM, eyeXM: 0,
  };
}

/**
 * パース合わせの視点を、カメラの位置・向きと、見える範囲（近い面での左右上下の端）に直す（Kooima の一般化した透視投影）。
 * @param aspect 出す画面の幅 ÷ 高さ
 */
export function calibratedCamera(v: ViewCalibration, aspect: number, near: number): {
  position: THREE.Vector3; quaternion: THREE.Quaternion; left: number; right: number; bottom: number; top: number;
} {
  const r = Math.PI / 180;
  const w = Math.max(0.01, v.planeWidthM), h = w / Math.max(1e-3, aspect);
  // 投影面の中心と、面の右・上・手前（目の側）の向き
  const center = new THREE.Vector3(v.planeXM, v.planeBottomM + h / 2, -v.planeDepthM);
  const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(-v.planePitchDeg * r, -v.planeYawDeg * r, -v.planeRollDeg * r, 'YXZ'));
  const vr = new THREE.Vector3(1, 0, 0).applyQuaternion(rot);
  const vu = new THREE.Vector3(0, 1, 0).applyQuaternion(rot);
  const vn = new THREE.Vector3(0, 0, 1).applyQuaternion(rot);
  // 目の位置は、投影面の中心から測る（高さだけは床から）
  const eye = center.clone().addScaledVector(vr, v.eyeXM).addScaledVector(vn, Math.max(0.05, v.eyeDistM));
  eye.y += v.eyeHeightM - center.y;
  const pa = center.clone().addScaledVector(vr, -w / 2).addScaledVector(vu, -h / 2); // 左下
  const va = pa.clone().sub(eye);
  const d = Math.max(1e-3, -va.dot(vn)); // 目から投影面までの距離
  const k = near / d;
  const left = va.dot(vr) * k, bottom = va.dot(vu) * k;
  return {
    position: eye,
    quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(vr, vu, vn)),
    left, right: left + w * k, bottom, top: bottom + h * k,
  };
}

export interface RoomView {
  camera: THREE.Vector3;
  target: THREE.Vector3;
}


/** screen 座標（左手系）→ three.js（右手系）。スクリーンの奥を -z にする */
export const toThree = (v: { x: number; y: number; z: number }): THREE.Vector3 => new THREE.Vector3(v.x, v.y, -v.z);

/**
 * 窓の範囲（窓のある面の上の座標 u0, u1, v0, v1）。壁の窓は奥行きの中央に (z, y)、天窓は天井の中央に (x, z)。
 * 部屋からはみ出す大きさは、部屋に収まるように切り詰める
 */
export function windowRect(side: WindowSide, room: RoomGeometry, win: WindowGeometry): [number, number, number, number] {
  const { widthM: W, depthM: D, heightM: H } = room;
  const midZ = -D / 2;
  if (side === 'ceiling') {
    // 天窓は天井いっぱい（天井の面がなくなる大きさ）まで開けられる
    const w = Math.min(win.widthM, W) / 2, d = Math.min(win.heightM, D) / 2;
    return [-w, w, midZ - d, midZ + d];
  }
  const w = Math.min(win.widthM, D * 0.95) / 2;
  const y0 = Math.min(win.sillHeightM, H * 0.9), y1 = Math.min(win.sillHeightM + win.heightM, H * 0.98);
  return [midZ - w, midZ + w, y0, Math.max(y1, y0 + 0.01)];
}

/**
 * 風が吹いてくる方位（真北基準）から、雲が流れていく向きを部屋の座標（three.js：右 = +x、スクリーン = -z）で返す。
 * 雲は風下へ流れる（西風 = 270° なら東へ）
 */
export function cloudFlowDir(windFromDeg: number, facingAzimuth: number): { x: number; z: number } {
  const r = ((windFromDeg + 180 - facingAzimuth) * Math.PI) / 180; // 流れていく方位を、スクリーンの向きから測った角度
  return { x: Math.sin(r), z: -Math.cos(r) };
}
