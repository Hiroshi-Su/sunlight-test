// room モード：仮想のホワイトボックスの部屋に、計算した日差しを環境光とスポットライトとして再現する。
//
// 部屋の向きは src/solar.ts の light.{x,y,z}（screen 座標：x = 鑑賞者から見て右、y = 上、z = スクリーンの奥）に合わせる。
// ただし screen 座標は左手系、three.js は右手系なので、そのまま載せると左右が反転する。
// three.js 側では「スクリーンの奥 = -z」とし、z の符号だけ反転して使う（toThree）。
// 窓の位置・緯度経度が変わっても、この対応は変わらない（方位の変換は resolveSite 側で済んでいる）。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { WindowSide } from '../config.ts';
import type { RGB } from '../palette.ts';
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

export interface RoomInput {
  solar: SolarState;
  lit: number;
  lightColor: RGB;
  sky: { top: RGB; bottom: RGB };
}

export interface RoomView {
  camera: THREE.Vector3;
  target: THREE.Vector3;
}

// input の色は sRGB 表記の 0〜1（他のシーンと共通の palette.ts 由来）。
// three.js の色管理（既定で有効）は数値引数を作業色空間＝linear-sRGB として扱うため、変換してから渡す
const rgb = (c: RGB): THREE.Color => new THREE.Color(c[0], c[1], c[2]).convertSRGBToLinear();

/** screen 座標（左手系）→ three.js（右手系）。スクリーンの奥を -z にする */
export const toThree = (v: { x: number; y: number; z: number }): THREE.Vector3 => new THREE.Vector3(v.x, v.y, -v.z);

// 「日差しで光条が輝く」の既定値と同じ考え方：太陽が入る間だけ、この強さまで lit に比例して立ち上がる
const SUN_INTENSITY = 6;

/** 長方形の中に長方形の穴を空けたときの、残りの 4 枚（穴の手前・奥・左・右）。座標は [a0, a1] × [b0, b1] */
function frameAround(a0: number, a1: number, b0: number, b1: number, hole: Rect): Rect[] {
  return [
    { a0, a1, b0, b1: hole.b0 },
    { a0, a1, b0: hole.b1, b1 },
    { a0, a1: hole.a0, b0: hole.b0, b1: hole.b1 },
    { a0: hole.a1, a1, b0: hole.b0, b1: hole.b1 },
  ].filter((r) => r.a1 - r.a0 > 1e-6 && r.b1 - r.b0 > 1e-6);
}

// 外殻の面どうしは縁で接するだけだと、影の計算で継ぎ目から光が漏れる。部屋の外周に当たる縁だけ外へ延ばして重ねる
const SEAM = 0.05;
type Rect = { a0: number; a1: number; b0: number; b1: number };
function growOuterEdges(parts: Rect[], bounds: Rect): Rect[] {
  const at = (v: number, edge: number): boolean => Math.abs(v - edge) < 1e-6;
  return parts.map((r) => ({
    a0: at(r.a0, bounds.a0) ? r.a0 - SEAM : r.a0,
    a1: at(r.a1, bounds.a1) ? r.a1 + SEAM : r.a1,
    b0: at(r.b0, bounds.b0) ? r.b0 - SEAM : r.b0,
    b1: at(r.b1, bounds.b1) ? r.b1 + SEAM : r.b1,
  }));
}

