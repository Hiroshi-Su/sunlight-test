// Electron に渡す起動引数。scripts/launch.ts（npm run app 系）と scripts/supervise.ts（npm run app:forever）で使う。
// 表示の倍率（config/app.json の forceDeviceScaleFactor）は、アプリの中で app.commandLine.appendSwitch しても
// macOS では効かない（その時点で画面の倍率がもう決まっている）ので、起動するときのスイッチとして付ける
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAppConfig } from '../src/config.ts';

export function electronArgs(root: string, extra: string[]): string[] {
  const configDir = process.env['SORACITY_CONFIG_DIR'] ?? join(root, 'config');
  const file = join(configDir, 'app.json');
  let scale: number | null = null;
  try {
    scale = parseAppConfig(JSON.parse(readFileSync(file, 'utf8')), file).forceDeviceScaleFactor;
  } catch {
    // 設定の誤りは、アプリ本体が起動時に画面とログで知らせる（ここでは倍率のスイッチを付けないだけ）
  }
  return [...(scale != null ? [`--force-device-scale-factor=${scale}`] : []), '.', ...extra];
}
