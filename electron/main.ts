import { BrowserWindow, Menu, app, dialog, ipcMain, net, powerSaveBlocker, protocol } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Bootstrap, type Heartbeat, IPC, type ReportData } from '../src/bridge.ts';
import { type AppConfig, type AppMode, ConfigError, type SiteConfig, parseAppConfig, parseSiteConfig } from '../src/config.ts';
import { EXIT_CONFIG_ERROR } from './exit-codes.ts';

// ビルド後は dist-electron/main.js から実行される
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const CONFIG_DIR = process.env['SORACITY_CONFIG_DIR'] ?? join(ROOT, 'config');

// ---- 設定の読み込みと検証 ----
function loadConfigs(): { appConfig: AppConfig; siteConfig: SiteConfig } {
  const read = (name: string): unknown => {
    const file = join(CONFIG_DIR, name);
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new ConfigError(file, [`読み込めません: ${(err as Error).message}`]);
    }
  };
  return {
    appConfig: parseAppConfig(read('app.json'), join(CONFIG_DIR, 'app.json')),
    siteConfig: parseSiteConfig(read('site.json'), join(CONFIG_DIR, 'site.json')),
  };
}

let configs: ReturnType<typeof loadConfigs>;
try {
  configs = loadConfigs();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const fallbackDir = join(ROOT, 'logs');
  mkdirSync(fallbackDir, { recursive: true });
  appendFileSync(join(fallbackDir, 'config-error.log'), JSON.stringify({ t: new Date().toISOString(), type: 'config-error', message }) + '\n');
  console.error(message);
  dialog.showErrorBox('設定ファイルのエラー', message);
  process.exit(EXIT_CONFIG_ERROR); // 監視スクリプトはこのコードでは再起動しない
}
const { appConfig, siteConfig } = configs;
const site = siteConfig.sites[siteConfig.activeSite]!;

const argMode = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1];
if (argMode !== undefined && argMode !== 'kiosk' && argMode !== 'verify') {
  console.error(`--mode は kiosk か verify です: ${argMode}`);
  process.exit(EXIT_CONFIG_ERROR);
}
let mode: AppMode = argMode ?? appConfig.mode;

// ---- ログ（1 日 1 ファイルの JSON Lines。日付は現地時刻）----
const logDir = isAbsolute(appConfig.logDir) ? appConfig.logDir : join(ROOT, appConfig.logDir);
mkdirSync(logDir, { recursive: true });
const localNow = (): Date => new Date(Date.now() + site.utcOffsetMinutes * 60000);
function log(type: string, data: ReportData = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), type, ...data });
  appendFileSync(join(logDir, `${localNow().toISOString().slice(0, 10)}.log`), line + '\n');
  if (type !== 'stats') console.log(line);
}

process.on('uncaughtException', (err) => {
  log('main-error', { message: err.message, stack: err.stack });
  app.exit(1); // 監視スクリプトに再起動させる
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { log('signal', { sig }); app.quit(); });
}

// ---- 長時間稼働向けのスイッチ（app ready 前に設定する必要がある）----
if (appConfig.forceDeviceScaleFactor != null) {
  app.commandLine.appendSwitch('force-device-scale-factor', String(appConfig.forceDeviceScaleFactor));
}
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

// ---- ウィンドウ ----
let win: BrowserWindow | null = null;
const startedAt = Date.now();
let loadedAt = Date.now();
let lastBeat = Date.now();
let latest: Heartbeat | null = null;
let recoveries = 0;
let lastRecoverAt = 0;
let failuresSinceBeat = 0;
let crashRequested = false;
let unresponsiveTimer: NodeJS.Timeout | undefined;
const GRACE_MS = 30000;
const pageUrl = (): string => `app://soracity/index.html?mode=${mode}`;

