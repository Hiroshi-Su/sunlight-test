// room モード：仮想のホワイトボックスの部屋に、計算した日差しをパストレーシングで再現する。
//
// 光を 3 つに分けて計算する：
// - 直射日光：太陽の円盤（0.53°）の各点から窓を通って届くかを、画面に出す段階で毎フレーム確かめる（乱数を使わないので縁がくっきり）
// - 水面で反射・屈折した日差し（光の揺らぎ＝コースティクス）：水面の細かい網目ごとに、日差しが跳ね返って（曲がって）
//   どこに届くかを求め、網目の面積が届いた先でどれだけ縮んだか（光が集まったか）から明るさを出す。毎フレーム計算する
// - 空の光と照り返し：画素ごとに光の経路を追い（床・壁・天井で何度か跳ね返る）、フレームを重ねて平均する。
//   なだらかに変わる成分なので、同じ面の近くの画素どうしでならして、少ない枚数でも見やすくする
//
// 部屋の向きは src/solar.ts の light.{x,y,z}（screen 座標：x = 鑑賞者から見て右、y = 上、z = スクリーンの奥）に合わせる。
// ただし screen 座標は左手系、three.js は右手系なので、three.js 側では「スクリーンの奥 = -z」とし、
// z の符号だけ反転して使う（toThree）。窓の位置・緯度経度が変わっても、この対応は変わらない。
//
// 構成：値の計算は src/room/core.ts（描く方式によらない）、描くのは src/room/gl.ts（WebGL2・GLSL）か src/room/gpu.ts（WebGPU・WGSL）
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { WindowSide } from '../config.ts';
import type { Gpu } from '../gpu/webgpu.ts';
import type { Backend } from '../stage.ts';
import { RoomCore } from './core.ts';
import { GlRoomRenderer, type RoomRenderer } from './gl.ts';
import { GpuRoomRenderer } from './gpu.ts';
import { type RoomGeometry, type RoomInput, type RoomRenderSettings, type RoomView, type ViewCalibration, calibratedCamera, spotPose } from './model.ts';

export * from './model.ts';

/** 展示で映す大きさ（プロジェクター 2 台ぶん、32:9） */
export const EXHIBIT_SIZE = { width: 3840, height: 1080 } as const;

/**
 * 計算の解像度。パストレーシングは画素数がそのまま計算量になるので、小さく計算して画面に引き伸ばせば軽くなる
 * - scale：出す大きさに対する、計算する大きさの倍率（0.5 なら縦横半分、画素数は 1/4）
 * - output：'view' は画面の枠の大きさ。'exhibit'（縮めて見る）と 'actual'（原寸で見る）は、展示と同じ 3840×1080 を基準に計算する。
 *   2 つの違いは画面への出し方だけ（src/ui/room.ts）
 */
export type RoomOutput = 'view' | 'exhibit' | 'actual';
export interface RoomResolution {
  scale: number;
  output: RoomOutput;
}

export interface RoomSceneOptions {
  /** 作り直す前の視点（マウスで動かしていたとき） */
  view?: RoomView;
  /** WebGPU で描くとき（null・省略なら WebGL2） */
  gpu?: Gpu | null;
  resolution?: RoomResolution;
  /** パース合わせの視点（mode が fixed のとき、この値で見る） */
  calibration?: ViewCalibration;
  /** 合わせるための線を描く画面（部屋の画面に重ねる canvas） */
  guide?: HTMLCanvasElement | null;
}

/** 合わせるための線に描くもの */
export interface GuideOptions {
  show: boolean;
  /** 床の格子の間隔（m、0 で描かない） */
  gridM: number;
}

/**
 * @param facingAzimuth 鑑賞者がスクリーンを見る向き（真北基準）。風の方位を部屋の向きに直すのに使う
 */
