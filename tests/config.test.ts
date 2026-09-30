import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ConfigError, parseAppConfig, parseSiteConfig, parseVisualsConfig } from '../src/config.ts';
import { SCENES } from '../src/scenes/index.ts';
import { mergeParams } from '../src/scenes/types.ts';

const readJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  assert.fail('ConfigError が投げられませんでした');
};

test('リポジトリの config は検証を通る', () => {
  assert.doesNotThrow(() => parseSiteConfig(readJson('site.json')));
  assert.doesNotThrow(() => parseAppConfig(readJson('app.json')));
});

test('site.json の誤りをまとめて報告する', () => {
  const raw = readJson('site.json');
  const sites = raw['sites'] as Record<string, Record<string, unknown>>;
  const v = structuredClone(sites['verification']!);
  v['latitude'] = '35.69';
  (v['window'] as Record<string, unknown>)['side'] = 'center';
  const problems = problemsOf(() => parseSiteConfig({ activeSite: 'production', sites: { verification: v } }));
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => p.includes('latitude') && p.includes('数値')));
  assert.ok(problems.some((p) => p.includes('window.side')));
  assert.ok(problems.some((p) => p.includes('activeSite "production"')));
});

test('room モードの部屋・窓の寸法の誤りを報告する', () => {
  const raw = readJson('site.json');
  const sites = raw['sites'] as Record<string, Record<string, unknown>>;
  const v = structuredClone(sites['verification']!);
  (v['window'] as Record<string, unknown>)['widthM'] = 20;
  (v['room'] as Record<string, unknown>)['widthM'] = 10;
  (v['window'] as Record<string, unknown>)['sillHeightM'] = 3;
  const problems = problemsOf(() => parseSiteConfig({ activeSite: 'verification', sites: { verification: v } }));
  assert.equal(problems.length, 2);
  // 壁の窓は奥行き方向に並ぶので、比べる相手は部屋の奥行き
  assert.ok(problems.some((p) => p.includes('window.widthM') && p.includes('room.depthM')));
  assert.ok(problems.some((p) => p.includes('sillHeightM') && p.includes('room.heightM')));
});

test('天窓（window.side = "ceiling"）は天井に収まるかを検証し、下端の高さは問わない', () => {
  const raw = readJson('site.json');
  const sites = raw['sites'] as Record<string, Record<string, unknown>>;
  const v = structuredClone(sites['verification']!);
  const w = v['window'] as Record<string, unknown>;
  w['side'] = 'ceiling';
  w['sillHeightM'] = 3; // 天窓では使わない
  assert.doesNotThrow(() => parseSiteConfig({ activeSite: 'verification', sites: { verification: v } }));
  w['widthM'] = 12;
  const problems = problemsOf(() => parseSiteConfig({ activeSite: 'verification', sites: { verification: v } }));
  assert.equal(problems.length, 1);
  assert.ok(problems[0]!.includes('天窓') && problems[0]!.includes('room.widthM'));
});

test('app.json の誤りを報告する', () => {
  const raw = { ...readJson('app.json'), mode: 'fullscreen', dailyReloadAt: '4:00', heartbeatTimeoutSec: 5 };
  const problems = problemsOf(() => parseAppConfig(raw));
  assert.equal(problems.length, 3);
});

test('visuals.json を検証する', () => {
  const raw = readJson('visuals.json');
  assert.doesNotThrow(() => parseVisualsConfig(raw));
  const bad = { ...raw, output: { min: 0.9, max: 0.2 }, scenes: { a: { ok: 1, ng: { nested: true } } } };
  const problems = problemsOf(() => parseVisualsConfig(bad));
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('output.min')));
  assert.ok(problems.some((p) => p.includes('scenes.a.ng')));
});

test('シーンの保存値は型が合うものだけ既定値に重ねる', () => {
  const def = SCENES.find((s) => s.id === 'color-field')!;
  const merged = mergeParams(def, { warmth: 0.1, softness: 'wide', accent: '#112233', useAccent: 1, unknown: 5 });
  assert.equal(merged['warmth'], 0.1);
  assert.equal(merged['softness'], def.params['softness']!.value);
  assert.equal(merged['accent'], '#112233');
  assert.equal(merged['useAccent'], false);
  assert.ok(!('unknown' in merged));
  assert.equal(new Set(SCENES.map((x) => x.id)).size, SCENES.length, 'シーン ID が重複しています');
});

test('sunLinks の toggle キーは、そのシーンの真偽値パラメータとして存在する', () => {
  for (const def of SCENES) {
    for (const link of def.sunLinks ?? []) {
      if (link.toggle === undefined) continue;
      const spec = def.params[link.toggle];
      assert.ok(spec, `${def.id}: sunLinks の toggle "${link.toggle}" が params にありません`);
      assert.equal(spec.type, 'boolean', `${def.id}: sunLinks の toggle "${link.toggle}" は真偽値のパラメータではありません`);
    }
  }
});
