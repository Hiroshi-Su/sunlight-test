import type { Backend, GpuReport } from '../stage.ts';

const BUDGET_MS = 1000 / 60;

/** 画面に出す性能の表示。GPU 時間は 60fps の持ち時間（16.7ms）に対する割合も出す */
export const BACKEND_LABEL: Record<Backend, string> = { webgpu: 'WebGPU', webgl: 'WebGL2' };

export function formatPerf(gpu: GpuReport, fps: number, backend: Backend): string[] {
  // 倍率：画面の 1 画素あたりの CSS の画素（devicePixelRatio）。展示の PC では 1 のはず（config/app.json の forceDeviceScaleFactor）
  const lines = [`FPS ${fps.toFixed(1)}  描画 ${BACKEND_LABEL[backend]}  倍率 ${devicePixelRatio}`];
  if (!gpu.supported) return [...lines, 'GPU 時間：この環境では計測できません'];
  if (!gpu.scene || !gpu.final) return [...lines, 'GPU 時間：計測中…'];
  const total = gpu.scene.avg + gpu.final.avg;
  lines.push(
    `GPU 合計 ${total.toFixed(2)} ms（60fps の ${Math.round((total / BUDGET_MS) * 100)}%）${gpu.approximate ? '※macOS では参考値。正確にはベンチマーク' : ''}`,
    `  映像 ${gpu.scene.avg.toFixed(2)} ms（最大 ${gpu.scene.max.toFixed(2)}）  最終処理 ${gpu.final.avg.toFixed(2)} ms`,
  );
  return lines;
}

export function formatBench(ms: number, sceneLabel: string): string {
  return `ベンチマーク：${sceneLabel} 1 フレーム ${ms.toFixed(2)} ms（60fps の ${Math.round((ms / BUDGET_MS) * 100)}%、最大 ${Math.floor(1000 / ms)} fps 相当）`;
}

export function gpuTotalMs(gpu: GpuReport): number | null {
  return gpu.scene && gpu.final ? Math.round((gpu.scene.avg + gpu.final.avg) * 100) / 100 : null;
}