function createWindow(): void {
  const common: BrowserWindowConstructorOptions = {
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(ROOT, 'dist-electron', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  };
  const w = appConfig.window;
  const created = mode === 'kiosk'
    ? new BrowserWindow({
      ...common,
      x: w.x, y: w.y, width: w.width, height: w.height,
      frame: false, resizable: false, movable: false, fullscreenable: false,
      enableLargerThanScreen: true, hasShadow: false,
    })
    : new BrowserWindow({ ...common, width: 1600, height: 1000 });
  win = created;

  created.once('ready-to-show', () => {
    if (mode === 'kiosk') {
      created.setBounds({ x: w.x, y: w.y, width: w.width, height: w.height });
      if (w.alwaysOnTop) created.setAlwaysOnTop(true, 'screen-saver');
    }
    created.show();
  });

  const wc = created.webContents;
  const isCurrent = (): boolean => win === created && !created.isDestroyed();
  wc.on('did-finish-load', () => {
    loadedAt = Date.now();
    lastBeat = Date.now() + GRACE_MS;
  });
  // 描画プロセスが終わった後に読み込み直す（終了処理中の reload は無視されることがある）
  wc.on('render-process-gone', (_e, details) => {
    if (!isCurrent()) return;
    log('render-process-gone', { ...details, requested: crashRequested });
    if (!crashRequested) recoveries++;
    crashRequested = false;
    setTimeout(() => {
      if (!isCurrent()) return;
      lastBeat = Date.now() + GRACE_MS;
      void created.loadURL(pageUrl());
    }, 1000);
  });
  wc.on('unresponsive', () => {
    if (!isCurrent()) return;
    log('unresponsive');
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = setTimeout(() => recover('unresponsive', { hard: true }), 10000);
  });
  wc.on('responsive', () => {
    clearTimeout(unresponsiveTimer);
    log('responsive');
  });

  const recentConsole = new Map<string, number>();
  wc.on('console-message', (e) => {
    const { level, message } = e;
    if (level !== 'warning' && level !== 'error') return;
    const now = Date.now();
    if (now - (recentConsole.get(message) ?? 0) < 60000) return;
    recentConsole.set(message, now);
    log('renderer-console', { level, message: message.slice(0, 500) });
  });

  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || !input.shift) return;
    const key = input.key.toLowerCase();
    if (key === 'q') { e.preventDefault(); log('quit-by-key'); app.quit(); }
    if (key === 'i') { e.preventDefault(); wc.toggleDevTools(); }
    if (key === 'm') {
      e.preventDefault();
      mode = mode === 'kiosk' ? 'verify' : 'kiosk';
      log('mode-switch', { mode });
      recreateWindow();
    }
  });

  void created.loadURL(pageUrl());
}

function recreateWindow(): void {
  const old = win;
  createWindow();
  old?.destroy();
}

// 段階的に強める：1回目は描画プロセスを落として読み込み直し、復帰しなければウィンドウごと作り直す
function recover(reason: string, { hard = false }: { hard?: boolean } = {}): void {
  if (!win || win.isDestroyed()) return;
  if (Date.now() - lastRecoverAt < 10000) return;
  lastRecoverAt = Date.now();
  recoveries++;
  failuresSinceBeat++;
  lastBeat = Date.now() + GRACE_MS;
  if (failuresSinceBeat >= 2) {
    log('recover', { reason, action: 'recreate-window', recoveries });
    recreateWindow();
    return;
  }
  log('recover', { reason, action: hard ? 'crash-and-reload' : 'reload', recoveries });
  if (hard) {
    crashRequested = true;
    win.webContents.forcefullyCrashRenderer();
  } else {
    void win.loadURL(pageUrl());
  }
}

// ---- 描画側からの通知 ----
const fromCurrent = (sender: Electron.WebContents): boolean => !!win && !win.isDestroyed() && sender === win.webContents;

ipcMain.on(IPC.bootstrap, (e) => {
  const boot: Bootstrap = { mode, site: siteConfig };
  e.returnValue = boot;
});
ipcMain.on(IPC.heartbeat, (e, data: Heartbeat) => {
  if (!fromCurrent(e.sender)) return;
  lastBeat = Date.now();
  failuresSinceBeat = 0;
  latest = data;
});
ipcMain.on(IPC.report, (e, { type, ...data }: { type: string } & ReportData) => {
  log(type, data);
  if (type === 'webgl-context-lost' && fromCurrent(e.sender)) recover('webgl-context-lost');
});

// ---- 監視・定期処理 ----
function startTimers(): void {
  setInterval(() => {
    if (Date.now() - lastBeat > appConfig.heartbeatTimeoutSec * 1000) {
      recover('heartbeat-timeout', { hard: true });
    }
  }, 5000);

  const writeStats = (): void => {
    const mem: Record<string, number> = {};
    for (const m of app.getAppMetrics()) {
      mem[m.type] = (mem[m.type] ?? 0) + Math.round(m.memory.workingSetSize / 1024);
    }
    log('stats', {
      uptimeMin: Math.round((Date.now() - startedAt) / 60000),
      sinceLoadMin: Math.round((Date.now() - loadedAt) / 60000),
      recoveries,
      mode,
      renderer: latest,
      memMB: mem,
    });
  };
  setTimeout(writeStats, 60000);
  setInterval(writeStats, appConfig.statsIntervalSec * 1000);

  let lastDaily: string | null = null;
  setInterval(() => {
    if (!appConfig.dailyReloadAt || !win || win.isDestroyed()) return;
    const now = localNow().toISOString();
    const day = now.slice(0, 10);
    if (now.slice(11, 16) === appConfig.dailyReloadAt && lastDaily !== day) {
      lastDaily = day;
      lastBeat = Date.now() + GRACE_MS;
      log('daily-reload');
      win.webContents.reloadIgnoringCache();
    }
  }, 20000);
}

app.on('child-process-gone', (_e, details) => log('child-process-gone', { ...details }));
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => log('quit'));

void app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const file = normalize(join(DIST, decodeURIComponent(new URL(req.url).pathname)));
    const rel = relative(DIST, file);
    if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  Menu.setApplicationMenu(null);
  powerSaveBlocker.start('prevent-display-sleep');
  log('start', {
    mode,
    site: siteConfig.activeSite,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: `${process.platform} ${process.arch}`,
    window: appConfig.window,
  });
  createWindow();
  startTimers();
});
