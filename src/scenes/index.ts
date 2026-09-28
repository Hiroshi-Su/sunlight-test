// 映像の一覧。新しい映像はファイルを作ってここに追加する（パネルのシーン選択に並ぶ）
import { colorField } from './color-field.ts';
import { drip } from './image/drip.ts';
import { droplets } from './image/droplets.ts';
import { glowContour } from './image/glow-contour.ts';
import { heatHaze } from './image/heat-haze.ts';
import { photo } from './image/photo.ts';
import { pixelStretch } from './image/pixel-stretch.ts';
import { prism } from './image/prism.ts';
import { water } from './image/water.ts';
import { inkBleed } from './ink-bleed.ts';
import { lightDebug } from './light-debug.ts';
import type { SceneDef } from './types.ts';

export const SCENES: readonly SceneDef[] = [
  lightDebug, colorField, inkBleed,
  photo, droplets, prism, water, glowContour, heatHaze, drip, pixelStretch,
];

export function findScene(id: string): SceneDef {
  return SCENES.find((s) => s.id === id) ?? lightDebug;
}