export function createRoomScene(
  container: HTMLElement,
  windowSide: WindowSide,
  room: RoomGeometry,
  facingAzimuth: number,
  opts: RoomSceneOptions = {},
) {
  const { view, gpu = null, resolution = { scale: 1, output: 'view' }, guide = null } = opts;
  const { widthM: W, depthM: D, heightM: H } = room;
  const core = new RoomCore(windowSide, room, facingAzimuth);
  const renderer: RoomRenderer = gpu ? new GpuRoomRenderer(gpu, core) : new GlRoomRenderer(core);
  const backend: Backend = gpu ? 'webgpu' : 'webgl';
  container.appendChild(renderer.canvas);

  // 鑑賞者の位置（部屋の幅の中央・目の高さ）から、スクリーン（奥の壁、-z）を正面に見る。画面の右 = 鑑賞者の右
  const eyeY = Math.min(1.5, H * 0.5);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 200);
  camera.position.copy(view?.camera ?? new THREE.Vector3(0, eyeY, D * 0.4));

  const controls = new OrbitControls(camera, renderer.canvas);
  controls.target.copy(view?.target ?? new THREE.Vector3(0, eyeY, -D));
  controls.maxPolarAngle = Math.PI * 0.6;
  controls.minDistance = 1;
  controls.maxDistance = Math.max(W, D, H) * 4;
  controls.update();

  let res: RoomResolution = { ...resolution };
  let size = { width: 1, height: 1 };
  function resize(): void {
    // 出す大きさ。画面の枠のときは、高解像度ディスプレイでも 1 倍（CSS の画素）で数える
    const out = res.output !== 'view'
      ? EXHIBIT_SIZE
      : { width: Math.max(1, container.clientWidth), height: Math.max(1, container.clientHeight) };
    // 計算する大きさ。canvas はこの大きさで描き、CSS で枠いっぱいに引き伸ばす
    const w = Math.max(1, Math.round(out.width * res.scale));
    const h = Math.max(1, Math.round(out.height * res.scale));
    if (w !== size.width || h !== size.height) {
      renderer.resize(w, h);
      core.resize(w, h);
      size = { width: w, height: h };
    }
    aspect = out.width / out.height;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    if (calib.mode === 'fixed') applyCalibration();
  }
  let aspect = 1;
  let calib: ViewCalibration = opts.calibration ? { ...opts.calibration } : ({ mode: 'free' } as ViewCalibration);
  // パース合わせの視点：投影面と目の位置からカメラの位置・向きと、見える範囲（軸外し）を決める
  function applyCalibration(): void {
    const c = calibratedCamera(calib, aspect, camera.near);
    camera.position.copy(c.position);
    camera.quaternion.copy(c.quaternion);
    camera.updateMatrixWorld();
    camera.projectionMatrix.makePerspective(c.left, c.right, c.top, c.bottom, camera.near, camera.far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  resize();
  // 枠の大きさが変わったら合わせる（ウィンドウの大きさだけでなく、スクロールバーが出た・見え方を切り替えた、なども含む）
  const observer = new ResizeObserver(() => resize());
  observer.observe(container);

  /** 計算の解像度を変える（重ね合わせはやり直しになる） */
  function setResolution(next: RoomResolution): void {
    res = { ...next };
    // 原寸で見るときは、はみ出した分をホイールでスクロールできるように、ホイールでのズームを止める
    controls.enableZoom = res.output !== 'actual';
    resize();
  }
  setResolution(res);

  // マウスで動かしていた視点（パース合わせから戻すときに使う）
  const freeView: RoomView = { camera: camera.position.clone(), target: controls.target.clone() };
  /** パース合わせの値を変える。fixed ならその視点、free ならマウスで動かす（free に戻すと、元の視点に戻る） */
  function setCalibration(next: ViewCalibration): void {
    const wasFixed = calib.mode === 'fixed';
    calib = { ...next };
    controls.enabled = calib.mode === 'free';
    if (calib.mode === 'fixed') applyCalibration();
    else if (wasFixed) {
      camera.position.copy(freeView.camera);
      controls.target.copy(freeView.target);
      camera.updateProjectionMatrix();
      controls.update();
    }
  }
  setCalibration(calib);

  let last: { input: RoomInput; settings: RoomRenderSettings } | null = null;
  let guideOpts: GuideOptions = { show: false, gridM: 1 };
  let guideDrawn = false;
  function render(input: RoomInput, settings: RoomRenderSettings): void {
    if (calib.mode === 'fixed') applyCalibration();
    else {
      controls.update();
      freeView.camera.copy(camera.position);
      freeView.target.copy(controls.target);
    }
    camera.updateMatrixWorld();
    renderer.render(core.frame(input, settings, camera));
    last = { input, settings };
    drawGuides(settings);
  }

  // ---- 合わせるための線：部屋の辺・床の格子・窓・スクリーン・ライトの位置を、カメラから見た位置に描く ----
  function drawGuides(settings: RoomRenderSettings): void {
    if (!guide) return;
    if (!guideOpts.show) {
      if (guideDrawn) { guide.getContext('2d')?.clearRect(0, 0, guide.width, guide.height); guideDrawn = false; }
      return;
    }
    const dpr = devicePixelRatio;
    const cw = Math.max(1, Math.round(guide.clientWidth * dpr)), ch = Math.max(1, Math.round(guide.clientHeight * dpr));
    if (guide.width !== cw || guide.height !== ch) { guide.width = cw; guide.height = ch; }
    const g = guide.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, cw, ch);
    guideDrawn = true;
    const inv = camera.matrixWorldInverse, proj = camera.projectionMatrix, near = camera.near;
    const toView = (p: THREE.Vector3): THREE.Vector3 => p.clone().applyMatrix4(inv);
    const toPx = (v: THREE.Vector3): [number, number] => {
      const c = v.clone().applyMatrix4(proj);
      return [(c.x * 0.5 + 0.5) * cw, (0.5 - c.y * 0.5) * ch];
    };
    // 目の後ろに回る部分は、近い面で切ってから描く
    const line = (a: THREE.Vector3, b: THREE.Vector3): void => {
      let va = toView(a), vb = toView(b);
      const za = -va.z - near, zb = -vb.z - near;
      if (za < 0 && zb < 0) return;
      if (za < 0) va = va.clone().lerp(vb, za / (za - zb));
      else if (zb < 0) vb = vb.clone().lerp(va, zb / (zb - za));
      const [px0, py0] = toPx(va), [px1, py1] = toPx(vb);
      g.moveTo(px0, py0);
      g.lineTo(px1, py1);
    };
    const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
    const stroke = (color: string, width: number, draw: () => void): void => {
      g.beginPath();
      draw();
      g.strokeStyle = color;
      g.lineWidth = width * dpr;
      g.stroke();
    };
    const x0 = -W / 2, x1 = W / 2, z0 = 0, z1 = -D;
    // 床の格子
    const step = guideOpts.gridM;
    if (step > 0) {
      stroke('rgba(120, 200, 255, 0.45)', 1, () => {
        for (let x = Math.ceil(x0 / step) * step; x <= x1 + 1e-6; x += step) line(V(x, 0, z0), V(x, 0, z1));
        for (let z = 0; z >= z1 - 1e-6; z -= step) line(V(x0, 0, z), V(x1, 0, z));
      });
    }
    // 部屋の辺（12 本）
    stroke('rgba(255, 255, 255, 0.9)', 2, () => {
      for (const y of [0, H]) {
        line(V(x0, y, z0), V(x1, y, z0)); line(V(x0, y, z1), V(x1, y, z1));
        line(V(x0, y, z0), V(x0, y, z1)); line(V(x1, y, z0), V(x1, y, z1));
      }
      for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as const) line(V(x, 0, z), V(x, H, z));
    });
    // 窓
    const wr = core.shared.uWinRect.value, face = core.shared.uWinFace.value;
    stroke('rgba(80, 255, 200, 0.9)', 2, () => {
      const pt = (u: number, v: number): THREE.Vector3 => face === 2 ? V(u, H, v) : V(face === 0 ? x1 : x0, v, u);
      const c = [pt(wr.x, wr.z), pt(wr.y, wr.z), pt(wr.y, wr.w), pt(wr.x, wr.w)];
      for (let i = 0; i < 4; i++) line(c[i]!, c[(i + 1) % 4]!);
    });
    // スクリーン（奥の壁）
    const sr = core.shared.uScreenRect.value;
    stroke('rgba(255, 220, 80, 0.9)', 2, () => {
      const c = [V(sr.x, sr.z, z1), V(sr.y, sr.z, z1), V(sr.y, sr.w, z1), V(sr.x, sr.w, z1)];
      for (let i = 0; i < 4; i++) line(c[i]!, c[(i + 1) % 4]!);
    });
    // ライトの位置（真下の床までの線と、照らす向き）
    const sp = settings.spot;
    stroke('rgba(255, 160, 60, 0.95)', 2, () => {
      for (const light of sp.lights.slice(0, sp.count)) {
        const { pos, dir } = spotPose(light, room);
        line(pos, V(pos.x, 0, pos.z));
        line(pos, pos.clone().addScaledVector(dir, 0.8));
      }
    });
  }

  /** 合わせるための線の出し方を変える */
  function setGuides(next: GuideOptions): void {
    guideOpts = { ...next };
    if (last) drawGuides(last.settings);
  }

  /** 今の設定で続けて描き、GPU の処理が終わるまで待って 1 フレームあたりの時間（ms）を測る（その間は描画が止まる） */
  async function benchmark(frames = 60): Promise<number | null> {
    if (!last) return null;
    const { input, settings } = last;
    render(input, settings);
    await renderer.finish();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) render(input, settings);
    await renderer.finish();
    return (performance.now() - t0) / frames;
  }

  /** マウスで動かしていた視点（パース合わせで見ているときも、その前の視点を返す） */
  function currentView(): RoomView {
    return { camera: freeView.camera.clone(), target: freeView.target.clone() };
  }

  function dispose(): void {
    observer.disconnect();
    controls.dispose();
    renderer.dispose();
    container.removeChild(renderer.canvas);
    guide?.getContext('2d')?.clearRect(0, 0, guide.width, guide.height);
  }

  return {
    camera,
    controls,
    backend,
    render,
    benchmark,
    resize,
    setResolution,
    setCalibration,
    setGuides,
    /** 今の計算の大きさ（画素） */
    get renderSize(): { width: number; height: number } { return size; },
    currentView,
    dispose,
    /** 1 画素あたり、これまでに追った光線の本数 */
    get samples(): number { return core.raysPerPixel; },
    /** スポットライトの今の点き具合（0〜1） */
    get spotOn(): number { return core.spotOn; },
  };
}
