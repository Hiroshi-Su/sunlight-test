// config/*.json の型と検証。現地で手編集されるファイルなので、起動時に問題点をまとめて報告する。

/** 窓の位置。left / right = 鑑賞者から見て左右の壁、ceiling = 天井（天窓） */
/** 窓の位置。'ceiling-left' は天井（天井いっぱいの窓）と左の壁の窓の両方 */
export type WindowSide = 'left' | 'right' | 'ceiling' | 'ceiling-left';
export const WINDOW_SIDES: readonly WindowSide[] = ['left', 'right', 'ceiling', 'ceiling-left'];
export const WINDOW_SIDE_LABEL: Record<WindowSide, string> = { left: '左', right: '右', ceiling: '天井', 'ceiling-left': '天井＋左' };
/** 壁の窓の側（天窓＋左は左。天窓だけのときは null） */
export const wallWindowSide = (side: WindowSide): 'left' | 'right' | null => (side === 'ceiling' ? null : side === 'ceiling-left' ? 'left' : side);
export type AzimuthReference = 'magnetic' | 'true';
export type AppMode = 'verify' | 'visuals' | 'room' | 'site' | 'kiosk';
export const APP_MODES: readonly AppMode[] = ['verify', 'visuals', 'room', 'site', 'kiosk'];

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
    /** 窓の実寸（m）。room モードの仮想の部屋で使う。壁の窓は幅＝奥行き方向、天窓は幅＝左右・高さ＝奥行き方向 */
    widthM: number;
    heightM: number;
    /** 床から窓の下端までの高さ（m）。天窓では使わない */
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
      side: c.oneOf(win, 'side', `${path}.window`, WINDOW_SIDES),
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
  c.problems.push(...windowFitProblems(entry, path));
  return entry;
}

/** 窓が部屋に収まるか。壁の窓は奥行き方向に並び、天窓は天井（幅×奥行き）に開く */
export function windowFitProblems(entry: Pick<SiteEntry, 'window' | 'room'>, path: string): string[] {
  const { window: w, room: r } = entry;
  const out: string[] = [];
  const need = (ok: boolean, msg: string): void => { if (!ok) out.push(msg); };
  if (w.side === 'ceiling') {
    need(w.widthM < r.widthM, `${path}.window.widthM（${w.widthM}）は天窓のとき ${path}.room.widthM（${r.widthM}）より小さくしてください`);
    need(w.heightM < r.depthM, `${path}.window.heightM（${w.heightM}）は天窓のとき ${path}.room.depthM（${r.depthM}）より小さくしてください`);
  } else {
    need(w.widthM < r.depthM, `${path}.window.widthM（${w.widthM}）は ${path}.room.depthM（${r.depthM}）より小さくしてください（壁の窓は奥行き方向に並ぶ）`);
    need(w.sillHeightM + w.heightM <= r.heightM, `${path}.window.sillHeightM + heightM（${w.sillHeightM + w.heightM}）は ${path}.room.heightM（${r.heightM}）以下にしてください`);
  }
  return out;
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

/**
 * .env で上書きできる値の名前（.env.example を参照）。.env は Git に上げないので、場所の緯度経度を公開せずに使える
 * - SORACITY_LATITUDE / SORACITY_LONGITUDE：太陽の計算に使う緯度経度（両方書く）
 * - SORACITY_SITE：上書きする場所（config/site.json の sites の名前）。書けば activeSite もこの場所にする。書かなければ activeSite
 */
export const ENV_KEYS = { latitude: 'SORACITY_LATITUDE', longitude: 'SORACITY_LONGITUDE', site: 'SORACITY_SITE' } as const;

/** .env の値（空の値は書いていないのと同じ） */
const envValue = (env: Record<string, unknown>, key: string): string | null => {
  const v = env[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
};

/** .env に書いた緯度経度（両方あり、数として読めるときだけ）。site モードなど、config/site.json を使わない所でも読む */
export function envLatLon(env: Record<string, unknown>): { latitude: number; longitude: number } | null {
  const lat = envValue(env, ENV_KEYS.latitude), lon = envValue(env, ENV_KEYS.longitude);
  if (lat === null || lon === null) return null;
  const latitude = Number(lat), longitude = Number(lon);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { latitude, longitude } : null;
}

/**
 * config/site.json の値に .env の値を重ねる。ブラウザ（Vite の import.meta.env）とアプリ（Electron の process.env）の両方から使う。
 * 書き方の誤り（片方だけ・数でない・範囲外・ない場所の名前）は ConfigError にする（黙って config の値で動くと、気づかずに違う場所で計算してしまう）
 */
export function applyEnvToSiteConfig(cfg: SiteConfig, env: Record<string, unknown>, file = '.env'): SiteConfig {
  const problems: string[] = [];
  const siteName = envValue(env, ENV_KEYS.site);
  if (siteName !== null && !(siteName in cfg.sites)) {
    problems.push(`${ENV_KEYS.site}="${siteName}" が config/site.json の sites にありません（あるもの: ${Object.keys(cfg.sites).join(', ')}）`);
  }
  const lat = envValue(env, ENV_KEYS.latitude), lon = envValue(env, ENV_KEYS.longitude);
  if ((lat === null) !== (lon === null)) problems.push(`${ENV_KEYS.latitude} と ${ENV_KEYS.longitude} は両方書いてください`);
  const ll = envLatLon(env);
  if (lat !== null && lon !== null && !ll) problems.push(`${ENV_KEYS.latitude} は -90〜90、${ENV_KEYS.longitude} は -180〜180 の数にしてください（現在: ${lat}, ${lon}）`);
  if (problems.length) throw new ConfigError(file, problems);
  const target = siteName ?? cfg.activeSite;
  if (!ll && siteName === null) return cfg;
  const entry = cfg.sites[target]!;
  return {
    activeSite: target,
    sites: { ...cfg.sites, [target]: ll ? { ...entry, latitude: ll.latitude, longitude: ll.longitude } : entry },
  };
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
