// STEP（ISO 10303-21、.step / .stp）の部屋の形を読み、光の計算に使う面（長方形・三角形）の一覧にする（three.js 非依存）。
// 読むのは平らな面（PLANE）だけ。曲面は読まずに、注意の一覧（warnings）に出す。
//
// 座標の決まり（docs/room-box.md と同じ）：y が上、奥が −z、手前が +z。単位はファイルの長さの単位から m に直す。
// 読んだ後、部屋の内側の範囲が x = −W/2〜W/2、y = 0（床）〜H、z = −D（奥）〜0（手前）になるようにずらす。
//
// 壁に厚みのある立体（中が空洞の箱）なら、外側の面を捨てて内側の面だけを使う。中の詰まった立体（部屋の空間そのもの）なら、全部の面を裏返して使う。
// 部屋の外枠（内側の範囲の 6 つの平面）に重なる面は、その面（右の壁・左の壁・天井・床・手前・奥）として扱い、窓・ガラスの設定が効く。
// それ以外の面（柱・くぼみの側面・細い縁など）は「部屋の中の物」として扱い、白い壁のまま（窓・ガラスにはならない）

export type Vec3 = [number, number, number];

/** 光の計算に使う面 1 枚。o を角に、u・v の 2 辺で張る平行四辺形（tri なら o・o+u・o+v の三角形） */
export interface RoomPrim {
  o: Vec3;
  u: Vec3;
  v: Vec3;
  tri: boolean;
  /** 面の番号：0 = 右の壁（+x）、1 = 左の壁（−x）、2 = 天井、3 = 床、4 = 手前、5 = 奥。部屋の中の物は 8 + 向き（部屋の内側を向く向きが一番近い面の番号） */
  face: number;
}

export interface RoomMesh {
  /** 部屋の内側の範囲の大きさ（m） */
  size: { widthM: number; depthM: number; heightM: number };
  prims: RoomPrim[];
  warnings: string[];
}

/** シェーダーに渡せる面の数の上限 */
export const MAX_ROOM_PRIMS = 64;
/** 部屋の外枠の平面からこれ以内（m）にある面は、外枠の面（窓・ガラスの設定が効く）として扱う */
const BOUNDARY_TOL_M = 0.02;
/** これより細い面（m）は、外枠の上にあっても縁（部屋の中の物）として扱う */
const MIN_BOUNDARY_SIZE_M = 0.1;

interface Face { loops: Vec3[][]; normal: Vec3 }

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => mul(a, 1 / (len(a) || 1));

/** DATA 部の文を「#番号 → (種類, 引数の文字列)」にする。複合の実体 #n=( A() B() ) は、種類を '' にして中身をそのまま持つ */
function readEntities(text: string): Map<number, { type: string; args: string }> {
  const data = text.slice(text.indexOf('DATA;') + 5);
  const out = new Map<number, { type: string; args: string }>();
  let start = 0;
  let quoted = false;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === "'") quoted = !quoted;
    else if (c === ';' && !quoted) {
      const stmt = data.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      start = i + 1;
      const m = /^#(\d+)\s*=\s*([A-Z0-9_]*)\s*\(([\s\S]*)\)$/.exec(stmt);
      if (m) out.set(Number(m[1]), { type: m[2]!, args: m[3]! });
    }
  }
  return out;
}

const refs = (s: string): number[] => [...s.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
const lastNumbers = (s: string): number[] => {
  const m = /\(([^()]*)\)\s*$/.exec(s);
  return m ? m[1]!.split(',').map(Number) : [];
};

/** 長さの単位（m）。GLOBAL_UNIT_ASSIGNED_CONTEXT の長さの単位から決める。分からなければ mm とみなす */
function lengthUnitM(ents: Map<number, { type: string; args: string }>): number {
  for (const e of ents.values()) {
    if (e.type !== '' || !e.args.includes('LENGTH_UNIT')) continue;
    const si = /SI_UNIT\(\s*([.$A-Z]+)\s*,\s*\.METRE\.\s*\)/.exec(e.args);
    if (si) {
      const prefix = si[1]!.replace(/\./g, '');
      return ({ MILLI: 1e-3, CENTI: 1e-2, DECI: 1e-1, KILO: 1e3 } as Record<string, number>)[prefix] ?? 1;
    }
    const conv = /CONVERSION_BASED_UNIT\(\s*'([^']*)'/.exec(e.args);
    if (conv) return ({ INCH: 0.0254, FOOT: 0.3048 } as Record<string, number>)[conv[1]!.toUpperCase()] ?? 1e-3;
  }
  return 1e-3;
}

