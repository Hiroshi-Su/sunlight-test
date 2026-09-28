// GPU が実際に描画にかけた時間を計る（EXT_disjoint_timer_query_webgl2）。
// 結果は数フレーム遅れて届くので、描画を止めずに後から回収する。
interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

const MAX_PENDING = 6;
const WINDOW = 120;

export interface GpuStats {
  avg: number;
  max: number;
}

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt | null;
  private pending: { query: WebGLQuery; label: string }[] = [];
  private samples = new Map<string, number[]>();
  private active = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  /** 同時に 1 区間だけ計れる。未回収が多いときは計らない（描画は止めない） */
  begin(label: string): void {
    if (!this.ext || this.active || this.pending.length >= MAX_PENDING) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.pending.push({ query, label });
    this.active = true;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
  }

  /** 結果が届いたものを回収する。毎フレーム呼ぶ */
  poll(): void {
    if (!this.ext) return;
    const gl = this.gl;
    // GPU のクロック変化などで計測が乱れたときは、その回の結果を捨てる
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    const still: typeof this.pending = [];
    for (const p of this.pending) {
      const isOpen = this.active && p === this.pending[this.pending.length - 1];
      if (isOpen || !gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) {
        still.push(p);
        continue;
      }
      if (!disjoint) {
        const ms = (gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number) / 1e6;
        const arr = this.samples.get(p.label) ?? [];
        arr.push(ms);
        if (arr.length > WINDOW) arr.shift();
        this.samples.set(p.label, arr);
      }
      gl.deleteQuery(p.query);
    }
    this.pending = still;
  }

  stats(label: string): GpuStats | null {
    const arr = this.samples.get(label);
    if (!arr?.length) return null;
    return { avg: arr.reduce((a, b) => a + b, 0) / arr.length, max: Math.max(...arr) };
  }
}
