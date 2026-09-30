import assert from 'node:assert/strict';
import { test } from 'node:test';
import { airMass, directSunFactor, skyBrightness } from '../src/room/daylight.ts';

test('空気量：天頂で 1、低いほど大きく、地平線の下は無限大', () => {
  assert.ok(Math.abs(airMass(90) - 1) < 1e-3);
  assert.ok(Math.abs(airMass(30) - 2) < 0.01); // 高度 30° ではほぼ 1/sin h = 2
  assert.ok(airMass(5) > airMass(10) && airMass(10) > airMass(30));
  assert.equal(airMass(0), Infinity);
  assert.equal(airMass(-5), Infinity);
});

test('直射日光：天頂で約 0.7、太陽が低いほど弱く、沈むと 0', () => {
  assert.ok(Math.abs(directSunFactor(90) - 0.7) < 1e-3);
  assert.ok(Math.abs(directSunFactor(10) - 0.32) < 0.01);
  let prev = 0;
  for (let h = 1; h <= 90; h++) {
    const v = directSunFactor(h);
    assert.ok(v > prev, `高度 ${h}° で弱くなっている`);
    prev = v;
  }
  assert.equal(directSunFactor(0), 0);
  assert.equal(directSunFactor(-3), 0);
});

test('空の明るさ：夜は最低限、薄明で上がり、昼は太陽が高いほど明るい', () => {
  assert.equal(skyBrightness(-20), skyBrightness(-6));
  assert.ok(skyBrightness(-3) > skyBrightness(-6));
  assert.ok(Math.abs(skyBrightness(0) - 0.15) < 1e-9);
  assert.ok(skyBrightness(60) > skyBrightness(10));
  assert.ok(Math.abs(skyBrightness(90) - 1) < 1e-9);
});