/** STEP の平らな面を読む（m 単位。normal は立体の外向き） */
function readFaces(text: string, warnings: string[]): Face[] {
  const ents = readEntities(text);
  const unit = lengthUnitM(ents);
  const get = (id: number) => ents.get(id);
  const point = (id: number): Vec3 => mul(lastNumbers(get(id)!.args) as Vec3, unit);
  const direction = (id: number): Vec3 => norm(lastNumbers(get(id)!.args) as Vec3);
  const vertex = (id: number): Vec3 => point(refs(get(id)!.args)[0]!);
  const faces: Face[] = [];
  let curved = 0;
  for (const e of ents.values()) {
    if (e.type !== 'ADVANCED_FACE' && e.type !== 'FACE_SURFACE') continue;
    const r = refs(e.args);
    const surf = get(r[r.length - 1]!);
    if (!surf || surf.type !== 'PLANE') { curved++; continue; }
    const axis = refs(get(refs(surf.args)[0]!)!.args);
    const sameSense = !/\.F\.\s*$/.test(e.args);
    const normal = mul(direction(axis[1]!), sameSense ? 1 : -1);
    const loops: Vec3[][] = [];
    for (const b of r.slice(0, -1)) {
      const bound = get(b);
      if (!bound || !bound.type.includes('BOUND')) continue;
      const loop = get(refs(bound.args)[0]!);
      if (!loop || loop.type !== 'EDGE_LOOP') continue;
      const pts: Vec3[] = [];
      for (const oe of refs(loop.args)) {
        const oriented = get(oe)!;
        const forward = !/\.F\.\s*$/.test(oriented.args);
        const ec = refs(get(refs(oriented.args).at(-1)!)!.args);
        pts.push(vertex(forward ? ec[0]! : ec[1]!));
      }
      loops.push(pts);
    }
    if (loops.length > 0) faces.push({ loops, normal });
  }
  if (curved > 0) warnings.push(`平らでない面 ${curved} 枚は読んでいません（曲面はまだ使えません）`);
  return faces;
}

/** 点の集まりを囲む直方体 */
function bounds(points: Vec3[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, p[k]!); max[k] = Math.max(max[k]!, p[k]!); }
  return { min, max };
}

