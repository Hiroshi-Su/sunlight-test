// room モード：仮想のホワイトボックスの部屋に、計算した日差しを環境光とスポットライトとして再現する。
//
// 部屋の座標系は src/solar.ts の light.{x,y,z}（screen 座標）とそろえてある：
// x = 鑑賞者から見て右（rightAzimuth 方向）、y = 上、z = スクリーン側（facingAzimuth 方向）。
// そのため、窓がどちら側にあっても・緯度経度が変わっても、light ベクトルをそのまま部屋の中の
// 太陽方向として使える（サイトごとの変換は resolveSite 側で既に済んでいるため）。
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

// 「日差しで光条が輝く」の既定値と同じ考え方：太陽が入る間だけ、この強さまで lit に比例して立ち上がる
const SUN_INTENSITY = 6;

export function createRoomScene(container: HTMLElement, site: Pick<Site, 'windowSide'>, room: RoomGeometry, win: WindowGeometry) {
  const { widthM: W, depthM: D, heightM: H } = room;
  const wallSign = site.windowSide === 'right' ? 1 : -1; // 窓のある壁の x 符号

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a2f3a);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  const controlsTarget = new THREE.Vector3(0, H * 0.5, D * 0.5);
  camera.position.set(-wallSign * W * 0.65, H * 1.15, -D * 0.7);
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
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 1;
  controls.maxDistance = Math.max(W, D, H) * 4;
  controls.update();

  // ---- 白いボックス（sunabako 的な、継ぎ目のないホワイトボックス）----
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2f1ec, roughness: 0.92, metalness: 0 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xe9e8e2, roughness: 0.85, metalness: 0 });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, D / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), wallMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, H, D / 2);
  ceiling.receiveShadow = true;
  scene.add(ceiling);

  // 奥（スクリーン側）の壁
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat);
  back.position.set(0, H / 2, D);
  back.rotation.y = Math.PI;
  back.receiveShadow = true;
  scene.add(back);

  // 窓と反対側の壁（無地）
  const blankWall = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat);
  blankWall.position.set(-wallSign * W / 2, H / 2, D / 2);
  blankWall.rotation.y = wallSign > 0 ? Math.PI / 2 : -Math.PI / 2;
  blankWall.receiveShadow = true;
  scene.add(blankWall);

  // 窓のある壁：窓の開口ぶんを空けた 4 枚（上・下・左右の柱）で構成する
  const winZ0 = D / 2 - win.widthM / 2;
  const winZ1 = D / 2 + win.widthM / 2;
  const winY0 = win.sillHeightM;
  const winY1 = win.sillHeightM + win.heightM;
  const windowWallX = wallSign * W / 2;
  const windowWallRotY = wallSign > 0 ? -Math.PI / 2 : Math.PI / 2;
  const addWallPanel = (centerZ: number, centerY: number, sizeZ: number, sizeY: number): void => {
    if (sizeZ <= 1e-6 || sizeY <= 1e-6) return;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(sizeZ, sizeY), wallMat);
    panel.position.set(windowWallX, centerY, centerZ);
    panel.rotation.y = windowWallRotY;
    panel.receiveShadow = true;
    panel.castShadow = true;
    scene.add(panel);
  };
  addWallPanel(D / 2, winY1 + (H - winY1) / 2, D, H - winY1); // 窓の上
  addWallPanel(D / 2, winY0 / 2, D, winY0); // 窓の下
  addWallPanel(winZ0 / 2, (winY0 + winY1) / 2, winZ0, winY1 - winY0); // 窓の手前側
  addWallPanel(winZ1 + (D - winZ1) / 2, (winY0 + winY1) / 2, D - winZ1, winY1 - winY0); // 窓の奥側

  // ---- 光 ----
  // 環境光：空の色を反映するヘミスフィアライト（常に最低限の明るさは保つ）
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.35);
  scene.add(hemi);

  // 太陽：スポットライトで表現し、窓の開口を通して部屋に差し込む（影は壁がさえぎる）
  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(0, H * 0.3, D * 0.5);
  scene.add(sunTarget);

  const far = Math.max(W, D, H) * 3;
  // decay=0：太陽は部屋に対して十分遠いので、距離による減衰はつけない（現実の日差しに近い）
  const spot = new THREE.SpotLight(0xffffff, 0, 0, Math.PI * 0.18, 0.4, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.camera.near = far * 0.2;
  spot.shadow.camera.far = far * 2.2;
  spot.target = sunTarget;
  scene.add(spot);
  scene.add(spot.target);

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
    // light.{x,y,z} は「光が進んでいく向き」。太陽の方向はその逆
    const sunDir = new THREE.Vector3(-light.x, -light.y, -light.z);
    if (sunDir.lengthSq() < 1e-9) sunDir.set(0, 1, 0);
    sunDir.normalize();
    spot.position.copy(sunTarget.position).addScaledVector(sunDir, far);

    const enters = light.entersWindow;
    spot.intensity = enters ? input.lit * SUN_INTENSITY : 0;
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