export function createRoomScene(
  container: HTMLElement,
  windowSide: WindowSide,
  room: RoomGeometry,
  win: WindowGeometry,
  view?: RoomView,
) {
  const { widthM: W, depthM: D, heightM: H } = room;
  // 部屋は x = -W/2〜W/2（右 = +x）、y = 0〜H、z = 0（鑑賞者側）〜 -D（スクリーン側の壁）
  const midZ = -D / 2;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a2f3a);

  // 鑑賞者の位置（部屋の幅の中央・目の高さ）から、スクリーン（奥の壁、-z）を正面に見る。画面の右 = 鑑賞者の右
  const eyeY = Math.min(1.5, H * 0.5);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 200);
  camera.position.copy(view?.camera ?? new THREE.Vector3(0, eyeY, D * 0.4));

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(view?.target ?? new THREE.Vector3(0, eyeY, -D));
  controls.maxPolarAngle = Math.PI * 0.6; // 水平（鑑賞者の目線）より少し見上げるところまで
  controls.minDistance = 1;
  controls.maxDistance = Math.max(W, D, H) * 4;
  controls.update();

  // ---- 白いボックス（sunabako 的な、継ぎ目のないホワイトボックス）----
  // 面はすべて室内側を向く片面。外から見ると裏面は描かれないので、手前の壁があっても室内が見える。
  // 影は外殻のすべての面が落とすので、光は窓の開口からだけ入る
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2f1ec, roughness: 0.92, metalness: 0 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xe9e8e2, roughness: 0.85, metalness: 0 });
  const addPanel = (w: number, h: number, pos: THREE.Vector3, rot: THREE.Euler, mat = wallMat): void => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.copy(pos);
    m.rotation.copy(rot);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  };
  const facingDown = new THREE.Euler(Math.PI / 2, 0, 0);
  const facingUp = new THREE.Euler(-Math.PI / 2, 0, 0);
  const sideRot = (sign: number): THREE.Euler => new THREE.Euler(0, sign > 0 ? -Math.PI / 2 : Math.PI / 2, 0); // 右の壁は -x、左の壁は +x を向く

  addPanel(W + SEAM * 2, D + SEAM * 2, new THREE.Vector3(0, 0, midZ), facingUp, floorMat); // 床
  addPanel(W + SEAM * 2, H + SEAM * 2, new THREE.Vector3(0, H / 2, -D), new THREE.Euler()); // 奥（スクリーン側）
  addPanel(W + SEAM * 2, H + SEAM * 2, new THREE.Vector3(0, H / 2, 0), new THREE.Euler(0, Math.PI, 0)); // 手前（鑑賞者側）

  // 側面の壁。窓のある側だけ開口を空ける。z は奥ほど小さいので、壁の上の位置 u = -z（0〜D）で考える
  const wallWinW = Math.min(win.widthM, D * 0.95);
  const wallWinY0 = Math.min(win.sillHeightM, H * 0.9);
  const wallWinY1 = Math.min(win.sillHeightM + win.heightM, H * 0.98);
  for (const sign of [1, -1]) {
    const x = (sign * W) / 2;
    const hasWindow = (windowSide === 'right' && sign > 0) || (windowSide === 'left' && sign < 0);
    const hole = hasWindow
      ? { a0: D / 2 - wallWinW / 2, a1: D / 2 + wallWinW / 2, b0: wallWinY0, b1: wallWinY1 }
      : null;
    const bounds = { a0: 0, a1: D, b0: 0, b1: H };
    const parts = growOuterEdges(hole ? frameAround(0, D, 0, H, hole) : [bounds], bounds);
    for (const r of parts) {
      addPanel(r.a1 - r.a0, r.b1 - r.b0, new THREE.Vector3(x, (r.b0 + r.b1) / 2, -(r.a0 + r.a1) / 2), sideRot(sign));
    }
  }

  // 天井。天窓のときは中央に開口を空ける（幅 = 左右、高さ = 奥行き方向）
  {
    const skyW = Math.min(win.widthM, W * 0.95);
    const skyD = Math.min(win.heightM, D * 0.95);
    const hole = windowSide === 'ceiling' ? { a0: -skyW / 2, a1: skyW / 2, b0: D / 2 - skyD / 2, b1: D / 2 + skyD / 2 } : null;
    const bounds = { a0: -W / 2, a1: W / 2, b0: 0, b1: D };
    const parts = growOuterEdges(hole ? frameAround(-W / 2, W / 2, 0, D, hole) : [bounds], bounds);
    for (const r of parts) {
      addPanel(r.a1 - r.a0, r.b1 - r.b0, new THREE.Vector3((r.a0 + r.a1) / 2, H, -(r.b0 + r.b1) / 2), facingDown);
    }
  }

  // スクリーン（投影面、32:9）の目印。寸法は未計測なので、奥の壁に収まる大きさで置く
  const screenW = Math.min(W * 0.8, (H * 0.7 * 32) / 9);
  const screenH = (screenW * 9) / 32;
  const screenMat = new THREE.MeshStandardMaterial({ color: 0x9aa3b5, roughness: 0.6, metalness: 0 });
  const screenPanel = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH), screenMat);
  screenPanel.position.set(0, Math.max(screenH / 2 + 0.2, eyeY), -D + 0.01);
  screenPanel.receiveShadow = true;
  scene.add(screenPanel);

  // ---- 光 ----
  // 環境光：空の色を反映するヘミスフィアライト（常に最低限の明るさは保つ）
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.35);
  scene.add(hemi);

  // 太陽：スポットライトで表現し、窓の開口を通して部屋に差し込む（影は外殻がさえぎる）
  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(0, H * 0.3, midZ);
  scene.add(sunTarget);

  const far = Math.max(W, D, H) * 3;
  // 光の円錐は部屋全体をちょうど覆う角度にする（広すぎるとシャドウマップの解像度が部屋の外に割かれ、影の縁が粗くなる）
  const coneAngle = Math.atan(Math.hypot(W, D, H) / 2 / far) * 1.15;
  // decay=0：太陽は部屋に対して十分遠いので、距離による減衰はつけない（現実の日差しに近い）
  const spot = new THREE.SpotLight(0xffffff, 0, 0, coneAngle, 0.1, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.bias = -0.00005;
  spot.shadow.normalBias = 0.02;
  spot.shadow.camera.near = far * 0.2;
  spot.shadow.camera.far = far * 2.2;
  spot.target = sunTarget;
  scene.add(spot);

  function resize(): void {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  function update(input: RoomInput): void {
    const { light, sun } = input.solar;
    // light.{x,y,z} は「光が進んでいく向き」。太陽のある方向はその逆
    const sunDir = toThree(light).negate();
    if (sunDir.lengthSq() < 1e-9) sunDir.set(0, 1, 0);
    sunDir.normalize();
    spot.position.copy(sunTarget.position).addScaledVector(sunDir, far);

    spot.intensity = light.entersWindow ? input.lit * SUN_INTENSITY : 0;
    spot.color.copy(rgb(input.lightColor));

    // 環境光は太陽高度が高いほど強く、夜でも部屋の形が見える最低限は保つ
    const altT = Math.max(0, Math.min(1, sun.altitude / 45));
    hemi.intensity = 0.12 + 0.35 * altT;
    hemi.color.copy(rgb(input.sky.top));
    hemi.groundColor.copy(rgb(input.sky.bottom));

    // 窓の外は、空の色（明るさ）が見えるようにする（真っ黒の穴に見えないように）
    (scene.background as THREE.Color).copy(rgb(input.sky.top));
  }

  function currentView(): RoomView {
    return { camera: camera.position.clone(), target: controls.target.clone() };
  }

  function dispose(): void {
    controls.dispose();
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const m = obj.material;
        for (const mat of Array.isArray(m) ? m : [m]) mat.dispose();
      }
    });
    renderer.dispose();
    renderer.forceContextLoss(); // 作り直しを繰り返しても WebGL コンテキストが溜まらないように
    container.removeChild(renderer.domElement);
  }

  return { scene, camera, renderer, controls, update, resize, currentView, dispose };
}
