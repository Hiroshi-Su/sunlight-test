import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIGHTHOUSE_DEFAULTS, lighthouseProfile, lighthouseWeight } from '../src/room/model.ts';

const norm = (x: number, y: number, z: number): { x: number; y: number; z: number } => {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
};

test('灯台の光：帯の軸の向きで 1、広がりの半分の角度で約 6%、反対の向きで 0', () => {
  // 角度 0 の帯の向きは +z（手前）
  assert.ok(Math.abs(lighthouseProfile(norm(0, 0, 1), 0, 1, 6) - 1) < 1e-9);
  const edge = lighthouseProfile(norm(Math.sin((3 * Math.PI) / 180), 0, Math.cos((3 * Math.PI) / 180)), 0, 1, 6);
  assert.ok(Math.abs(edge - Math.exp(-1 / 0.36)) < 1e-3, `縁 ${edge}`);
  assert.ok(lighthouseProfile(norm(0, 0, -1), 0, 1, 6) < 1e-9);
  // 上下にずれても同じように弱まる
  const up = lighthouseProfile(norm(0, Math.sin((3 * Math.PI) / 180), Math.cos((3 * Math.PI) / 180)), 0, 1, 6);
  assert.ok(Math.abs(up - edge) < 1e-3);
});

test('灯台の光：上から見て時計回り（角度が増えると、帯は手前から左（−x）へ回る）、帯 2 本なら反対の向きにもある', () => {
  const a = Math.PI / 2;
  assert.ok(lighthouseProfile(norm(-1, 0, 0), a, 1, 6) > 0.999);
  assert.ok(lighthouseProfile(norm(1, 0, 0), a, 1, 6) < 1e-9);
  assert.ok(lighthouseProfile(norm(1, 0, 0), a, 2, 6) > 0.999);
});

test('灯台の点き具合：夜に点ける設定は、太陽の高度 0° で 0、−3° で半分、−6° 以下で 1', () => {
  const night = { ...LIGHTHOUSE_DEFAULTS, mode: 'night' as const };
  assert.equal(lighthouseWeight(night, 10), 0);
  assert.equal(lighthouseWeight(night, 0), 0);
  assert.equal(lighthouseWeight(night, -3), 0.5);
  assert.equal(lighthouseWeight(night, -20), 1);
  assert.equal(lighthouseWeight({ ...night, mode: 'always' }, 30), 1);
  assert.equal(lighthouseWeight({ ...night, mode: 'off' }, -20), 0);
});
