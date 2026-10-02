// room モードの 1 フレームぶんの計算のうち、描く方式（WebGL2・WebGPU）によらない部分。
// 設定と日差しから、シェーダーに渡す値・光の揺らぎを描く網目の一覧・重ね合わせの重みを決める。
// 実際に描くのは src/room/gl.ts（WebGL2）と src/room/gpu.ts（WebGPU）
import * as THREE from 'three';
import type { WindowSide } from '../config.ts';
import { type RGB, kelvinToRgb } from '../palette.ts';
import { DriftBlend } from '../scenes/shader.ts';
import { SUN_ANGULAR_RADIUS_DEG, directSunFactor, skyBrightness } from './daylight.ts';
import { MAX_SPOTS, type RoomGeometry, type RoomInput, type RoomRenderSettings, type RoomScreenImage, type SpotLight, cloudFlowDir, spotPose, spotWeight, toThree, windowRect } from './model.ts';
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
/** スポットライトの器具の大きさ（球の半径、m）。水面に映るライトのきらめきと、器具そのものの見え方に使う */
export const SPOT_RADIUS = 0.06;
export const CAUSTIC_SIZE = 512; // 光の揺らぎを記録する面ごとの画像の大きさ（画素）
/** 光の揺らぎの画像を持つ面：0 = 右の壁、1 = 左の壁、2 = 天井、4 = 手前、5 = 奥、6 = 水盤の底 */
export const CAUSTIC_FACES = [0, 1, 2, 4, 5, 6] as const;
/** スクリーンに映す映像を描く大きさ（展示と同じ 3840×1080。映像の中の px 単位の値がそのまま合う） */
export const SCREEN_IMAGE = { width: 3840, height: 1080 };
/** 雲の濃さのばらつきの大きさ（大きいほど、雲のかたまりと青空の差がはっきりする） */
const CLOUD_CONTRAST = 1.7;
const WINDOW_FACE: Record<WindowSide, number> = { right: 0, left: 1, ceiling: 2 };

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

/** スポットライトの色（線形）。明るさの目盛りをそろえるため、色を変えても明るさ（輝度）は 1 にする */
export function spotColor(light: SpotLight): THREE.Vector3 {
  const c = linear(light.colorMode === 'color' ? hexToRgb(light.color) : kelvinToRgb(light.kelvin));
  const lum = 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
  return lum > 1e-4 ? c.multiplyScalar(1 / lum) : new THREE.Vector3(1, 1, 1);
}

/** 1 フレームで 1 画素あたり追う光線の本数（多いほど早くきれいになるが重い）。URL の ?spp= で変えられる */
export function samplesPerPixel(): number {
  return Math.max(1, Math.min(8, Number(new URLSearchParams(location.search).get('spp') ?? 2) || 2));
}

export class RoomCore {
  readonly windowSide: WindowSide;
  readonly room: RoomGeometry;
  readonly spp = samplesPerPixel();
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

