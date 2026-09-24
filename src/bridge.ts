// Electron（main / preload）と描画側で共有する型
import type { AppMode, SiteConfig } from './config.ts';

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
}

export type ReportData = Record<string, unknown>;

export interface SoracityBridge {
  mode: AppMode;
  config: SiteConfig;
  heartbeat(data: Heartbeat): void;
  report(type: string, data?: ReportData): void;
}

export const IPC = {
  bootstrap: 'bootstrap',
  heartbeat: 'heartbeat',
  report: 'report',
} as const;

declare global {
  interface Window {
    soracity?: SoracityBridge;
  }
}
