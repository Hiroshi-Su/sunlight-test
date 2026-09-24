// Electron が異常終了したら再起動する。Ctrl/Cmd+Shift+Q による正常終了（exit 0）で止まる。
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = join(ROOT, 'logs');
mkdirSync(logDir, { recursive: true });
const log = (type, data = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), type, ...data });
  appendFileSync(join(logDir, 'supervisor.log'), line + '\n');
  console.log(line);
};

const args = ['.', ...process.argv.slice(2)];
const crashes = [];
let child = null;
let stopping = false;

function stop(sig) {
  if (stopping) return;
  stopping = true;
  log('supervisor-stop', { sig });
  if (!child || child.exitCode !== null) process.exit(0);
  child.once('exit', () => process.exit(0));
  child.kill('SIGTERM');
  setTimeout(() => { log('force-kill'); child.kill('SIGKILL'); }, 5000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(sig));

function run() {
  log('launch', { args });
  child = spawn(electronPath, args, { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    if (code === 0) { log('exit-normal'); process.exit(0); }
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 10 * 60000) crashes.shift();
    // 10 分に 5 回以上落ちるなら間隔を空ける
    const delay = crashes.length >= 5 ? 60000 : 5000;
    log('exit-abnormal', { code, signal, recentCrashes: crashes.length, restartInSec: delay / 1000 });
    setTimeout(run, delay);
  });
}

run();
