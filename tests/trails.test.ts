import assert from 'node:assert/strict';
import test from 'node:test';
import { Noise3, TrailSim } from '../src/room/trails-sim.ts';

const motion = { count: 64, points: 16, speed: 1.2, turbulence: 0.6, spread: 1, radiusM: 1.2, center: { x: 0, y: 1.6, z: -3 }, minY: 0.1, maxY: 3.1 };

test('光の軌跡：ノイズはなめらかで、おおよそ -1〜1', () => {
  const n = new Noise3(1);
  let max = 0;
  for (let i = 0; i < 2000; i++) {
    const v = n.noise(i * 0.137, i * 0.071 + 3, i * 0.019 - 2);
    max = Math.max(max, Math.abs(v));
    // 少しずらした所の値との差は小さい
    assert.ok(Math.abs(n.noise(i * 0.137 + 1e-3, i * 0.071 + 3, i * 0.019 - 2) - v) < 0.02);
  }
  assert.ok(max <= 1.2 && max > 0.3);
});

test('光の軌跡：長く動かしても、線は漂う範囲の近くにとどまる', () => {
  const sim = new TrailSim(64, 16);
  for (let f = 0; f < 60 * 120; f++) sim.step(motion, 1 / 60); // 2 分
  let far = 0;
  for (let i = 0; i < sim.positions.length; i += 3) {
    const d = Math.hypot(sim.positions[i]! - 0, sim.positions[i + 1]! - 1.6, sim.positions[i + 2]! + 3);
    far = Math.max(far, d);
  }
  assert.ok(far < motion.radiusM * 2.5, `中心から最大 ${far.toFixed(2)} m`);
});

test('光の軌跡：毎回、残りの点は 1 つ後ろへずれる', () => {
  const sim = new TrailSim(4, 8);
  sim.step(motion, 1 / 60);
  const head = Array.from(sim.positions.slice(0, 3));
  sim.step(motion, 1 / 60);
  assert.deepEqual(Array.from(sim.positions.slice(3, 6)), head);
});
