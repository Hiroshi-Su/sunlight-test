// 映像（シーン）の共通インターフェース。新しい映像は SceneDef を作って scenes/index.ts に登録する。
import type * as THREE from 'three';
import type { ParamValues } from '../config.ts';
import type { RGB } from '../palette.ts';
import type { LightOnScreen, SunPosition } from '../solar.ts';

/** すべてのシーンが毎フレーム受け取る値 */
export interface SceneInput {
  sun: SunPosition;
  light: LightOnScreen;
  /** 窓から光が入っている度合い 0..1（急に変わらないよう平滑化済み） */
  lit: number;
  /** 太陽高度から決めた光の色温度（K）とその RGB */
  kelvin: number;
  lightColor: RGB;
  /** 太陽高度から決めた空の色 */
  sky: { top: RGB; bottom: RGB };
  /** 現地時刻（0〜1440 分） */
  localMinutes: number;
  /** 起動からの秒数（倍精度）。GPU へ渡すときは wrap() で巻き戻す */
  time: number;
  dt: number;
  width: number;
  height: number;
}

export type ParamSpec =
  | { type: 'number'; label: string; value: number; min: number; max: number; step?: number }
  | { type: 'color'; label: string; value: string }
  | { type: 'boolean'; label: string; value: boolean };

export interface SceneInstance {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  update(input: SceneInput, params: ParamValues): void;
  dispose(): void;
}

/**
 * このシーンが日差し由来の値をどう使っているかの申告。visuals モードのパネルに
 * 「日差しとの連動」として表示するためのもので、実装（update 内の計算）と食い違わないよう、
 * 対応するコードを変えたら必ずここも合わせて直すこと。
 */
export interface SunLink {
  /** オン・オフを切り替えるパラメータのキー。省略すると「常時（切替なし）」として表示 */
  toggle?: string;
  /** この申告が使う日差し由来の値 */
  uses: readonly ('direction' | 'lit' | 'altitude' | 'color')[];
}

export interface SceneDef {
  id: string;
  label: string;
  params: Record<string, ParamSpec>;
  /** 日差しの値との連動（省略時は「未対応」＝日差しの値を使わない） */
  sunLinks?: readonly SunLink[];
  create(size: { width: number; height: number }): SceneInstance;
}

export function defaultParams(def: SceneDef): ParamValues {
  return Object.fromEntries(Object.entries(def.params).map(([k, p]) => [k, p.value]));
}

/** 保存値を既定値に重ねる。型が合わない値は既定値に戻す */
export function mergeParams(def: SceneDef, saved: ParamValues | undefined): ParamValues {
  const out = defaultParams(def);
  for (const [k, spec] of Object.entries(def.params)) {
    const v = saved?.[k];
    if (spec.type === 'number' && typeof v === 'number') out[k] = v;
    if (spec.type === 'color' && typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) out[k] = v;
    if (spec.type === 'boolean' && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export const num = (p: ParamValues, k: string): number => (typeof p[k] === 'number' ? p[k] : 0);
export const bool = (p: ParamValues, k: string): boolean => p[k] === true;
export const color = (p: ParamValues, k: string): string => (typeof p[k] === 'string' ? p[k] : '#808080');
