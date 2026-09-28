// 映像の一覧。新しい映像はファイルを作ってここに追加する（パネルのシーン選択に並ぶ）
import { colorField } from './color-field.ts';
import { inkBleed } from './ink-bleed.ts';
import { lightDebug } from './light-debug.ts';
import type { SceneDef } from './types.ts';

export const SCENES: readonly SceneDef[] = [lightDebug, colorField, inkBleed];

export function findScene(id: string): SceneDef {
  return SCENES.find((s) => s.id === id) ?? lightDebug;
}
