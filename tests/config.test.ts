import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ConfigError, parseAppConfig, parseSiteConfig } from '../src/config.ts';

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

test('app.json の誤りを報告する', () => {
  const raw = { ...readJson('app.json'), mode: 'fullscreen', dailyReloadAt: '4:00', heartbeatTimeoutSec: 5 };
  const problems = problemsOf(() => parseAppConfig(raw));
  assert.equal(problems.length, 3);
});
