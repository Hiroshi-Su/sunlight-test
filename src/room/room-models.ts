// 読み込んだ部屋の形（STEP）の一覧。src/private/rooms/ に置いた .step / .stp を読む（公開しないフォルダ。ないときは四角い部屋だけ）。
// ファイルを置けば、room モードのパネルの「部屋の形」に出る。読み方は src/room/step.ts
import { type RoomMesh, roomMeshFromStep } from './step.ts';

export interface RoomModel {
  /** ファイル名（保存する値・URL の ?model= に使う） */
  id: string;
  mesh: RoomMesh | null;
  /** 読めなかったときの理由 */
  error?: string;
}

const files = import.meta.glob<string>('../private/rooms/*.{step,stp,STEP,STP}', { query: '?raw', import: 'default', eager: true });

export const ROOM_MODELS: RoomModel[] = Object.entries(files)
  .map(([path, text]): RoomModel => {
    const id = path.split('/').pop()!;
    try {
      return { id, mesh: roomMeshFromStep(text) };
    } catch (e) {
      return { id, mesh: null, error: e instanceof Error ? e.message : String(e) };
    }
  })
  .sort((a, b) => a.id.localeCompare(b.id));

/** 部屋の形の id から、読み込んだ面の一覧（四角い部屋・見つからない・読めないときは null） */
export function roomMesh(id: string): RoomMesh | null {
  return ROOM_MODELS.find((m) => m.id === id)?.mesh ?? null;
}
