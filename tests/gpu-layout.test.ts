import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { buildLayout, writeLayout } from '../src/gpu/layout.ts';

test('WebGPU の値の並べ方：型ごとの整列（WGSL の storage バッファの規則）どおりに並ぶ', () => {
  const u = {
    uA: { value: 1 },                                   // f32：0
    uB: { value: new THREE.Vector3(2, 3, 4) },          // vec3f：16 の倍数へ → 16
    uC: { value: 5 },                                   // f32：vec3f の残り 4 バイトに入る → 28
    uD: { value: new THREE.Vector2(6, 7) },             // vec2f：8 の倍数 → 32
    uE: { value: new Float32Array([8, 9, 10]) },        // array<f32, 3>：40
    uF: { value: [new THREE.Vector3(1, 1, 1), new THREE.Vector3(2, 2, 2)] }, // array<vec3f, 2>：16 の倍数 → 64、要素ごとに 16
    uG: { value: new THREE.Matrix4() },                 // mat4x4f：96
    tImage: { value: new THREE.Texture() },             // 画像は構造体に入れない
  };
  const layout = buildLayout(u, 'P', { viewSize: 'vec2f' });
  const at = Object.fromEntries(layout.fields.map((f) => [f.name, f.offset]));
  assert.deepEqual(at, { uA: 0, uB: 16, uC: 28, uD: 32, uE: 40, uF: 64, uG: 96, viewSize: 160 });
  assert.equal(layout.size, 176); // 最大の整列（16）の倍数
  assert.deepEqual(layout.textures, ['tImage']);
  assert.match(layout.wgsl, /uF: array<vec3f, 2>,/);

  const out = new Float32Array(layout.size / 4);
  writeLayout(layout, u, out, { viewSize: [3840, 1080] });
  assert.equal(out[0], 1);
  assert.deepEqual([...out.slice(4, 8)], [2, 3, 4, 5]);
  assert.deepEqual([...out.slice(8, 13)], [6, 7, 8, 9, 10]);
  assert.deepEqual([...out.slice(16, 19)], [1, 1, 1]);
  assert.deepEqual([...out.slice(20, 23)], [2, 2, 2]);
  assert.equal(out[24], 1); // 単位行列の左上
  assert.deepEqual([...out.slice(40, 42)], [3840, 1080]);
});
