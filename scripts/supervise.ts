// Electron が異常終了したら再起動する。Ctrl/Cmd+Shift+Q による正常終了（exit 0）と、設定エラー（exit 78）で止まる。
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CONFIG_ERROR } from '../electron/exit-codes.ts';

// Node から require('electron') すると実行ファイルのパスが返る
const electronPath = createRequire(import.meta.url)('electron') as string;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = join(ROOT, 'logs');
mkdirSync(logDir, { recursive: true });
const log = (type: string, data: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ t: new Date().toISOString(), type, ...data });
  appendFileSync(join(logDir, 'supervisor.log'), line + '\n');
  console.log(line);
};

const args = ['.', ...process.argv.slice(2)];
const crashes: number[] = [];
let child: ChildProcess | null = null;
let stopping = false;

function stop(sig: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  log('supervisor-stop', { sig });
  const c = child;
  if (!c || c.exitCode !== null || c.signalCode !== null) process.exit(0);
  c.once('exit', () => process.exit(0));
  c.kill('SIGTERM');
  setTimeout(() => { log('force-kill'); c.kill('SIGKILL'); }, 5000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => stop(sig));

function run(): void {
  log('launch', { args });
  child = spawn(electronPath, args, { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    if (code === 0) { log('exit-normal'); process.exit(0); }
    if (code === EXIT_CONFIG_ERROR) {
      log('exit-config-error', { hint: 'config/*.json を直してから起動し直してください（logs/config-error.log 参照）' });
      process.exit(EXIT_CONFIG_ERROR);
    }
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0]! > 10 * 60000) crashes.shift();
    // 10 分に 5 回以上落ちるなら間隔を空ける
    const delay = crashes.length >= 5 ? 60000 : 5000;
    log('exit-abnormal', { code, signal, recentCrashes: crashes.length, restartInSec: delay / 1000 });
    setTimeout(run, delay);
  });
}

run();
