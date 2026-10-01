import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_WARP, squareToQuad, warpCss } from '../src/ui/warp.ts';

const apply = (m: number[], x: number, y: number): [number, number] => {
  const w = m[6]! * x + m[7]! * y + m[8]!;
  return [(m[0]! * x + m[1]! * y + m[2]!) / w, (m[3]! * x + m[4]! * y + m[5]!) / w];
};

test('四隅の位置合わせ：単位正方形の四隅が、指定した四角形の四隅に写る', () => {
  const q: [number, number][] = [[10, 5], [300, 20], [280, 210], [-5, 190]];
  const m = squareToQuad(q);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([x, y], i) => {
    const [px, py] = apply(m, x!, y!);
    assert.ok(Math.abs(px - q[i]![0]) < 1e-9 && Math.abs(py - q[i]![1]) < 1e-9);
  });
});

test('四隅の位置合わせ：ずらさなければ変形しない', () => {
  assert.equal(warpCss(1920, 540, NO_WARP), '');
  assert.match(warpCss(1920, 540, [[0.01, 0], [0, 0], [0, 0], [0, 0]]), /^matrix3d\(/);
});
