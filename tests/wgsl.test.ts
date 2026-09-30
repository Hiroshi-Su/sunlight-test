import assert from 'node:assert/strict';
import { test } from 'node:test';

// node には画像の読み込み（document）と URL（location）がないので、映像を作るのに要る最小限だけ用意する
const g = globalThis as Record<string, unknown>;
g['location'] ??= { search: '' };
g['document'] ??= {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {}, set src(_v: string) {} }),
};

const { SCENES } = await import('../src/scenes/index.ts');
const { RoomCore } = await import('../src/room/core.ts');
const { ROOM_WGSL } = await import('../src/room/gpu.ts');

/** WGSL の中で読んでいる値の名前（u.名前） */
const reads = (wgsl: string): Set<string> => new Set([...wgsl.matchAll(/\bu\.(\w+)/g)].map((m) => m[1]!));

test('WebGPU：すべての映像に WGSL があり、読んでいる値（u.名前）はすべて JavaScript 側にある', () => {
  for (const def of SCENES) {
    const inst = def.create({ width: 3840, height: 1080 });
    const { wgsl, uniforms } = inst.pass;
    assert.match(wgsl, /fn frag\(p: vec2f\) -> vec3f/, `${def.id}：fn frag がない`);
    for (const name of reads(wgsl)) {
      assert.ok(name in uniforms || name === 'viewSize', `${def.id}：u.${name} が uniforms にない`);
    }
    // 画像は「名前」「名前_s」で読む
    for (const [name, u] of Object.entries(uniforms)) {
      if (u.value && typeof u.value === 'object' && 'isTexture' in u.value) assert.match(wgsl, new RegExp(`\\b${name}_s\\b`), `${def.id}：${name} を読んでいない`);
    }
    inst.dispose();
  }
});

test('WebGPU：room の 3 つの段階が読んでいる値は、すべて room の値（core）にある', () => {
  const core = new RoomCore('right', { widthM: 10, depthM: 6, heightM: 3.2 }, 58.5);
  const names = new Set(Object.keys({ ...core.shared, uCausOn: core.causOn, ...core.trace, ...core.display }));
  for (const [stage, wgsl] of Object.entries(ROOM_WGSL)) {
    for (const name of reads(wgsl)) assert.ok(names.has(name), `room の ${stage}：u.${name} が値にない`);
  }
});
