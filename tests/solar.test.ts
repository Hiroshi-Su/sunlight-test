import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseSiteConfig } from '../src/config.ts';
import { type LightOnScreen, lightOnScreen, resolveSite, sunPosition, withWindowSide } from '../src/solar.ts';

interface Fixtures {
  source: string;
  site: { latitude: number; longitude: number; facingAzimuth: number; windowAzimuth: number };
  cases: {
    utc: string;
    local: string;
    azimuth: number;
    altitude: number;
    screen: Pick<LightOnScreen, 'x' | 'y' | 'z' | 'windowIncidence' | 'entersWindow'>;
  }[];
}

const fx = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as Fixtures;
const site = { ...fx.site, rightAzimuth: (fx.site.facingAzimuth + 90) % 360 };
const TOL_DEG = 0.03;
const angDiff = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

test('太陽位置が NREL SPA と一致する', () => {
  let maxAz = 0, maxAlt = 0;
  for (const c of fx.cases) {
    const s = sunPosition(new Date(c.utc), site.latitude, site.longitude);
    const dAlt = Math.abs(s.altitude - c.altitude);
    // 天頂付近では方位角が不安定なので、水平方向の距離で評価する
    const dAz = angDiff(s.azimuth, c.azimuth) * Math.cos(c.altitude * Math.PI / 180);
    maxAz = Math.max(maxAz, dAz);
    maxAlt = Math.max(maxAlt, dAlt);
    assert.ok(dAlt < TOL_DEG, `${c.local} altitude ${s.altitude} vs ${c.altitude}`);
    assert.ok(dAz < TOL_DEG, `${c.local} azimuth ${s.azimuth} vs ${c.azimuth}`);
  }
  console.log(`  max |Δaz·cos(alt)|=${maxAz.toFixed(4)}°  max |Δalt|=${maxAlt.toFixed(4)}°  (${fx.cases.length} cases)`);
});

test('スクリーン座標変換がベクトル射影と一致する', () => {
  for (const c of fx.cases) {
    const l = lightOnScreen({ azimuth: c.azimuth, altitude: c.altitude }, site);
    for (const k of ['x', 'y', 'z', 'windowIncidence'] as const) {
      assert.ok(Math.abs(l[k] - c.screen[k]) < 1e-9, `${c.local} ${k}: ${l[k]} vs ${c.screen[k]}`);
    }
    assert.equal(l.entersWindow, c.screen.entersWindow, `${c.local} entersWindow`);
  }
});

test('向きの直感チェック（右窓）', () => {
  const s = { ...site, windowAzimuth: (site.facingAzimuth + 90) % 360 };
  // 窓の正面から高度30°で差す → 光は左下へ、窓から入る
  const l = lightOnScreen({ azimuth: s.windowAzimuth, altitude: 30 }, s);
  assert.ok(l.x < -0.8 && l.y < 0 && Math.abs(l.z) < 1e-9 && l.entersWindow);
  // 鑑賞者の背後から → 光はスクリーンの奥へ（z>0）、左右成分なし
  const b = lightOnScreen({ azimuth: (s.facingAzimuth + 180) % 360, altitude: 30 }, s);
  assert.ok(b.z > 0.8 && Math.abs(b.x) < 1e-9);
  // 窓と反対側の太陽 → 入らない
  const o = lightOnScreen({ azimuth: (s.windowAzimuth + 180) % 360, altitude: 30 }, s);
  assert.equal(o.entersWindow, false);
});

test('天窓：入射は太陽高度の sin、方位によらず太陽が出ていれば入る', () => {
  const s = { ...site, windowSide: 'ceiling' as const };
  for (const az of [0, 90, 180, 270]) {
    const l = lightOnScreen({ azimuth: az, altitude: 30 }, s);
    assert.ok(Math.abs(l.windowIncidence - 0.5) < 1e-12, `az ${az}: ${l.windowIncidence}`);
    assert.equal(l.entersWindow, true);
  }
  assert.equal(lightOnScreen({ azimuth: 180, altitude: -5 }, s).entersWindow, false);
  // 光の向き（x, y, z）は窓の位置によらない
  const wallLight = lightOnScreen({ azimuth: 200, altitude: 40 }, site);
  const skyLight = lightOnScreen({ azimuth: 200, altitude: 40 }, s);
  for (const k of ['x', 'y', 'z'] as const) assert.equal(skyLight[k], wallLight[k]);
});

test('config の解決（磁北→真北、窓の左右）', () => {
  const cfg = parseSiteConfig(JSON.parse(readFileSync(new URL('../config/site.json', import.meta.url), 'utf8')));
  const base = cfg.sites[cfg.activeSite]!;
  const r = resolveSite({
    activeSite: 'x',
    sites: { x: { ...base, screen: { facingAzimuth: 66, azimuthReference: 'magnetic', magneticDeclination: -7.5 }, window: { ...base.window, side: 'right', facingAzimuth: null } } },
  });
  assert.equal(r.facingAzimuth, 58.5);
  assert.equal(r.windowAzimuth, 148.5);
  const l = resolveSite({
    activeSite: 'x',
    sites: { x: { ...base, screen: { facingAzimuth: 10, azimuthReference: 'true', magneticDeclination: -7.5 }, window: { ...base.window, side: 'left', facingAzimuth: null } } },
  });
  assert.equal(l.facingAzimuth, 10);
  assert.equal(l.windowAzimuth, 280);
});

test('窓の位置の切り替え：窓の外向きも位置に合わせて変わる', () => {
  const cfg = parseSiteConfig(JSON.parse(readFileSync(new URL('../config/site.json', import.meta.url), 'utf8')));
  const right = resolveSite(cfg); // 検証場所は右窓（外向き 148.5°）
  const left = withWindowSide(right, 'left');
  assert.equal(left.windowAzimuth, 328.5);
  assert.equal(withWindowSide(left, 'right').windowAzimuth, 148.5);
  // 冬至 10 時ごろの太陽（方位 154.7°・高度 26.4°）は右側にあるので、右窓からは入り、左窓からは入らない
  const sun = { azimuth: 154.7, altitude: 26.4 };
  assert.equal(lightOnScreen(sun, right).entersWindow, true);
  assert.equal(lightOnScreen(sun, left).entersWindow, false);
  assert.equal(lightOnScreen(sun, withWindowSide(right, 'ceiling')).entersWindow, true);
});
