// Electron（main / preload）と描画側で共有する型
import type { AppMode, SiteConfig, VisualsConfig } from './config.ts';

export interface Heartbeat {
  fps: number;
  heapMB: number | null;
  sun: { az: number; alt: number };
  entersWindow: boolean;
  lit: number;
  /** 1 フレームの GPU 時間の平均（ms）。計測できない環境では null */
  gpuMs: number | null;
}

export interface Bootstrap {
  mode: AppMode;
  site: SiteConfig;
  visuals: VisualsConfig;
  /** config/room.json の中身（なければ null。中身の確かめは描画側で寛容に行う） */
  room: unknown;
}

export type ReportData = Record<string, unknown>;

export interface SoracityBridge {
  mode: AppMode;
  config: SiteConfig;
  visuals: VisualsConfig;
  /** config/visuals.json に書き込む（main 側で検証する） */
  saveVisuals(cfg: VisualsConfig): Promise<void>;
  /** room モードの設定（config/room.json の中身） */
  room: unknown;
  /** config/room.json に書き込む */
  saveRoom(file: unknown): Promise<void>;
  heartbeat(data: Heartbeat): void;
  /** モードを切り替える（main 側でウィンドウを作り直す。展示モードは枠なしウィンドウになるため） */
  setMode(mode: AppMode): void;
  report(type: string, data?: ReportData): void;
}

export const IPC = {
  bootstrap: 'bootstrap',
  heartbeat: 'heartbeat',
  report: 'report',
  saveVisuals: 'save-visuals',
  saveRoom: 'save-room',
  setMode: 'set-mode',
} as const;

declare global {
  interface Window {
    soracity?: SoracityBridge;
  }
}
