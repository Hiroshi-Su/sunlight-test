// logs/*.log を集計して長時間稼働の結果を表示する。 npm run logs [-- 2026-09-25]
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const logDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const since = process.argv[2];
const files = readdirSync(logDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f) && (!since || f >= since)).sort();
const rows = files.flatMap((f) =>
  readFileSync(join(logDir, f), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  }));
if (!rows.length) { console.log('ログがありません'); process.exit(0); }

const count = {};
for (const r of rows) count[r.type] = (count[r.type] ?? 0) + 1;
const stats = rows.filter((r) => r.type === 'stats');
const fps = stats.map((r) => r.renderer?.fps).filter((v) => v != null);
const heap = stats.map((r) => r.renderer?.heapMB).filter((v) => v != null);
const total = stats.map((r) => Object.values(r.memMB ?? {}).reduce((a, b) => a + b, 0));
const span = (new Date(rows.at(-1).t) - new Date(rows[0].t)) / 3600000;

const fmt = (a) => a.length
  ? `min ${Math.min(...a).toFixed(1)} / avg ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)} / max ${Math.max(...a).toFixed(1)}  (最初 ${a[0]} → 最後 ${a.at(-1)})`
  : '-';

console.log(`期間      ${rows[0].t} 〜 ${rows.at(-1).t}（${span.toFixed(1)} 時間, ${files.length} ファイル）`);
console.log(`イベント  ${Object.entries(count).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`FPS       ${fmt(fps)}`);
console.log(`JS heap   ${fmt(heap)} MB`);
console.log(`総メモリ  ${fmt(total)} MB`);

const incidents = rows.filter((r) => !['stats', 'start', 'renderer-ready', 'daily-reload', 'quit', 'quit-by-key', 'signal', 'mode-switch'].includes(r.type));
if (incidents.length) {
  console.log('\n異常・復帰（最新 20 件）');
  for (const r of incidents.slice(-20)) {
    const { t, type, ...rest } = r;
    console.log(`  ${t}  ${type}  ${JSON.stringify(rest).slice(0, 160)}`);
  }
}
