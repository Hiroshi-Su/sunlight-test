import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Plugin, defineConfig } from 'vite';
import { ConfigError, parseVisualsConfig } from './src/config.ts';

export const DEV_SAVE_VISUALS = '/__save-visuals';
export const DEV_SAVE_ROOM = '/__save-room';

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

// 開発サーバー限定：room モードのパネルから config/room.json に保存する（Electron では IPC で保存）。
// 中身の確かめは読むとき（描画側）に寛容に行うので、ここでは JSON のオブジェクトであることだけ確かめる
function saveRoomPlugin(): Plugin {
  return {
    name: 'soracity-save-room',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(DEV_SAVE_ROOM, (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
        req.on('end', () => {
          try {
            const file: unknown = JSON.parse(body);
            if (typeof file !== 'object' || file === null || Array.isArray(file) || body.length > 1_000_000) throw new SyntaxError('room の設定の形が違います');
            const out = resolve(server.config.root, 'config/room.json');
            writeFileSync(`${out}.tmp`, JSON.stringify(file, null, 2) + '\n');
            renameSync(`${out}.tmp`, out);
            res.statusCode = 204;
            res.end();
          } catch (err) {
            res.statusCode = err instanceof SyntaxError ? 400 : 500;
            res.end(err instanceof Error ? err.message : String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [saveVisualsPlugin(), saveRoomPlugin()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
  // 保存のたびにページが再読み込みされないよう、visuals.json・room.json の変更は監視しない
  server: { watch: { ignored: ['**/config/visuals.json', '**/config/room.json', '**/logs/**'] } },
});
