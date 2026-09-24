// sandbox 下の preload は CommonJS で読み込まれるため、ビルドで dist-electron/preload.cjs に変換する
import { contextBridge, ipcRenderer } from 'electron';
import { type Bootstrap, IPC, type SoracityBridge } from '../src/bridge.ts';

const boot = ipcRenderer.sendSync(IPC.bootstrap) as Bootstrap;

const bridge: SoracityBridge = {
  mode: boot.mode,
  config: boot.site,
  heartbeat: (data) => ipcRenderer.send(IPC.heartbeat, data),
  report: (type, data = {}) => ipcRenderer.send(IPC.report, { type, ...data }),
};

contextBridge.exposeInMainWorld('soracity', bridge);
