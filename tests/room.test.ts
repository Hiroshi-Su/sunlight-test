import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { toThree } from '../src/room/scene.ts';
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
