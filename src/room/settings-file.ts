// room モードの設定の保存（config/room.json）。パネルで合わせた値（窓・部屋の寸法・光の計算・水・雲・スクリーン・ライト・
// 解像度・パース合わせ・四隅の位置合わせ）を保存し、次に開いたときに読む。読む順は「コードの既定 → 保存した値 → URL」。
// 保存したファイルの読み込みは寛容にする：既定の値と同じ種類の項目だけを使い、知らない項目・種類の違う項目は無視する
// （古い版で保存したファイルや、手で直して誤ったファイルでも、読める項目だけで動き続ける）

/** 保存する中身（各項目の形は、パネルの値と同じ） */
export interface RoomSettingsFile {
  version: 1;
  /** 窓の位置（right / left / ceiling） */
  windowSide: string;
  [section: string]: unknown;
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * defaults と同じ形の値を、raw から読めるところだけ取り出して重ねる。
 * 数は有限のものだけ、文字列・真偽値は同じ種類のものだけ。配列は既定と同じ長さで、要素ごとに重ねる
 */
export function mergeKnown<T>(defaults: T, raw: unknown): T {
  if (Array.isArray(defaults)) {
    if (!Array.isArray(raw)) return defaults;
    return defaults.map((d, i) => mergeKnown(d, raw[i])) as T;
  }
  if (isPlain(defaults)) {
    if (!isPlain(raw)) return defaults;
    const out: Plain = { ...defaults };
    for (const k of Object.keys(defaults)) out[k] = mergeKnown(defaults[k], raw[k]);
    return out as T;
  }
  if (typeof defaults === 'number') return (typeof raw === 'number' && Number.isFinite(raw) ? raw : defaults) as T;
  if (typeof defaults === 'string') return (typeof raw === 'string' ? raw : defaults) as T;
  if (typeof defaults === 'boolean') return (typeof raw === 'boolean' ? raw : defaults) as T;
  return defaults;
}

/** 決まった選択肢の中にあればその値、なければ既定 */
export const oneOf = <T extends string>(v: string, options: readonly T[], fallback: T): T =>
  (options as readonly string[]).includes(v) ? (v as T) : fallback;
