// logs/*.log を集計して長時間稼働の結果を表示する。 npm run logs [-- 2026-09-25]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Heartbeat } from '../src/bridge.ts';

interface LogRow {
  t: string;
  type: string;
  renderer?: Heartbeat | null;
  memMB?: Record<string, number>;
  [key: string]: unknown;
}

const logDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const since = process.argv[2];
const files = existsSync(logDir)
  ? readdirSync(logDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f) && (!since || f >= since)).sort()
  : [];
const rows: LogRow[] = files.flatMap((f) =>
  readFileSync(join(logDir, f), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as LogRow]; } catch { return []; }
  }));
const first = rows[0];
const lastRow = rows.at(-1);
if (!first || !lastRow) { console.log('ログがありません'); process.exit(0); }

const count: Record<string, number> = {};
for (const r of rows) count[r.type] = (count[r.type] ?? 0) + 1;
const stats = rows.filter((r) => r.type === 'stats');
const fps = stats.flatMap((r) => (r.renderer ? [r.renderer.fps] : []));
const heap = stats.flatMap((r) => (r.renderer?.heapMB != null ? [r.renderer.heapMB] : []));
const gpu = stats.flatMap((r) => (r.renderer?.gpuMs != null ? [r.renderer.gpuMs] : []));
const total = stats.map((r) => Object.values(r.memMB ?? {}).reduce((a, b) => a + b, 0));
const span = (Date.parse(lastRow.t) - Date.parse(first.t)) / 3600000;

const fmt = (a: number[]): string => a.length
  ? `min ${Math.min(...a).toFixed(1)} / avg ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)} / max ${Math.max(...a).toFixed(1)}  (最初 ${a[0]} → 最後 ${a.at(-1)})`
  : '-';

console.log(`期間      ${first.t} 〜 ${lastRow.t}（${span.toFixed(1)} 時間, ${files.length} ファイル）`);
console.log(`イベント  ${Object.entries(count).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`FPS       ${fmt(fps)}`);
console.log(`GPU 時間  ${fmt(gpu)} ms`);
console.log(`JS heap   ${fmt(heap)} MB`);
console.log(`総メモリ  ${fmt(total)} MB`);

const benches = rows.filter((r) => r.type === 'benchmark');
if (benches.length) {
  console.log('\nベンチマーク（最新 10 件）');
  for (const r of benches.slice(-10)) console.log(`  ${r.t}  ${String(r['scene'])}  ${String(r['ms'])} ms`);
}

// 表示の倍率：最後に記録した画面の一覧と、描画側の実際の倍率
const lastDisplays = rows.filter((r) => r.type === 'displays').at(-1);
const lastScale = rows.filter((r) => r.type === 'scale' || r.type === 'scale-mismatch').at(-1);
if (lastDisplays || lastScale) {
  console.log('\n表示の倍率');
  if (lastDisplays) {
    console.log(`  設定 forceDeviceScaleFactor ${String(lastDisplays['forceDeviceScaleFactor'])}  起動のスイッチ ${String(lastDisplays['switch'])}（${lastDisplays.t}）`);
    for (const d of (lastDisplays['displays'] as { label: string; primary: boolean; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }[]) ?? []) {
      console.log(`  画面 ${d.label || '(名前なし)'}${d.primary ? '（主）' : ''}  位置 ${d.bounds.x},${d.bounds.y}  ${d.bounds.width}×${d.bounds.height}  倍率 ${d.scaleFactor}`);
    }
  }
  if (lastScale) console.log(`  描画の倍率 ${String(lastScale['dpr'])}${lastScale.type === 'scale-mismatch' ? '  ※設定と違う' : ''}（${lastScale.t}）`);
}

const NORMAL = new Set(['stats', 'start', 'renderer-ready', 'daily-reload', 'quit', 'quit-by-key', 'signal', 'mode-switch', 'benchmark', 'displays', 'scale']);
const incidents = rows.filter((r) => !NORMAL.has(r.type));
if (incidents.length) {
  console.log('\n異常・復帰（最新 20 件）');
  for (const r of incidents.slice(-20)) {
    const { t, type, ...rest } = r;
    console.log(`  ${t}  ${type}  ${JSON.stringify(rest).slice(0, 160)}`);
  }
}
