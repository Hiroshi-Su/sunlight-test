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
  /** 窓の外の海の波の作り方（fft = 海の波の統計から FFT で作る（WebGPU のときだけ。WebGL2 では正弦波）、sines = 正弦波 20 本） */
  seaWaves: SeaWaves;
  /** 窓の外の海の上の風速（m/s。FFT のとき。大きいほど波が高く長い）。風の向きは雲と同じ「風が吹いてくる方位」 */
  seaWindMS: number;
  /** 窓の外の海の波の高さの倍率（FFT のとき。1 で、その風速で十分に発達した海の高さ） */
  seaWaveScale: number;
  /** 正弦波の海と FFT の海を並べて比べる（海を窓の奥行きの真ん中で分け、手前側：正弦波、奥側：FFT。WebGPU のとき） */
  seaCompare: boolean;
  /** 窓の外の海面の、描かない細かいさざ波の粗さ（傾きの 2 乗平均）。大きいほど太陽のきらめきが広い帯になる */
  seaRoughness: number;
  /** 窓の外の海の、波の山が日差しで透けて緑がかる強さ（0 = 透けない） */
  seaScatter: number;
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
  /** プリズム：日差しの当たる所に虹色の筋を出し、水の光の揺らぎの縁を虹色ににじませる */
  prism: PrismSettings;
  /** 奥の壁に、投影する場所（スクリーンの長方形）を少し違う色で示す。映像を映しているときは、オフでも映像の所は示す */
  screenArea: boolean;
  /** スクリーンに映像を映す（映像は RoomInput.screen） */
  screen: boolean;
  /** スクリーンの明るさ（プロジェクターの明るさ） */
  screenGain: number;
  /** 鑑賞者の頭上のスポットライト（夜に部屋を照らす） */
  spot: SpotSettings;
  /** 部屋の中央の光の軌跡（src/room/trails.ts） */
  trails: TrailSettings;
  /** 月明かり（夜に、太陽の代わりに窓から差し込む月の光と、夜空の明るさ） */
  moon: MoonSettings;
}

/**
 * 月明かり。太陽が沈むと、太陽の代わりに「月」が窓から光を差し込み（影の縁・照り返し・水盤の揺らぎ・雲の影は太陽と同じ計算）、
 * 夜空も明るくなる。月の位置は実際の月ではなく、ここで決める（実際の月は出ていない夜や細い夜があり、いつも月夜にはならないため）
 */
export interface MoonSettings {
  on: boolean;
  /** 月の光の明るさの倍率（1 で、照らされた床がほどよく見える程度） */
  strength: number;
  /** 夜空の明るさの倍率（窓から見える夜空と、そこから入る空の光） */
  skyStrength: number;
  /** 月の光と夜空の色（#rrggbb、sRGB）。明るさは別に決めるので、色だけが効く */
  color: string;
  /** 月の方位（度、真北 0・東 90）と高度（度） */
  azimuthDeg: number;
  altitudeDeg: number;
  /** 点き始める太陽の高度（度）と、最大になる太陽の高度（度） */
  onAltDeg: number;
  fullAltDeg: number;
  /** 窓の外の海に月の光の道を映す（夜、月明かりが点いているとき）。海に映す月は、部屋を照らす月とは別に、窓の正面の低い所に置く
   *  （部屋を照らす月は高いので、そのままでは海に映る所が窓から見えない） */
  seaRoad: boolean;
  /** 海に映す月の光の明るさの倍率（部屋を照らす月の光に対して） */
  seaRoadStrength: number;
  /** 海に映す月の向き：見ている所から窓の真ん中を見た向きから、奥（スクリーンの側）へ回す角度（度）と、高度（度）。
   *  見ている所から窓の真ん中の向きに置くので、視点を動かしても光の道は窓の中に見える */
  seaRoadOffsetDeg: number;
  seaRoadAltDeg: number;
}

