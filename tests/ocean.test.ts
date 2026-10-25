import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OCEAN_CASCADES, OCEAN_LODS, OCEAN_N, OCEAN_PERIOD_S, buildOceanSpectrum } from '../src/room/ocean.ts';

const N = OCEAN_N;
const n2 = N * N;
const spec = buildOceanSpectrum({ windMS: 6, dirX: 1, dirZ: 0, heightScale: 1 });

test('FFT の海：高さの標準偏差は Hs / 4（Hs = 0.21 × 風速² / g）に合う', () => {
  const hs = (0.21 * 36) / 9.81;
  assert.ok(Math.abs(spec.rmsHeight - hs / 4) < 1e-9);
  let variance = 0;
  for (let i = 0; i < spec.h0.length / 4; i++) variance += spec.h0[i * 4]! ** 2 + spec.h0[i * 4 + 1]! ** 2 + spec.h0[i * 4 + 2]! ** 2 + spec.h0[i * 4 + 3]! ** 2;
  assert.ok(Math.abs(Math.sqrt(variance) - hs / 4) / (hs / 4) < 1e-4);
});

test('FFT の海：h0 の後ろ 2 つは conj(h0(−k))（逆変換で実数の海面になる）', () => {
  for (const [x, y] of [[3, 5], [200, 17], [128, 1]] as const) {
    const i = y * N + x;
    const m = ((N - y) % N) * N + ((N - x) % N);
    assert.equal(spec.h0[i * 4 + 2], spec.h0[m * 4]);
    assert.equal(spec.h0[i * 4 + 3], -spec.h0[m * 4 + 1]!);
  }
});

test('FFT の海：2 枚はそれぞれの波数の範囲だけを持ち、風上へ向かう波は弱い', () => {
  OCEAN_CASCADES.forEach((c, ci) => {
    const dk = (2 * Math.PI) / c.sizeM;
    for (let y = 0; y < N; y += 7) {
      for (let x = 0; x < N; x += 7) {
        const kx = (x < N / 2 ? x : x - N) * dk;
        const kz = (y < N / 2 ? y : y - N) * dk;
        const k = Math.hypot(kx, kz);
        const i = ci * n2 + y * N + x;
        if (k <= c.kMin || k > c.kMax) assert.equal(spec.h0[i * 4], 0);
      }
    }
  });
  // 風下（+x）と風上（−x）の同じ大きさの波：平均の振幅を比べる
  let down = 0;
  let up = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 2; x < 20; x++) {
      const a = (yy: number, xx: number): number => Math.hypot(spec.h0[(yy * N + xx) * 4]!, spec.h0[(yy * N + xx) * 4 + 1]!);
      down += a(y, x);
      up += a(y, N - x);
    }
  }
  assert.ok(up < down * 0.4);
});

test('FFT の海：角振動数は周期の倍数にそろい、描ききれない傾きは段が粗いほど増える', () => {
  const w0 = (2 * Math.PI) / OCEAN_PERIOD_S;
  for (let i = 0; i < spec.omega.length; i += 997) assert.ok(Math.abs(spec.omega[i]! / w0 - Math.round(spec.omega[i]! / w0)) < 1e-3);
  for (let c = 0; c < OCEAN_CASCADES.length; c++) {
    for (let lod = 1; lod < OCEAN_LODS; lod++) {
      assert.ok(spec.unresolvedMss[c * OCEAN_LODS + lod]! >= spec.unresolvedMss[c * OCEAN_LODS + lod - 1]!);
    }
  }
});
