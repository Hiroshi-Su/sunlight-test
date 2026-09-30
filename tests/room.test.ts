import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { cloudFlowDir, toThree, windowRect } from '../src/room/scene.ts';
import { lightOnScreen } from '../src/solar.ts';

test('room：screen 座標（左手系）を three.js（右手系）へ左右反転せずに移す', () => {
  const right = toThree({ x: 1, y: 0, z: 0 });
  const up = toThree({ x: 0, y: 1, z: 0 });
  const forward = toThree({ x: 0, y: 0, z: 1 }); // スクリーンの奥
  // three.js のカメラは -z を向き、右 × 上 = 後ろ（+z）。スクリーンを向いたとき右が +x になっている
  const back = new THREE.Vector3().crossVectors(right, up);
  assert.ok(back.distanceTo(forward.clone().negate()) < 1e-12);
});

test('room：右窓の正面にある太陽は、部屋の右（+x、窓の壁）側にある', () => {
  const site = { facingAzimuth: 58.5, rightAzimuth: 148.5, windowAzimuth: 148.5 };
  const light = lightOnScreen({ azimuth: site.windowAzimuth, altitude: 30 }, site);
  const sunDir = toThree(light).negate();
  assert.ok(light.entersWindow);
  assert.ok(sunDir.x > 0.8, `sunDir.x = ${sunDir.x}`);
  assert.ok(sunDir.y > 0);
});

test('窓の範囲：大きさの変更がそのまま反映され、部屋からはみ出す分は切り詰める', () => {
  const room = { widthM: 10, depthM: 6, heightM: 3.2 };
  // 壁の窓：奥行きの中央（z = -3）に幅 2m、床から 0.5〜2.0m
  assert.deepEqual(windowRect('right', room, { widthM: 2, heightM: 1.5, sillHeightM: 0.5 }), [-4, -2, 0.5, 2]);
  // 幅は奥行きの 95%、上端は天井高の 98% まで
  const [z0, z1, , y1] = windowRect('left', room, { widthM: 99, heightM: 99, sillHeightM: 0.4 });
  assert.ok(Math.abs(z1 - z0 - 6 * 0.95) < 1e-9);
  assert.ok(Math.abs(y1 - 3.2 * 0.98) < 1e-9);
  // 天窓：天井の中央に 幅（左右）× 奥行き
  assert.deepEqual(windowRect('ceiling', room, { widthM: 4, heightM: 2, sillHeightM: 0.4 }), [-2, 2, -4, -2]);
});

test('雲の流れる向き：風が吹いてくる方位から、部屋の座標での向きへ', () => {
  const near = (a: { x: number; z: number }, x: number, z: number): boolean => Math.abs(a.x - x) < 1e-9 && Math.abs(a.z - z) < 1e-9;
  // スクリーンが東向き（90°）で西風（270°）：雲は東へ＝スクリーンの方（-z）へ流れる
  assert.ok(near(cloudFlowDir(270, 90), 0, -1));
  // スクリーンが北向き（0°）で西風：雲は東＝鑑賞者の右（+x）へ
  assert.ok(near(cloudFlowDir(270, 0), 1, 0));
  // 検証場所（スクリーン 58.5°）で西風：東（90°）はスクリーンから右へ 31.5°
  const r = (31.5 * Math.PI) / 180;
  assert.ok(near(cloudFlowDir(270, 58.5), Math.sin(r), -Math.cos(r)));
});
