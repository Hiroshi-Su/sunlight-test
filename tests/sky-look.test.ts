import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acesInverse } from '../src/room/model.ts';

const aces = (x: number): number => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));

test('空の見え方「選んだ色のまま」：仕上げ（ACES）の逆をたどると、仕上げの後に元の値に戻る', () => {
  for (const y of [0, 0.001, 0.02, 0.1, 0.3, 0.5, 0.8, 0.95]) {
    assert.ok(Math.abs(aces(acesInverse(y)) - y) < 1e-9, `y ${y}`);
  }
  assert.equal(acesInverse(0), 0);
  // 1 に近い値は 0.98 で止める（無限に大きくならない）
  assert.ok(Number.isFinite(acesInverse(1)) && Math.abs(aces(acesInverse(1)) - 0.98) < 1e-9);
});
