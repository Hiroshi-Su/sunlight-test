// room モード：仮想のホワイトボックスの部屋に、計算した日差しを環境光とスポットライトとして再現する。
//
// 部屋の向きは src/solar.ts の light.{x,y,z}（screen 座標：x = 鑑賞者から見て右、y = 上、z = スクリーンの奥）に合わせる。
// ただし screen 座標は左手系、three.js は右手系なので、そのまま載せると左右が反転する。
// three.js 側では「スクリーンの奥 = -z」とし、z の符号だけ反転して使う（toThree）。
// 窓の位置・緯度経度が変わっても、この対応は変わらない（方位の変換は resolveSite 側で済んでいる）。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { RGB } from '../palette.ts';
import type { Site, SolarState } from '../solar.ts';

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

// input の色は sRGB 表記の 0〜1（他のシーンと共通の palette.ts 由来）。
// three.js の色管理（既定で有効）は数値引数を作業色空間＝linear-sRGB として扱うため、変換してから渡す
const rgb = (c: RGB): THREE.Color => new THREE.Color(c[0], c[1], c[2]).convertSRGBToLinear();

/** screen 座標（左手系）→ three.js（右手系）。スクリーンの奥を -z にする */
export const toThree = (v: { x: number; y: number; z: number }): THREE.Vector3 => new THREE.Vector3(v.x, v.y, -v.z);

// 「日差しで光条が輝く」の既定値と同じ考え方：太陽が入る間だけ、この強さまで lit に比例して立ち上がる
const SUN_INTENSITY = 6;

export function createRoomScene(container: HTMLElement, site: Pick<Site, 'windowSide'>, room: RoomGeometry, win: WindowGeometry) {
  const { widthM: W, depthM: D, heightM: H } = room;
  const wallSign = site.windowSide === 'right' ? 1 : -1; // 窓のある壁の x 符号（右 = +x）
  // 部屋は z = 0（鑑賞者側、開いている）〜 z = -D（スクリーン側の壁）
  const midZ = -D / 2;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a2f3a);

  // 鑑賞者の位置（部屋の幅の中央・目の高さ）から、スクリーン（奥の壁、-z）を正面に見る。画面の右 = 鑑賞者の右
  const eyeY = Math.min(1.5, H * 0.5);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 200);
  const controlsTarget = new THREE.Vector3(0, eyeY, -D);
  camera.position.set(0, eyeY, D * 0.4);
  camera.lookAt(controlsTarget);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(controlsTarget);
  controls.maxPolarAngle = Math.PI * 0.6; // 水平（鑑賞者の目線）より少し見上げるところまで
  controls.minDistance = 1;
  controls.maxDistance = Math.max(W, D, H) * 4;
  controls.update();

  // ---- 白いボックス（sunabako 的な、継ぎ目のないホワイトボックス）----
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2f1ec, roughness: 0.92, metalness: 0 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xe9e8e2, roughness: 0.85, metalness: 0 });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, midZ);
  floor.receiveShadow = true;
  scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), wallMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, H, midZ);
  ceiling.receiveShadow = true;
  scene.add(ceiling);

  // 奥（スクリーン側）の壁。面は鑑賞者側（+z）を向く
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat);
  back.position.set(0, H / 2, -D);
  back.receiveShadow = true;
  scene.add(back);

  // スクリーン（投影面、32:9）の目印。寸法は未計測なので、奥の壁に収まる大きさで置く
  const screenW = Math.min(W * 0.8, (H * 0.7 * 32) / 9);
  const screenH = (screenW * 9) / 32;
  const screenMat = new THREE.MeshStandardMaterial({ color: 0x9aa3b5, roughness: 0.6, metalness: 0 });
  const screenPanel = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH), screenMat);
  screenPanel.position.set(0, Math.max(screenH / 2 + 0.2, Math.min(1.5, H * 0.5)), -D + 0.01);
  screenPanel.receiveShadow = true;
  scene.add(screenPanel);

  // 側面の壁の向き：右の壁（+x）は -x を、左の壁（-x）は +x を向く
  const sideRotY = (sign: number): number => (sign > 0 ? -Math.PI / 2 : Math.PI / 2);

  // 窓と反対側の壁（無地）
  const blankWall = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat);
  blankWall.position.set(-wallSign * W / 2, H / 2, midZ);
  blankWall.rotation.y = sideRotY(-wallSign);
  blankWall.receiveShadow = true;
  scene.add(blankWall);

  // 窓のある壁：窓の開口ぶんを空けた 4 枚（上・下・手前・奥）で構成する。窓は壁の奥行きの中央
  const winY0 = win.sillHeightM;
  const winY1 = win.sillHeightM + win.heightM;
  const winNear = midZ + win.widthM / 2; // 鑑賞者側の窓の端（z は奥ほど小さい）
  const winFar = midZ - win.widthM / 2; // スクリーン側の窓の端
  const addWallPanel = (zA: number, zB: number, yA: number, yB: number): void => {
    const sizeZ = Math.abs(zA - zB), sizeY = yB - yA;
    if (sizeZ <= 1e-6 || sizeY <= 1e-6) return;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(sizeZ, sizeY), wallMat);
    panel.position.set(wallSign * W / 2, (yA + yB) / 2, (zA + zB) / 2);
    panel.rotation.y = sideRotY(wallSign);
    panel.receiveShadow = true;
    panel.castShadow = true;
    scene.add(panel);
  };
  addWallPanel(0, -D, winY1, H); // 窓の上
  addWallPanel(0, -D, 0, winY0); // 窓の下
  addWallPanel(0, winNear, winY0, winY1); // 窓の手前側
  addWallPanel(winFar, -D, winY0, winY1); // 窓の奥側

  // ---- 光 ----
  // 環境光：空の色を反映するヘミスフィアライト（常に最低限の明るさは保つ）
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.35);
  scene.add(hemi);

  // 太陽：スポットライトで表現し、窓の開口を通して部屋に差し込む（影は壁がさえぎる）
  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(0, H * 0.3, midZ);
  scene.add(sunTarget);

  const far = Math.max(W, D, H) * 3;
  // decay=0：太陽は部屋に対して十分遠いので、距離による減衰はつけない（現実の日差しに近い）
  // 光の円錐は部屋全体をちょうど覆う角度にする（広すぎるとシャドウマップの解像度が部屋の外に割かれ、影の縁が粗くなる）
  const coneAngle = Math.atan(Math.hypot(W, D, H) / 2 / far) * 1.15;
  const spot = new THREE.SpotLight(0xffffff, 0, 0, coneAngle, 0.1, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.bias = -0.0005;
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

  function dispose(): void {
    controls.dispose();
    renderer.dispose();
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const m = obj.material;
        for (const mat of Array.isArray(m) ? m : [m]) mat.dispose();
      }
    });
    container.removeChild(renderer.domElement);
  }

  return { scene, camera, renderer, controls, update, resize, dispose };
}