  private readonly facingAzimuth: number;
  private readonly winRect = new THREE.Vector4();
  private samples = 0;
  private frameNo = 0;
  private readonly lastCam = new THREE.Matrix4();
  private readonly lastProj = new THREE.Matrix4();
  private readonly refSun = new THREE.Vector3(0, -1, 0);
  private refKey = '';
  private refSpot = 0;
  /** スポットライトの今の点き具合（0〜1。状態表示に使う） */
  spotOn = 0;
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
    };
  }

  /** 描く大きさが変わったとき */
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

    this.winRect.fromArray(windowRect(windowSide, this.room, settings.window));
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
    s.uScreenOn.value = screen ? 1 : 0;
    s.uScreenGain.value = settings.screenGain;
    if (screen) s.uScreenOut.value.set(screen.outMin, screen.outMax);

    // スポットライト：点き具合は太陽の高度で決まる（自動のとき）。点いているライトを配列の先頭から詰める
    const sp = settings.spot;
    const spotW = spotWeight(sp, sun.altitude);
    let n = 0;
    if (spotW > 0) {
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
    this.spotOn = n > 0 ? spotW : 0;

    // 重ね合わせのやり直し：視点や設定（窓の大きさを含む）が変わったら最初から
    const key = [
      sp.mode, sp.count, JSON.stringify(sp.lights.slice(0, sp.count)),
      settings.bounces, settings.seaView, settings.seaRipples, settings.pool, settings.poolReflect, settings.waveAmp, settings.poolDepthM, settings.seaLevelM, this.winRect.toArray(),
      cloudsOn, settings.cloudShadow, settings.cloudAmount, settings.cloudOpacity, settings.cloudSizeM, settings.cloudHeightM,
      !!screen, screen?.def.id, settings.screenGain,
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
    // 夕方にスポットライトが少しずつ明るくなる間も、同じように追従させる
    if (Math.abs(spotW - this.refSpot) > 0.01) {
      this.samples = Math.min(this.samples, 16);
      this.refSpot = spotW;
    }
    // 雲の影・スクリーンの映像は絶えず動くので、照り返しが遅れすぎないよう、直近 32 枚ぶんまでの平均にとどめる
    // （直射日光と映像そのものは毎フレーム計算し直すので遅れない。遅れるのは、それが周りを照らす照り返しの部分だけ）
    if ((cloudsOn && settings.cloudShadow) || screen) this.samples = Math.min(this.samples, 32);

    // 波は実際の時間で動かす（早送りしても波の速さは変わらない）
    const ph = wavePhases(now);
    s.uPOOLPh.value = ph.pool;
    s.uSEAPh.value = ph.sea;
    s.uFINEPh.value = ph.fine;
    s.uWaveAmp.value = settings.waveAmp;
    s.uSeaOn.value = settings.seaView && windowSide !== 'ceiling' ? 1 : 0;
    s.uSeaY.value = settings.seaLevelM;
    s.uSeaBody.value.set(0.12, 0.35, 0.42).multiplyScalar(skyL * 0.25);
    s.uPoolOn.value = settings.pool ? 1 : 0;
    s.uPoolDepth.value = settings.poolDepthM;
    this.causOn.value = settings.pool || (settings.seaRipples && windowSide !== 'ceiling') ? 1 : 0;

    s.uSunDir.value.copy(sunDir);
    s.uSunE.value.copy(sunE);
    s.uSkyTop.value.copy(top);
    s.uSkyBottom.value.copy(bottom);
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

  // 段階 0：水面の光の揺らぎを描く網目の一覧
  private causticPasses(sunDir: THREE.Vector3, sunOn: boolean, settings: RoomRenderSettings): CausticPass[] {
    const { widthM: W, depthM: D } = this.room;
    const passes: CausticPass[] = [];
    if (sunOn && settings.pool) {
      const o = new THREE.Vector3(-W / 2, 0, -D), u = new THREE.Vector3(W, 0, 0), v = new THREE.Vector3(0, 0, D);
      if (settings.poolReflect) for (const target of [0, 1, 2, 4, 5]) passes.push({ grid: 'pool', source: 0, mode: 0, target, o, u, v, y: 0 });
      passes.push({ grid: 'pool', source: 0, mode: 1, target: 6, o, u, v, y: 0 });
    }
    const patch = sunOn && settings.seaRipples ? this.seaPatch(sunDir, settings.seaLevelM) : null;
    if (patch) {
      for (const target of [0, 1, 2, 4, 5]) passes.push({ grid: 'sea', source: 1, mode: 0, target, ...patch, y: settings.seaLevelM });
    }
    return passes;
  }

  // 窓の外の水面のうち、反射した日差しが窓を通る範囲（窓の四隅から、反射した光の向きを逆にたどって水面に下ろす）
  private seaPatch(sunDir: THREE.Vector3, seaY: number): { o: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 } | null {
    const windowSide = this.windowSide;
    const W = this.room.widthM;
    if (windowSide === 'ceiling' || sunDir.y < 0.02) return null;
    const r = new THREE.Vector3(-sunDir.x, sunDir.y, -sunDir.z); // 平らな水面で反射した光の進む向き
    const wx = windowSide === 'right' ? W / 2 : -W / 2;
    if ((windowSide === 'right' && r.x >= 0) || (windowSide === 'left' && r.x <= 0)) return null; // 太陽が窓の側にない
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
