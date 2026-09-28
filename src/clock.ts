// 表示する時刻。現在時刻に追従するか、指定時刻から早送りする。現地時刻は config の UTC オフセットで計算する
export interface LocalParts { y: number; mo: number; d: number; min: number; sec: number }

export class Clock {
  utcMs = Date.now();
  live = true;
  playing = false;
  /** 早送り倍率（1 = 実時間） */
  speed = 600;
  private readonly offsetMs: number;

  constructor(utcOffsetMinutes: number) {
    this.offsetMs = utcOffsetMinutes * 60000;
  }

  tick(dtSec: number): void {
    if (this.live) this.utcMs = Date.now();
    else if (this.playing) this.utcMs += dtSec * 1000 * this.speed;
  }

  get date(): Date {
    return new Date(this.utcMs);
  }

  local(utcMs = this.utcMs): LocalParts {
    const d = new Date(utcMs + this.offsetMs);
    return {
      y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(),
      min: d.getUTCHours() * 60 + d.getUTCMinutes(), sec: d.getUTCSeconds(),
    };
  }

  utcFromLocal(y: number, mo: number, d: number, min: number): number {
    return Date.UTC(y, mo, d, 0, min) - this.offsetMs;
  }

  setLive(on: boolean): void {
    this.live = on;
    if (on) this.playing = false;
  }

  /** その日の中で時刻だけ変える（0〜1440 分） */
  setLocalMinutes(min: number): void {
    this.live = false;
    const { y, mo, d } = this.local();
    this.utcMs = this.utcFromLocal(y, mo, d, min);
  }

  /** 時刻はそのままで日付を変える。"YYYY-MM-DD" */
  setLocalDate(ymd: string): boolean {
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    this.live = false;
    this.utcMs = this.utcFromLocal(Number(m[1]), Number(m[2]) - 1, Number(m[3]), this.local().min);
    return true;
  }

  /** "YYYY-MM-DDTHH:MM"（現地時刻）を開始時刻にする */
  setFromParam(value: string | null): boolean {
    const t = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!t) return false;
    this.live = false;
    this.utcMs = this.utcFromLocal(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]) * 60 + Number(t[5]));
    return true;
  }

  format(): string {
    const p = this.local();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const off = this.offsetMs / 3600000;
    return `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}  ${pad(Math.floor(p.min / 60))}:${pad(p.min % 60)}:${pad(p.sec)}  (UTC${off >= 0 ? '+' : ''}${off})`;
  }

  ymd(): string {
    const p = this.local();
    return `${p.y}-${String(p.mo + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }
}
