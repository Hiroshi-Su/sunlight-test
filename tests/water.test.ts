import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WAVE_COUNTS, angularFrequency, wavePhases } from '../src/room/water.ts';

const speed = (lambda: number): number => {
  const k = (2 * Math.PI) / lambda;
  return angularFrequency(k) / k; // 波の進む速さ（m/s）
};

test('水の波の速さ：長い波は √(gλ/2π)、いちばん遅いのは波長 1.7cm 付近で約 23cm/s', () => {
  assert.ok(Math.abs(speed(6) - Math.sqrt((9.81 * 6) / (2 * Math.PI))) < 0.01); // 6m の波 ≈ 3.06m/s
  assert.ok(Math.abs(speed(0.0171) - 0.231) < 0.003);
  assert.ok(speed(0.005) > speed(0.0171) && speed(0.1) > speed(0.0171)); // さざ波は表面張力で速くなる
});

test('波の位相：0〜2π に巻き戻され、数と並びが合っている', () => {
  for (const t of [0, 1.5, 3600 * 24 * 30]) {
    const ph = wavePhases(t);
    assert.equal(ph.pool.length, WAVE_COUNTS.pool);
    assert.equal(ph.sea.length, WAVE_COUNTS.sea);
    assert.equal(ph.fine.length, WAVE_COUNTS.fine);
    for (const v of [...ph.pool, ...ph.sea, ...ph.fine]) assert.ok(v >= 0 && v < 2 * Math.PI + 1e-6);
  }
});
