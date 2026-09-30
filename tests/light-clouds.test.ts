import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lightClouds } from '../src/scenes/light-clouds.ts';
import { type SceneInput, defaultParams } from '../src/scenes/types.ts';

const input = (time: number): SceneInput => ({
  sun: { azimuth: 150, altitude: 30 } as SceneInput['sun'],
  light: { dirX: -0.9, dirY: -0.4 } as SceneInput['light'],
  lit: 1, kelvin: 5500, lightColor: [1, 0.9, 0.8], sky: { top: [0.2, 0.3, 0.5], bottom: [0.4, 0.4, 0.5] },
  localMinutes: 600, time, dt: 1 / 60, width: 3840, height: 1080,
});

test('光の雲：何時間動かしても雲の動きの量は上限内に収まり、巻き戻しのつなぎ目で見た目が飛ばない', () => {
  const inst = lightClouds.create({ width: 3840, height: 1080 });
  const params = { ...defaultParams(lightClouds), evolve: 5, flow: 5 };
  const u = inst.pass.uniforms;
  // 見えている雲 = A と B を重み uBlend で混ぜたもの（0 なら A だけ、1 なら B だけ）
  let prevBlend = 0, blends = 0, maxAbs = 0;
  let prev: number[] = [];
  for (let f = 1; f <= 4 * 60 * 45; f += 1) { // 45 分ぶん（0.25 秒ごと。形の変化を 5 倍速にしているので約 3 回巻き戻る）
    inst.update(input(f * 0.25), params);
    const w = u['uBlend']!.value as number;
    const a = u['uOffA']!.value.toArray() as number[];
    maxAbs = Math.max(maxAbs, ...a.map(Math.abs));
    if (prevBlend > 0 && w === 0) {
      blends++;
      // 移り終えた直後の A は、直前の B とほぼ同じ（1 フレームぶんの動きだけ違う）
      const d = Math.hypot(...a.map((v, i) => v - prev[i]!));
      assert.ok(d < 0.1, `巻き戻しで ${d} 飛んだ`);
    }
    prev = u['uOffB']!.value.toArray();
    prevBlend = w;
  }
  assert.ok(blends >= 1, '巻き戻しが起きていない');
  assert.ok(maxAbs < 260, `動きの量が大きくなりすぎた: ${maxAbs}`);
  inst.dispose();
});
