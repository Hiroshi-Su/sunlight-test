// visuals モードの UI：映像の選択・調整パネル（lil-gui）と現在値の表示
import GUI from 'lil-gui';
import type { Clock } from '../clock.ts';
import type { ParamValues, VisualsConfig } from '../config.ts';
import { kelvinAt } from '../palette.ts';
import { SCENES, findScene } from '../scenes/index.ts';
import { type SceneDef, defaultParams, mergeParams } from '../scenes/types.ts';
import type { SolarState } from '../solar.ts';
import { el } from './dom.ts';

export interface VisualsHooks {
  save(cfg: VisualsConfig): Promise<void>;
  savePng(): void;
}

export interface VisualsView {
  arrow: boolean;
  guides: boolean;
}

const SPEEDS: Record<string, number> = {
  '1×（実時間）': 1,
  '60×（1分/秒）': 60,
  '600×（10分/秒）': 600,
  '1440×（1日/1分）': 1440,
  '3600×（1時間/秒）': 3600,
};

export function mountVisuals(clock: Clock, initial: VisualsConfig, hooks: VisualsHooks) {
  const cfg: VisualsConfig = structuredClone(initial);
  const view: VisualsView = { arrow: false, guides: true };
  const sceneValues: Record<string, ParamValues> = {};
  const valuesFor = (def: SceneDef): ParamValues => (sceneValues[def.id] ??= mergeParams(def, cfg.scenes[def.id]));
  let active = findScene(cfg.activeScene);
  cfg.activeScene = active.id;

  const gui = new GUI({ container: el('panel', HTMLElement), width: 380, title: 'visuals' });

  // ---- 時刻（getter/setter で Clock に直結）----
  const t = {
    get label() { return clock.format(); },
    get live() { return clock.live; },
    set live(v: boolean) { clock.setLive(v); },
    get playing() { return clock.playing; },
    set playing(v: boolean) { clock.setLive(false); clock.playing = v; },
    get speed() { return clock.speed; },
    set speed(v: number) { clock.speed = Number(v); },
    get minutes() { return clock.local().min; },
    set minutes(v: number) { clock.setLocalMinutes(v); },
    get date() { return clock.ymd(); },
    set date(v: string) { clock.setLocalDate(v); },
    fastDay() {
      clock.setLocalMinutes(0);
      clock.speed = 1440;
      clock.playing = true;
    },
  };
  const ft = gui.addFolder('時刻');
  ft.add(t, 'label').name('表示中').disable().listen();
  ft.add(t, 'live').name('現在時刻').listen();
  ft.add(t, 'playing').name('再生').listen();
  ft.add(t, 'speed', SPEEDS).name('速さ').listen();
  ft.add(t, 'minutes', 0, 1439, 1).name('時刻（分）').listen();
  ft.add(t, 'date').name('日付 YYYY-MM-DD').listen();
  ft.add(t, 'fastDay').name('1日を1分で早送り');

  // ---- シーン ----
  const fs = gui.addFolder('シーン');
  const sceneSel = { id: active.id };
  const options = Object.fromEntries(SCENES.map((s) => [s.label, s.id]));
  let paramsFolder: GUI | null = null;
  const buildParams = (): void => {
    paramsFolder?.destroy();
    paramsFolder = fs.addFolder('パラメータ');
    const values = valuesFor(active);
    for (const [key, spec] of Object.entries(active.params)) {
      if (spec.type === 'number') paramsFolder.add(values, key, spec.min, spec.max, spec.step).name(spec.label);
      else if (spec.type === 'color') paramsFolder.addColor(values, key).name(spec.label);
      else paramsFolder.add(values, key).name(spec.label);
    }
    paramsFolder.add({
      reset: () => {
        Object.assign(values, defaultParams(active));
        paramsFolder?.controllersRecursive().forEach((c) => c.updateDisplay());
      },
    }, 'reset').name('既定値に戻す');
  };
  fs.add(sceneSel, 'id', options).name('映像').onChange((id: string) => {
    active = findScene(id);
    cfg.activeScene = active.id;
    buildParams();
  });
  buildParams();

  // ---- プレビュー（visuals モードだけの確認用。kiosk には出ない）----
  const fp = gui.addFolder('プレビュー');
  fp.add(cfg.preview, 'wash', 0, 0.8, 0.01).name('外光シミュレーション');
  fp.add(cfg.preview, 'washFollowsSun').name('日差しに連動');
  fp.add(view, 'arrow').name('矢印（D）').listen();
  fp.add(view, 'guides').name('ガイド（G）').listen();
  fp.add(cfg.guides, 'seamSpacingPx', 0, 1920, 1).name('継ぎ目の間隔 px');
  fp.add(cfg.guides, 'seamOffsetPx', 0, 1920, 1).name('継ぎ目の開始 px');
  fp.add(cfg.guides, 'overlapPx', 0, 1920, 1).name('投影の重なり幅 px');

  // ---- 出力（kiosk にも効く）----
  const fo = gui.addFolder('出力');
  fo.add(cfg.output, 'min', 0, 0.5, 0.01).name('明るさの下限');
  fo.add(cfg.output, 'max', 0.5, 1, 0.01).name('明るさの上限');

  // ---- 書き出し・保存 ----
  const status = { text: '' };
  const fx = gui.addFolder('保存');
  fx.add({ png: () => hooks.savePng() }, 'png').name('PNG 書き出し（3840×1080）');
  fx.add({
    save: async () => {
      status.text = '保存中…';
      try {
        await hooks.save(snapshot());
        status.text = `保存しました ${new Date().toLocaleTimeString()}`;
      } catch (err) {
        status.text = `保存できません: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }, 'save').name('設定を保存（config/visuals.json）');
  fx.add(status, 'text').name('状態').disable().listen();

  const snapshot = (): VisualsConfig => ({
    ...structuredClone(cfg),
    scenes: { ...structuredClone(cfg.scenes), ...structuredClone(sceneValues) },
  });

  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === 'd') view.arrow = !view.arrow;
    if (k === 'g') view.guides = !view.guides;
  });

  const statusEl = el('vstatus', HTMLElement);

  return {
    view,
    get scene(): SceneDef { return active; },
    get params(): ParamValues { return valuesFor(active); },
    get config(): VisualsConfig { return cfg; },
    updateStatus(s: SolarState, lit: number): void {
      const { sun, light } = s;
      statusEl.textContent = [
        clock.format(),
        `太陽  方位 ${sun.azimuth.toFixed(1)}°  高度 ${sun.altitude.toFixed(1)}°`,
        `light (${light.x.toFixed(3)}, ${light.y.toFixed(3)}, ${light.z.toFixed(3)})`,
        `窓から ${light.entersWindow ? '入る' : '入らない'}  lit ${lit.toFixed(2)}  ${Math.round(kelvinAt(sun.altitude))}K`,
      ].join('\n');
    },
  };
}
