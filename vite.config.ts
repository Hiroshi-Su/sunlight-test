import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Plugin, defineConfig } from 'vite';
import { ConfigError, parseVisualsConfig } from './src/config.ts';

export const DEV_SAVE_VISUALS = '/__save-visuals';

// 開発サーバー限定：visuals モードのパネルから config/visuals.json に保存する（Electron では IPC で保存）
function saveVisualsPlugin(): Plugin {
  return {
    name: 'soracity-save-visuals',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(DEV_SAVE_VISUALS, (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
        req.on('end', () => {
          try {
            const cfg = parseVisualsConfig(JSON.parse(body));
            const file = resolve(server.config.root, 'config/visuals.json');
            writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2) + '\n');
            renameSync(`${file}.tmp`, file);
            res.statusCode = 204;
            res.end();
          } catch (err) {
            res.statusCode = err instanceof ConfigError || err instanceof SyntaxError ? 400 : 500;
            res.end(err instanceof Error ? err.message : String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [saveVisualsPlugin()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
  // 保存のたびにページが再読み込みされないよう、visuals.json の変更は監視しない
  server: { watch: { ignored: ['**/config/visuals.json', '**/logs/**'] } },
});
