// Electron を 1 回起動する（npm run app 系）。表示の倍率のスイッチを付けるため、electron . を直接呼ばずにこれを通す
// 例：node scripts/launch.ts --mode=room
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronArgs } from './electron-args.ts';

// Node から require('electron') すると実行ファイルのパスが返る
const electronPath = createRequire(import.meta.url)('electron') as string;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const child = spawn(electronPath, electronArgs(ROOT, process.argv.slice(2)), { cwd: ROOT, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
