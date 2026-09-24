// electron/*.ts を dist-electron/ へ変換する。main は ESM、sandbox 下の preload は CommonJS が必要
import { type BuildOptions, build } from 'esbuild';

const common: BuildOptions = { bundle: true, platform: 'node', target: 'node22', external: ['electron'], sourcemap: true, logLevel: 'warning' };

await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.js', format: 'esm' }),
  build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', format: 'cjs' }),
]);
console.log('built dist-electron/');
