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
    const w = Math.min(win.widthM, W * 0.95) / 2, d = Math.min(win.heightM, D * 0.95) / 2;
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
