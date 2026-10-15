// room モードのパネルの今の値を、同じブラウザ（アプリ）の他の画面と分け合う。
// 「部屋の設定を保存」（config/room.json）とは別で、ファイルは書かない。保存を押さなくても、パネルを動かせば届く。
// 書き込みは localStorage。別のタブで開いている画面には storage イベントで届き、あとから開いた画面は開いたときに読む
import type { RoomSettingsFile } from './settings-file.ts';

const KEY = 'soracity-room-live';

export interface LiveRoomSettings {
  /** 書き込んだ時刻（ms） */
  at: number;
  file: RoomSettingsFile;
}

const parse = (raw: string | null): LiveRoomSettings | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LiveRoomSettings>;
    return typeof v.at === 'number' && v.file && typeof v.file === 'object' ? (v as LiveRoomSettings) : null;
  } catch {
    return null;
  }
};

/** 今の値を書き込む（localStorage が使えない環境では何もしない） */
export function publishRoomSettings(file: RoomSettingsFile): void {
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), file })); } catch { /* 使えない環境 */ }
}

/** 最後に書き込まれた値（なければ null） */
export function readRoomSettings(): LiveRoomSettings | null {
  try { return parse(localStorage.getItem(KEY)); } catch { return null; }
}

/** 別の画面で値が書き込まれたら呼ぶ。戻り値で止める */
export function onRoomSettings(cb: (v: LiveRoomSettings) => void): () => void {
  const listener = (e: StorageEvent): void => {
    if (e.key !== KEY) return;
    const v = parse(e.newValue);
    if (v) cb(v);
  };
  addEventListener('storage', listener);
  return () => removeEventListener('storage', listener);
}

/**
 * パネルの値を見張り、変わったら書き込む（0.5 秒おきに比べる。パネルの操作の種類によらず、変わったものは必ず届く）
 * @param collect パネルの今の値をまとめる関数
 */
export function shareRoomSettings(collect: () => RoomSettingsFile, intervalMs = 500): () => void {
  let last = '';
  const tick = (): void => {
    const file = collect();
    const s = JSON.stringify(file);
    if (s === last) return;
    last = s;
    publishRoomSettings(file);
  };
  tick();
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}
