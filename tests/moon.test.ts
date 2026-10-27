import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moonEcliptic, moonPosition } from '../src/moon.ts';
import { moonLightCurve, moonPhaseBrightness, moonSkyCurve } from '../src/room/model.ts';

test('月の黄経・黄緯・距離：Meeus 例題 47.a（1992 年 4 月 12 日 0 時）に 0.3° 以内', () => {
  // 例題の答え：λ = 133.162655°、β = −3.229126°、距離 368409.7 km
  const jd = 2448724.5;
  const m = moonEcliptic(jd - 2451545.0);
  assert.ok(Math.abs(m.lambda - 133.162655) < 0.3, `λ = ${m.lambda}`);
  assert.ok(Math.abs(m.beta - -3.229126) < 0.3, `β = ${m.beta}`);
  assert.ok(Math.abs(m.distanceKm - 368409.7) < 1500, `距離 = ${m.distanceKm}`);
});

test('月の満ち欠け：満月はほぼ 1、新月はほぼ 0、半月は明るさが満月の約 1/10', () => {
  // 2024 年 1 月 25 日 17:54 UTC 満月、1 月 11 日 11:57 UTC 新月、1 月 18 日 03:53 UTC 上弦
  const full = moonPosition(new Date(Date.UTC(2024, 0, 25, 17, 54)), 51.5, -0.1);
  const nw = moonPosition(new Date(Date.UTC(2024, 0, 11, 11, 57)), 51.5, -0.1);
  const half = moonPosition(new Date(Date.UTC(2024, 0, 18, 3, 53)), 51.5, -0.1);
  assert.ok(full.illumination > 0.99, `満月 ${full.illumination}`);
  assert.ok(nw.illumination < 0.01, `新月 ${nw.illumination}`);
  assert.ok(Math.abs(half.illumination - 0.5) < 0.05, `上弦 ${half.illumination}`);
  assert.ok(half.brightness > 0.05 && half.brightness < 0.15, `上弦の明るさ ${half.brightness}`);
  assert.ok(Math.abs(full.brightness - 1) < 0.05);
});

test('月の位置：満月の真夜中は南の空に高く、満月の正午は地平線の下', () => {
  // ロンドン（北緯 51.5°・西経 0.1°）、2024 年 1 月 26 日 0 時 UTC（満月の約 6 時間後）は、満月が南の空に近い
  const night = moonPosition(new Date(Date.UTC(2024, 0, 26, 0, 0)), 51.5, -0.1);
  assert.ok(night.altitude > 45, `高度 ${night.altitude}`);
  assert.ok(Math.abs(night.azimuth - 180) < 25, `方位 ${night.azimuth}`);
  const noon = moonPosition(new Date(Date.UTC(2024, 0, 26, 12, 0)), 51.5, -0.1);
  assert.ok(noon.altitude < 0, `正午の高度 ${noon.altitude}`);
});

test('夜空の明るさの割合（realSky）：満月 1、30°・60° は決めた値、半月以降と月が出ていないときは下限', () => {
  const c = { d30: 0.69, d60: 0.43, floor: 0.35 };
  assert.equal(moonSkyCurve(c, 0, true), 1);
  assert.ok(Math.abs(moonSkyCurve(c, 30, true) - 0.69) < 1e-12);
  assert.ok(Math.abs(moonSkyCurve(c, 45, true) - 0.56) < 1e-12);
  assert.ok(Math.abs(moonSkyCurve(c, 60, true) - 0.43) < 1e-12);
  assert.equal(moonSkyCurve(c, 90, true), 0.35);
  assert.equal(moonSkyCurve(c, 180, true), 0.35);
  assert.equal(moonSkyCurve(c, 0, false), 0.35);
  assert.ok(Math.abs(moonPhaseBrightness(90) - 0.091) < 1e-3);
});

test('月の光の割合（realFloor）：段階ごとの値を直線でつなぎ、細い月・新月は下限。月が出ていないときは 0', () => {
  const c = { d30: 0.77, d60: 0.6, d90: 0.51, d120: 0.47, floor: 0.35 };
  assert.equal(moonLightCurve(c, 0, true), 1);
  assert.ok(Math.abs(moonLightCurve(c, 30, true) - 0.77) < 1e-12);
  assert.ok(Math.abs(moonLightCurve(c, 75, true) - 0.555) < 1e-12);
  assert.ok(Math.abs(moonLightCurve(c, 120, true) - 0.47) < 1e-12);
  assert.ok(Math.abs(moonLightCurve(c, 150, true) - 0.35) < 1e-12);
  assert.ok(Math.abs(moonLightCurve(c, 180, true) - 0.35) < 1e-12);
  assert.equal(moonLightCurve(c, 0, false), 0);
});
