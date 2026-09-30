// config/*.json の型と検証。現地で手編集されるファイルなので、起動時に問題点をまとめて報告する。

export type WindowSide = 'left' | 'right';
export type AzimuthReference = 'magnetic' | 'true';
export type AppMode = 'verify' | 'visuals' | 'room' | 'kiosk';
export const APP_MODES: readonly AppMode[] = ['verify', 'visuals', 'room', 'kiosk'];

export interface SiteEntry {
  label: string;
  latitude: number;
  longitude: number;
  utcOffsetMinutes: number;
  screen: {
    facingAzimuth: number;
    azimuthReference: AzimuthReference;
    magneticDeclination: number;
  };
  window: {
    side: WindowSide;
    facingAzimuth: number | null;
    /** 窓の実寸（m）。room モードの仮想の部屋で使う */
    widthM: number;
    heightM: number;
    /** 床から窓の下端までの高さ（m） */
    sillHeightM: number;
  };
  /** room モードで使う仮想の部屋の寸法（m） */
  room: {
    widthM: number;
    depthM: number;
    heightM: number;
  };
}

export interface SiteConfig {
  activeSite: string;
  sites: Record<string, SiteEntry>;
}

export interface AppConfig {
  mode: AppMode;
  window: { x: number; y: number; width: number; height: number; alwaysOnTop: boolean };
  forceDeviceScaleFactor: number | null;
  dailyReloadAt: string | null;
  statsIntervalSec: number;
  heartbeatTimeoutSec: number;
  logDir: string;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`${file} に問題があります:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class Checker {
  readonly problems: string[] = [];

  obj(v: unknown, path: string): Obj {
    if (isObj(v)) return v;
    this.problems.push(`${path} はオブジェクトである必要があります`);
    return {};
  }

  num(o: Obj, key: string, path: string, min = -Infinity, max = Infinity): number {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.problems.push(`${path}.${key} は数値である必要があります（現在: ${JSON.stringify(v)}）`);
      return NaN;
    }
    if (v < min || v > max) this.problems.push(`${path}.${key} は ${min}〜${max} の範囲です（現在: ${v}）`);
    return v;
  }

  numOrNull(o: Obj, key: string, path: string, min?: number, max?: number): number | null {
    return o[key] === null ? null : this.num(o, key, path, min, max);
  }

  str(o: Obj, key: string, path: string): string {
    const v = o[key];
    if (typeof v === 'string') return v;
    this.problems.push(`${path}.${key} は文字列である必要があります（現在: ${JSON.stringify(v)}）`);
    return '';
  }

  bool(o: Obj, key: string, path: string): boolean {
    const v = o[key];
    if (typeof v === 'boolean') return v;
    this.problems.push(`${path}.${key} は true / false である必要があります（現在: ${JSON.stringify(v)}）`);
    return false;
  }

  oneOf<T extends string>(o: Obj, key: string, path: string, options: readonly T[]): T {
    const v = o[key];
    if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T;
    this.problems.push(`${path}.${key} は ${options.map((x) => `"${x}"`).join(' / ')} のいずれかです（現在: ${JSON.stringify(v)}）`);
    return options[0]!;
  }
}

function parseSite(c: Checker, raw: unknown, path: string): SiteEntry {
  const o = c.obj(raw, path);
  const screen = c.obj(o['screen'], `${path}.screen`);
  const win = c.obj(o['window'], `${path}.window`);
  const room = c.obj(o['room'], `${path}.room`);
  const entry: SiteEntry = {
    label: typeof o['label'] === 'string' ? o['label'] : '',
    latitude: c.num(o, 'latitude', path, -90, 90),
    longitude: c.num(o, 'longitude', path, -180, 180),
    utcOffsetMinutes: c.num(o, 'utcOffsetMinutes', path, -720, 840),
    screen: {
      facingAzimuth: c.num(screen, 'facingAzimuth', `${path}.screen`, 0, 360),
      azimuthReference: c.oneOf(screen, 'azimuthReference', `${path}.screen`, ['magnetic', 'true'] as const),
      magneticDeclination: c.num(screen, 'magneticDeclination', `${path}.screen`, -30, 30),
    },
    window: {
      side: c.oneOf(win, 'side', `${path}.window`, ['left', 'right'] as const),
      facingAzimuth: c.numOrNull(win, 'facingAzimuth', `${path}.window`, 0, 360),
      widthM: c.num(win, 'widthM', `${path}.window`, 0.1, 20),
      heightM: c.num(win, 'heightM', `${path}.window`, 0.1, 10),
      sillHeightM: c.num(win, 'sillHeightM', `${path}.window`, 0, 5),
    },
    room: {
      widthM: c.num(room, 'widthM', `${path}.room`, 1, 50),
      depthM: c.num(room, 'depthM', `${path}.room`, 1, 50),
      heightM: c.num(room, 'heightM', `${path}.room`, 1, 10),
    },
  };
  if (entry.window.widthM >= entry.room.widthM) {
    c.problems.push(`${path}.window.widthM（${entry.window.widthM}）は ${path}.room.widthM（${entry.room.widthM}）より小さくしてください`);
  }
  if (entry.window.sillHeightM + entry.window.heightM > entry.room.heightM) {
    c.problems.push(`${path}.window.sillHeightM + heightM（${entry.window.sillHeightM + entry.window.heightM}）は ${path}.room.heightM（${entry.room.heightM}）以下にしてください`);
  }
  return entry;
}

export function parseSiteConfig(raw: unknown, file = 'config/site.json'): SiteConfig {
  const c = new Checker();
  const o = c.obj(raw, '(root)');
  const activeSite = c.str(o, 'activeSite', '(root)');
  const sitesRaw = c.obj(o['sites'], 'sites');
  const sites: Record<string, SiteEntry> = {};
  for (const [name, entry] of Object.entries(sitesRaw)) sites[name] = parseSite(c, entry, `sites.${name}`);
  if (activeSite && !(activeSite in sites)) {
    c.problems.push(`activeSite "${activeSite}" が sites にありません（あるもの: ${Object.keys(sites).join(', ') || 'なし'}）`);
  }
  if (c.problems.length) throw new ConfigError(file, c.problems);
  return { activeSite, sites };
}

export function parseAppConfig(raw: unknown, file = 'config/app.json'): AppConfig {
  const c = new Checker();
  const o = c.obj(raw, '(root)');
  const w = c.obj(o['window'], 'window');
  const daily = o['dailyReloadAt'];
  if (daily !== null && (typeof daily !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(daily))) {
    c.problems.push(`dailyReloadAt は "HH:MM" か null です（現在: ${JSON.stringify(daily)}）`);
  }
  const cfg: AppConfig = {
    mode: c.oneOf(o, 'mode', '(root)', APP_MODES),
    window: {
      x: c.num(w, 'x', 'window'),
      y: c.num(w, 'y', 'window'),
      width: c.num(w, 'width', 'window', 1),
      height: c.num(w, 'height', 'window', 1),
      alwaysOnTop: c.bool(w, 'alwaysOnTop', 'window'),
    },
    forceDeviceScaleFactor: c.numOrNull(o, 'forceDeviceScaleFactor', '(root)', 0.25, 4),
    dailyReloadAt: typeof daily === 'string' ? daily : null,
    statsIntervalSec: c.num(o, 'statsIntervalSec', '(root)', 10),
    heartbeatTimeoutSec: c.num(o, 'heartbeatTimeoutSec', '(root)', 15),
    logDir: c.str(o, 'logDir', '(root)'),
  };
  if (c.problems.length) throw new ConfigError(file, c.problems);
  return cfg;
}

// ---- config/visuals.json：映像の選択と調整値（visuals モードのパネルから保存される）----

export type ParamValue = number | string | boolean;
export type ParamValues = Record<string, ParamValue>;

export interface VisualsConfig {
  activeScene: string;
  /** 出力の明るさの下限・上限（純黒・純白を避ける） */
  output: { min: number; max: number };
  /** visuals モードのガイド表示（px、3840×1080 のキャンバス基準） */
  guides: { seamSpacingPx: number; seamOffsetPx: number; overlapPx: number };
  /** visuals モードのプレビュー用。kiosk では使わない */
  preview: { wash: number; washFollowsSun: boolean };
  /** シーンごとの調整値。書かれていない項目はシーンの既定値を使う */
  scenes: Record<string, ParamValues>;
}

export function parseVisualsConfig(raw: unknown, file = 'config/visuals.json'): VisualsConfig {
  const c = new Checker();
  const o = c.obj(raw, '(root)');
  const out = c.obj(o['output'], 'output');
  const g = c.obj(o['guides'], 'guides');
  const p = c.obj(o['preview'], 'preview');
  const scenesRaw = c.obj(o['scenes'], 'scenes');
  const scenes: Record<string, ParamValues> = {};
  for (const [id, values] of Object.entries(scenesRaw)) {
    const vo = c.obj(values, `scenes.${id}`);
    scenes[id] = {};
    for (const [k, v] of Object.entries(vo)) {
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') scenes[id][k] = v;
      else c.problems.push(`scenes.${id}.${k} は数値・文字列・真偽値のいずれかです（現在: ${JSON.stringify(v)}）`);
    }
  }
  const cfg: VisualsConfig = {
    activeScene: c.str(o, 'activeScene', '(root)'),
    output: { min: c.num(out, 'min', 'output', 0, 1), max: c.num(out, 'max', 'output', 0, 1) },
    guides: {
      seamSpacingPx: c.num(g, 'seamSpacingPx', 'guides', 0),
      seamOffsetPx: c.num(g, 'seamOffsetPx', 'guides'),
      overlapPx: c.num(g, 'overlapPx', 'guides', 0),
    },
    preview: { wash: c.num(p, 'wash', 'preview', 0, 1), washFollowsSun: c.bool(p, 'washFollowsSun', 'preview') },
    scenes,
  };
  if (cfg.output.min >= cfg.output.max) c.problems.push(`output.min（${cfg.output.min}）は output.max（${cfg.output.max}）より小さくしてください`);
  if (c.problems.length) throw new ConfigError(file, c.problems);
  return cfg;
}