/** 月明かりの点き具合（0〜1）。太陽の高度が onAltDeg から fullAltDeg へ下がる間に、なめらかに明るくなる */
export function moonWeight(moon: MoonSettings, sunAltDeg: number): number {
  if (!moon.on) return 0;
  const span = moon.onAltDeg - moon.fullAltDeg;
  if (span <= 0) return sunAltDeg <= moon.fullAltDeg ? 1 : 0;
  const t = Math.min(1, Math.max(0, (moon.onAltDeg - sunAltDeg) / span));
  return t * t * (3 - 2 * t);
}

/**
 * 月のある方向（three.js の座標：右 = +x、上 = +y、スクリーン = -z）。
 * @param facingAzimuth 鑑賞者がスクリーンを見る向き（真北基準）
 */
export function moonDirection(moon: MoonSettings, facingAzimuth: number): THREE.Vector3 {
  const r = Math.PI / 180;
  const alt = Math.min(89.9, Math.max(-89.9, moon.altitudeDeg)) * r;
  const d = (moon.azimuthDeg - facingAzimuth) * r; // スクリーンの向きから測った方位
  return new THREE.Vector3(Math.cos(alt) * Math.sin(d), Math.sin(alt), -Math.cos(alt) * Math.cos(d)).normalize();
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
/**
 * プリズム（虹色の光）。3 つの出し方（pattern）から選ぶ。
 * - streaks：日差しの当たる所（日だまり）に、虹色の筋を模様として描く（演出寄り。日が差していれば必ず見える）
 * - hung：窓の内側にガラスのプリズムを何個か吊る。プリズムに当たった日差しが曲がって虹に分かれ、壁・床・天井に落ちる（本物寄り）
 * - panel：窓（天窓・壁の窓）をプリズムの板で覆う。窓から入る日差しがすべて曲がって虹に分かれる。日だまりそのものがずれて、縁が虹色になる
 * 水の光の揺らぎ（水盤・窓の外の水面）があれば、どの出し方でも、その縁を虹色ににじませる
 */
/** 出し方。none = A〜D を出さない（E の波のプリズムだけにするとき） */
export type PrismPattern = 'streaks' | 'hung' | 'panel' | 'beams' | 'none';
export const PRISM_PATTERNS: readonly PrismPattern[] = ['streaks', 'hung', 'panel', 'beams', 'none'];
/**
 * プリズムの動き方（B と D）。spin = 吊り糸のまわりに一方向に回り続ける、sway = 左右にねじれては戻る（糸のねじれ振り子）、
 * wind = sway の揺れを風の強さ（雲を流す風速）で大きく・速くする、still = 止まったまま
 */
export type PrismMotion = 'spin' | 'sway' | 'wind' | 'still';
export const PRISM_MOTIONS: readonly PrismMotion[] = ['spin', 'sway', 'wind', 'still'];

export interface PrismSettings {
  on: boolean;
  pattern: PrismPattern;
  /** 日なたに落ちた虹の色を際立たせる割合（0〜1。streaks と hung）。虹の範囲では、白い日差しをこの割合だけ虹の色に置き換える（明るさはほぼそのまま）。0 で足すだけ（明るい日だまりでは、本物と同じく色がほとんど見えない） */
  vividness: number;
  /** 動く速さ（streaks は筋の揺れ、hung・beams はプリズムが回る・揺れる速さ。0 で止まる） */
  speed: number;
  /** プリズムの動き方（hung・beams） */
  motion: PrismMotion;
  /** sway・wind の揺れの大きさ（度、片側） */
  swayDeg: number;
  /** 水の光の揺らぎの虹色のにじみの幅（m、0 でにじませない） */
  causticSpreadM: number;
  streaks: PrismStreaks;
  hung: PrismHung;
  panel: PrismPanel;
  beams: PrismBeams;
  waves: PrismWaves;
  organic: PrismOrganic;
  blobs: PrismBlobs;
  shimmer: PrismShimmer;
}

/** 日だまりの中の虹色の筋（演出寄り） */
export interface PrismStreaks {
  /** 筋の明るさ（1 で、筋の中心の白い日差しを虹色に置き換え切る） */
  strength: number;
  /** 筋の多さ（0〜1） */
  amount: number;
  /** 筋の長さ（m、日差しに垂直な面で測る。斜めに当たる面では日差しの向きにもっと伸びる） */
  lengthM: number;
  /** 筋の向き（度） */
  angleDeg: number;
}

/** 窓に吊るプリズム（本物寄り） */
export interface PrismHung {
  /** 吊るプリズムの数（1〜MAX_PRISMS） */
  count: number;
  /** 1 つのプリズムから出る虹の数（カットされた面の数、1〜4）。面ごとに違う向きへ虹が飛ぶ */
  facets: number;
  /** 虹の明るさの倍率（1 で、プリズムが受けた日差しをそのまま虹に分ける） */
  strength: number;
  /** プリズムの大きさ（m）。虹の幅になる */
  sizeM: number;
  /** 光が曲がる角度（度）。ガラスの三角柱で 40° くらい */
  deviationDeg: number;
  /** 赤と紫の曲がり方の差（度）。虹の広がり。本物のガラスは 1〜2°、大きくすると虹が長く伸びる */
  dispersionDeg: number;
  /** 吊る位置：窓の上の端（天窓は天井）から下へ（m、平均。プリズムごとにばらつく） */
  dropM: number;
}

/** 窓を覆うプリズムの板 */
export interface PrismPanel {
  /** 板を通った日差しの明るさの割合（ガラスで少し減る） */
  strength: number;
  /** 光が曲がる角度（度） */
  deviationDeg: number;
  /** 赤と紫の曲がり方の差（度）。日だまりの縁の虹の幅になる */
  dispersionDeg: number;
  /** 板のプリズムの稜の向き（度）。光が曲がる向きが変わる（0 で、壁の窓は上下・天窓は奥行きの向きに曲がる） */
  ridgeAngleDeg: number;
}

/**
 * 窓ガラスに付けた小さなプリズムから出る、細い光の束（日差しの先の虹の筋）。
 * 束は日差しの向きから少し曲がって進み、当たった面に虹色の筋を作る。斜めに当たる面では、日差しの向きに長く伸びた筋になる
 */
export interface PrismBeams {
  /** 光の束の数（1〜MAX_PRISMS） */
  count: number;
  /** 虹の明るさの倍率（1 で、束が受けた日差しをそのまま虹に分ける） */
  strength: number;
  /** 束の太さ（m、窓の所で）。プリズムの大きさ */
  widthM: number;
  /** 進むにつれて束が太くなる割合（m/m）。大きいほど遠くの筋がぼける */
  blur: number;
  /** 光が曲がる角度（度） */
  deviationDeg: number;
  /** 赤と紫の曲がり方の差（度）。筋の中の虹の幅 */
  dispersionDeg: number;
  /** プリズムの稜の向き（度）。虹の色が並ぶ向きが変わる（0 で、壁の窓は稜が縦・天窓は奥行きの向き） */
  ridgeAngleDeg: number;
}

/**
 * E・F・G 共通の、有機的な縁の見え方。縁の中は白い日差し（または光）、縁で色が分かれて虹色の帯になり、外へは淡い色の光が広がって消える。
 * 長さの単位は E・F は m、G は光のしみの半径に対する割合
 */
export interface OrganicLook {
  /** 縁の色の帯の幅（色ごとに縁の位置をずらす幅。負にすると色の並びが逆になる） */
  fringe: number;
  /** 縁のぼかしの幅 */
  soft: number;
  /** 外へ広がる光の明るさ（0 で広げない） */
  halo: number;
  /** 外へ広がる光が消えるまでの幅 */
  haloWidth: number;
  /** 外へ広がる光の色合い（0〜1：赤 → 黄 → 緑 → 水色 → 青 → 紫） */
  haloHue: number;
  /** 色の濃さ（1 でそのまま、大きいほど鮮やか） */
  saturation: number;
}

/**
 * E：波のプリズム（A〜D のどれとも重ねられる）。水盤の日だまりの縁が、ゆっくり進む波に合わせて揺れ、縁が虹色の帯になる（F を水面の波で揺らしたもの）。
 * 色は縁から影の側へ広がりながら薄れていく。長さは m
 */
export interface PrismWaves extends OrganicLook {
  /** 重ねるか */
  on: boolean;
  /** 波で縁が揺れる大きさ（m） */
  wobbleM: number;
  /** 波の長さ（m） */
  waveLengthM: number;
  /** 波の進む速さ（m/s） */
  speed: number;
}

/**
 * F：有機的な日だまりの縁（A〜D と重ねられる）。窓に波打ったガラスがはまっているように、日だまりの縁が水彩のにじみのように揺れ、
 * 縁が虹色の帯になる。内側は淡い色がゆっくり移ろう。長さは m（窓の面の上で測る）
 */
export interface PrismOrganic extends OrganicLook {
  on: boolean;
  /** 縁が揺れる大きさ（m） */
  wobbleM: number;
  /** 揺らぎの模様の大きさ（m） */
  scaleM: number;
  /** 形が変わる速さ */
  speed: number;
  /** 内側の淡い色の濃さ（0〜1） */
  pastel: number;
}

/**
 * G：虹のしみ（A〜D と重ねられる）。窓辺の見えない物（溶けたガラスや水の入った瓶のようなもの）を通った日差しが、
 * 壁や床に丸みのある不定形の光のしみを作る。しみの縁は色の輪で縁取られ、形は液体のようにゆっくり変わる。
 * fringe・soft・haloWidth はしみの半径に対する割合
 */
export interface PrismBlobs extends OrganicLook {
  on: boolean;
  /** しみの数（1〜MAX_BLOBS） */
  count: number;
  /** 明るさの倍率 */
  strength: number;
  /** しみの大きさ（m、窓の所で。直径） */
  sizeM: number;
  /** 進むにつれてしみが大きくなる割合（m/m） */
  grow: number;
  /** 光が曲がる角度（度） */
  deviationDeg: number;
  /** 形の崩れ方（半径に対する割合） */
  wobble: number;
  /** 形が変わる速さ */
  speed: number;
  /** 内側の淡い色の濃さ（0〜1） */
  pastel: number;
}

/**
 * H：水のきらめき（A〜G と重ねられる）。日なたの中に、水底に映る光のような網目の線を重ねる。線の縁は虹色にずれ、
 * 線のまわりには薄い膜のような虹色がにじむ。網目はゆっくり形を変える。長さは窓の面の上で測る
 */
export interface PrismShimmer {
  on: boolean;
  /** 重ねる強さ（0 = 日なたそのまま、1 = 網目の明暗をそのまま） */
  amount: number;
  /** 網目をどこに置くか（light = 窓の面の上で作って日差しの向きに写す：日差しと一緒に動き、斜めの面では伸びる。
   *  surface = 床・壁・天井の面そのものに置く：どの面でも網目の大きさが変わらない） */
  anchor: ShimmerAnchor;
  /** 網目の 1 つ分の大きさ（m） */
  scaleM: number;
  /** 線の太さ（網目の 1 つ分に対する割合） */
  lineWidth: number;
  /** 網目のゆがみ（0 = 角ばった網目、大きいほど丸く流れる） */
  warp: number;
  /** 形が変わる速さ */
  speed: number;
  /** 線のない所の明るさ（日なたの明るさに対する割合） */
  base: number;
  /** 線の明るさ */
  gain: number;
  /** 線の縁の虹のずれ（網目の 1 つ分に対する割合） */
  dispersion: number;
  /** 線のまわりの薄い膜のような虹色の濃さ（0〜1） */
  iridescence: number;
  /** 色の決め方（spectrum = 虹の色の範囲から、palette = 選んだ色を並べる） */
  colorMode: ShimmerColorMode;
  /** 線の縁に並べる色の数（3〜MAX_SHIM_COLORS。多いほど縁がなめらかな虹になる） */
  colorCount: number;
  /** 虹の色の範囲の始めと終わり（赤 0 → 黄 → 緑 → 水色 → 青 → 紫 1。spectrum のとき） */
  hueStart: number;
  hueEnd: number;
  /** 選んだ色（#rrggbb、MAX_SHIM_PALETTE 個。palette のとき、先頭から paletteCount 個を使う） */
  palette: string[];
  paletteCount: number;
  /** 線の色と、線のない所（地）の色（#rrggbb。明るさは「線の明るさ」「線のない所の明るさ」で決め、ここでは色合いだけ） */
  lineColor: string;
  baseColor: string;
  /** 色の濃さ（0 = 白黒、1 = そのまま、2 = 濃く） */
  saturation: number;
}

/** 窓の外の海の波の作り方 */
export const SEA_WAVES = ['fft', 'sines'] as const;
export type SeaWaves = (typeof SEA_WAVES)[number];

/** H の網目の置き方 */
export const SHIMMER_ANCHORS = ['light', 'surface'] as const;
export type ShimmerAnchor = (typeof SHIMMER_ANCHORS)[number];
/** H の色の決め方 */
export const SHIMMER_COLOR_MODES = ['spectrum', 'palette'] as const;
export type ShimmerColorMode = (typeof SHIMMER_COLOR_MODES)[number];
/** H の線の縁に並べる色の最大の数と、選べる色の最大の数（シェーダーの配列の大きさ） */
export const MAX_SHIM_COLORS = 7;
export const MAX_SHIM_PALETTE = 5;

/** G の光のしみの最大の数（シェーダーの配列の大きさ） */
export const MAX_BLOBS = 8;

/** 吊るプリズムの最大の数（シェーダーの配列の大きさ） */
export const MAX_PRISMS = 12;

/** 照明の種類：spot = 鑑賞者の頭上のスポットライト（床に丸い光）、ambient = 全体照明（天井全体がむらなく光る。大型施設の天井照明のように、部屋全体を均一に照らす） */
export type LightKind = 'spot' | 'ambient';
export const LIGHT_KINDS: readonly LightKind[] = ['spot', 'ambient'];

/** 全体照明。天井の長方形（端から marginM 内側）が、むらなく光る面になる */
export interface AmbientLight {
  /** 明るさの倍率（1 で、スポットライト 1 台の真下と同じくらいの床の明るさを、部屋全体に） */
  strength: number;
  /** 光る面を、天井の端からどれだけ内側にするか（m） */
  marginM: number;
  /** 色温度（K） */
  kelvin: number;
}

/** スポットライトの最大の台数（シェーダーの配列の大きさ） */
export const MAX_SPOTS = 4;

/**
 * 鑑賞者の頭上のスポットライト（全体の設定）。点け方と自動で点く高度は全部のライトで共通、
 * 明るさ・形・向き・位置・色はライトごと（lights の先頭から count 台を使う）
 */
export interface SpotSettings {
  mode: SpotMode;
  /** 照明の種類（スポットライトか全体照明か）。点け方・自動で点く高度は共通 */
  kind: LightKind;
  /** 全体照明の設定（kind が ambient のとき使う） */
  ambient: AmbientLight;
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
 * 投影面の高さは planeHeightM（実寸）。0 なら、幅と出す画面の縦横比（3840×1080 なら 32:9）から決める
 */
export interface ViewCalibration {
  /** free = マウスで自由に動かす、fixed = この値で決めた視点 */
  mode: 'free' | 'fixed';
  /** 投影面の幅（m）・下端の高さ（床から m）・位置（部屋の手前の端から奥へ m）・左右のずれ（m、右が正） */
  planeWidthM: number;
  /** 投影面の高さ（m）。0 なら、幅と出す画面の縦横比から決める。実寸を入れると、出す画面の縦横比が違っても（映像を引き伸ばして映す場合も）パースが合う */
  planeHeightM: number;
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
    planeWidthM, planeHeightM: 0, planeBottomM: Math.max(0, eyeHeightM - (planeWidthM * 9) / 32 / 2), planeDepthM: 0, planeXM: 0,
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
  const w = Math.max(0.01, v.planeWidthM), h = v.planeHeightM > 0 ? v.planeHeightM : w / Math.max(1e-3, aspect);
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