/** 平面上の多角形（2 次元）の中に点があるか */
function inside2(poly: [number, number][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** 近い値をまとめて、並べた一覧にする */
function uniqueSorted(values: number[], tol: number): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (out.length === 0 || v - out[out.length - 1]! > tol) out.push(v);
  return out;
}

/**
 * 面 1 枚を、長方形（と三角形）に分ける。辺がすべて 2 つの直交する向きに沿っている面は、頂点の座標の格子で区切って、
 * 面の中のます目を横・縦の順にまとめる（穴のある面もそのまま分けられる）。そうでない面は、外側の輪の三角形に分ける（穴は読まない）
 */
function splitFace(f: Face, warnings: string[]): { o: Vec3; u: Vec3; v: Vec3; tri: boolean }[] {
  const outer = f.loops[0]!;
  let e1: Vec3 | null = null;
  for (let i = 0; i < outer.length && !e1; i++) {
    const d = sub(outer[(i + 1) % outer.length]!, outer[i]!);
    if (len(d) > 1e-6) e1 = norm(d);
  }
  if (!e1) return [];
  const e2 = norm(cross(f.normal, e1));
  const origin = outer[0]!;
  const to2 = (p: Vec3): [number, number] => [dot(sub(p, origin), e1!), dot(sub(p, origin), e2)];
  const loops2 = f.loops.map((l) => l.map(to2));
  const rectilinear = loops2.every((l) => l.every((p, i) => {
    const q = l[(i + 1) % l.length]!;
    return Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6;
  }));
  const at = (a: number, b: number): Vec3 => add(origin, add(mul(e1!, a), mul(e2, b)));
  if (rectilinear) {
    const xs = uniqueSorted(loops2.flatMap((l) => l.map((p) => p[0])), 1e-6);
    const ys = uniqueSorted(loops2.flatMap((l) => l.map((p) => p[1])), 1e-6);
    const cell = (i: number, j: number): boolean => {
      const cx = (xs[i]! + xs[i + 1]!) / 2, cy = (ys[j]! + ys[j + 1]!) / 2;
      return inside2(loops2[0]!, cx, cy) && !loops2.slice(1).some((h) => inside2(h, cx, cy));
    };
    // 行ごとに横へつながったます目をまとめ、上の行と同じ幅なら縦にもまとめる
    const rects: { i0: number; i1: number; j0: number; j1: number }[] = [];
    let open: typeof rects = [];
    for (let j = 0; j < ys.length - 1; j++) {
      const runs: { i0: number; i1: number }[] = [];
      for (let i = 0; i < xs.length - 1; i++) {
        if (!cell(i, j)) continue;
        const last = runs[runs.length - 1];
        if (last && last.i1 === i) last.i1 = i + 1;
        else runs.push({ i0: i, i1: i + 1 });
      }
      const next: typeof rects = [];
      for (const r of runs) {
        const prev = open.find((o) => o.i0 === r.i0 && o.i1 === r.i1 && o.j1 === j);
        if (prev) { prev.j1 = j + 1; next.push(prev); } else { const n = { ...r, j0: j, j1: j + 1 }; rects.push(n); next.push(n); }
      }
      open = next;
    }
    return rects.map((r) => ({
      o: at(xs[r.i0]!, ys[r.j0]!),
      u: mul(e1!, xs[r.i1]! - xs[r.i0]!),
      v: mul(e2, ys[r.j1]! - ys[r.j0]!),
      tri: false,
    }));
  }
  if (f.loops.length > 1) warnings.push('斜めの辺と穴のある面は、穴を読まずに使っています');
  // 外側の輪を三角形に分ける（耳を切り取る方法）
  const poly = loops2[0]!.map((p, i) => ({ p, i }));
  const area = poly.reduce((s, { p }, i) => { const q = poly[(i + 1) % poly.length]!.p; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
  if (area < 0) poly.reverse();
  const tris: { o: Vec3; u: Vec3; v: Vec3; tri: boolean }[] = [];
  const crossZ = (a: [number, number], b: [number, number], c: [number, number]): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let guard = 0;
  while (poly.length > 3 && guard++ < 1000) {
    let cut = false;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[(k + poly.length - 1) % poly.length]!.p, b = poly[k]!.p, c = poly[(k + 1) % poly.length]!.p;
      if (crossZ(a, b, c) <= 1e-12) continue;
      const tri: [number, number][] = [a, b, c];
      if (poly.some(({ p }) => p !== a && p !== b && p !== c && inside2(tri, p[0], p[1]))) continue;
      const A = at(...a), B = at(...b), C = at(...c);
      tris.push({ o: A, u: sub(B, A), v: sub(C, A), tri: true });
      poly.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (poly.length === 3) {
    const [a, b, c] = poly.map(({ p }) => at(...p)) as [Vec3, Vec3, Vec3];
    tris.push({ o: a, u: sub(b, a), v: sub(c, a), tri: true });
  }
  return tris;
}

/** 部屋の内側を向く向きから、面の番号（0〜5）を決める */
function faceOf(inward: Vec3): number {
  const ax = [Math.abs(inward[0]), Math.abs(inward[1]), Math.abs(inward[2])];
  const k = ax[0]! >= ax[1]! && ax[0]! >= ax[2]! ? 0 : ax[1]! >= ax[2]! ? 1 : 2;
  const negative = inward[k]! < 0;
  return k * 2 + (negative ? 0 : 1);
}

/** STEP の文字列から、部屋の面の一覧を作る */
export function roomMeshFromStep(text: string): RoomMesh {
  const warnings: string[] = [];
  const faces = readFaces(text, warnings);
  if (faces.length === 0) throw new Error('平らな面が見つかりません');

  // 立体の体積（面ごとの「平面までの距離 × 面積 / 3」の和）が、囲む直方体の半分より小さければ、壁に厚みのある中が空洞の立体。
  // そのときは外側（囲む直方体の面の上で、外を向く面）を捨て、残りの面の外向きが部屋の内側を向く。
  // そうでなければ、立体が部屋の空間そのもの（柱は穴、くぼみは出っ張り）で、全部の面を裏返す
  const all = bounds(faces.flatMap((f) => f.loops[0]!));
  const box = (all.max[0] - all.min[0]) * (all.max[1] - all.min[1]) * (all.max[2] - all.min[2]);
  const loopArea = (l: Vec3[], n: Vec3): number => Math.abs(dot(l.reduce((a, p, i) => add(a, cross(p, l[(i + 1) % l.length]!)), [0, 0, 0] as Vec3), n)) / 2;
  const volume = Math.abs(faces.reduce((v, f) => {
    const area = loopArea(f.loops[0]!, f.normal) - f.loops.slice(1).reduce((a, h) => a + loopArea(h, f.normal), 0);
    return v + (dot(f.normal, f.loops[0]![0]!) * area) / 3;
  }, 0));
  const hollow = volume < box * 0.5;
  const isOuter = (f: Face): boolean => {
    const k = faceOf(mul(f.normal, -1)) >> 1;
    const plane = f.normal[k]! > 0 ? all.max[k]! : all.min[k]!;
    return Math.abs(f.normal[k]!) > 0.99 && f.loops[0]!.every((p) => Math.abs(p[k]! - plane) < 1e-5);
  };
  const room = hollow ? faces.filter((f) => !isOuter(f)) : faces;
  const flip = hollow ? 1 : -1;
  if (room.length === 0) throw new Error('部屋の内側の面が見つかりません');

  // 部屋の内側の範囲に合わせてずらす（x は中央、床を 0、手前を 0）
  const inner = bounds(room.flatMap((f) => f.loops.flat()));
  const shift: Vec3 = [-(inner.min[0] + inner.max[0]) / 2, -inner.min[1], -inner.max[2]];
  const size = { widthM: inner.max[0] - inner.min[0], heightM: inner.max[1] - inner.min[1], depthM: inner.max[2] - inner.min[2] };
  const lo = add(inner.min, shift), hi = add(inner.max, shift);
  // 面の番号ごとの、外枠の平面（0 = +x の壁 … 5 = −z の奥）
  const planes = [hi[0], lo[0], hi[1], lo[1], hi[2], lo[2]];

  const prims: RoomPrim[] = [];
  for (const f of room) {
    const inward = mul(f.normal, flip);
    const dir = faceOf(inward);
    const axis = dir >> 1;
    for (const piece of splitFace({ loops: f.loops.map((l) => l.map((p) => add(p, shift))), normal: inward }, warnings)) {
      const corners = piece.tri ? [piece.o, add(piece.o, piece.u), add(piece.o, piece.v)]
        : [piece.o, add(piece.o, piece.u), add(piece.o, piece.v), add(piece.o, add(piece.u, piece.v))];
      const onPlane = corners.every((p) => Math.abs(p[axis]! - planes[dir]!) <= BOUNDARY_TOL_M);
      const wide = Math.min(len(piece.u), len(piece.v)) >= MIN_BOUNDARY_SIZE_M;
      prims.push({ ...piece, face: onPlane && wide ? dir : dir + 8 });
    }
  }
  if (prims.length > MAX_ROOM_PRIMS) {
    warnings.push(`面が多すぎるので、${MAX_ROOM_PRIMS} 枚までを使っています（全部で ${prims.length} 枚）`);
    prims.length = MAX_ROOM_PRIMS;
  }
  return { size, prims, warnings: [...new Set(warnings)] };
}
