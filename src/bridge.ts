// Electron（main / preload）と描画側で共有する型
import type { AppMode, SiteConfig, VisualsConfig } from './config.ts';

export interface Heartbeat {
  fps: number;
  heapMB: number | null;
  sun: { az: number; alt: number };
  entersWindow: boolean;
  lit: number;
}

export interface Bootstrap {
  mode: AppMode;
  site: SiteConfig;
  visuals: VisualsConfig;
}

export type ReportData = Record<string, unknown>;

export interface SoracityBridge {
  mode: AppMode;
  config: SiteConfig;
  visuals: VisualsConfig;
  /** config/visuals.json に書き込む（main 側で検証する） */
  saveVisuals(cfg: VisualsConfig): Promise<void>;
  heartbeat(data: Heartbeat): void;
  report(type: string, data?: ReportData): void;
}

export const IPC = {
  bootstrap: 'bootstrap',
  heartbeat: 'heartbeat',
  report: 'report',
  saveVisuals: 'save-visuals',
} as const;

declare global {
  interface Window {
    soracity?: SoracityBridge;
  }
}
