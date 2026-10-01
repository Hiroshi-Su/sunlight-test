import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeKnown, oneOf } from '../src/room/settings-file.ts';

test('room の設定の読み込み：既定と同じ種類の項目だけを使い、ほかは既定のまま', () => {
  const defaults = { a: 1, b: 'x', c: true, nested: { d: 2, e: [[0, 0], [0, 0]] }, list: [{ v: 1 }, { v: 2 }] };
  const raw = { a: 5, b: 3, c: 'yes', extra: 1, nested: { d: Infinity, e: [[0.1, 'q'], [0.2, 0.3]] }, list: [{ v: 9 }] };
  assert.deepEqual(mergeKnown(defaults, raw), {
    a: 5, b: 'x', c: true, nested: { d: 2, e: [[0.1, 0], [0.2, 0.3]] }, list: [{ v: 9 }, { v: 2 }],
  });
  assert.deepEqual(mergeKnown(defaults, null), defaults);
  assert.deepEqual(mergeKnown(defaults, 'broken'), defaults);
});

test('room の設定の読み込み：選択肢にない値は既定にする', () => {
  assert.equal(oneOf('fixed', ['free', 'fixed'] as const, 'free'), 'fixed');
  assert.equal(oneOf('weird', ['free', 'fixed'] as const, 'free'), 'free');
});
