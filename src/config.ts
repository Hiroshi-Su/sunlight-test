// config/*.json の型と検証。現地で手編集されるファイルなので、起動時に問題点をまとめて報告する。

export type WindowSide = 'left' | 'right';
export type AzimuthReference = 'magnetic' | 'true';
export type AppMode = 'kiosk' | 'verify';

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
  return {
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
    },
  };
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
    mode: c.oneOf(o, 'mode', '(root)', ['verify', 'kiosk'] as const),
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
