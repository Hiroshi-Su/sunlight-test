import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { toThree, windowRect } from '../src/room/scene.ts';
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
