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
import type { RoomGeometry, RoomInput, RoomRenderSettings, RoomView } from './model.ts';

export * from './model.ts';

/**
 * @param facingAzimuth 鑑賞者がスクリーンを見る向き（真北基準）。風の方位を部屋の向きに直すのに使う
 * @param gpu WebGPU で描くとき（null なら WebGL2）
 */
export function createRoomScene(
  container: HTMLElement,
  windowSide: WindowSide,
  room: RoomGeometry,
  facingAzimuth: number,
  view?: RoomView,
  gpu: Gpu | null = null,
) {
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

  function resize(): void {
    // 画素数がそのまま計算量になるので、高解像度ディスプレイでも 1 倍で計算する
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.resize(w, h);
    core.resize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  let last: { input: RoomInput; settings: RoomRenderSettings } | null = null;
  function render(input: RoomInput, settings: RoomRenderSettings): void {
    controls.update();
    camera.updateMatrixWorld();
    renderer.render(core.frame(input, settings, camera));
    last = { input, settings };
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

  function currentView(): RoomView {
    return { camera: camera.position.clone(), target: controls.target.clone() };
  }

  function dispose(): void {
    controls.dispose();
    renderer.dispose();
    container.removeChild(renderer.canvas);
  }

  return {
    camera,
    controls,
    backend,
    render,
    benchmark,
    resize,
    currentView,
    dispose,
    /** 1 画素あたり、これまでに追った光線の本数 */
    get samples(): number { return core.raysPerPixel; },
  };
}
