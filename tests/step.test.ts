import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roomMeshFromStep, type Vec3 } from '../src/room/step.ts';

/** 平らな面の一覧から、最小限の STEP（mm）を作る。face.normal は立体の外向き、loops[0] が外側の輪、残りが穴 */
function makeStep(faces: { loops: Vec3[][]; normal: Vec3 }[]): string {
  const lines: string[] = [];
  let n = 100;
  const add = (s: string): number => { lines.push(`#${++n}=${s};`); return n; };
  const faceIds: number[] = [];
  for (const f of faces) {
    const bounds: number[] = [];
    f.loops.forEach((loop, li) => {
      const verts = loop.map((p) => add(`VERTEX_POINT('',#${add(`CARTESIAN_POINT('',(${p.join(',')}))`)})`));
      const edges = verts.map((v, i) => add(`ORIENTED_EDGE('',*,*,#${add(`EDGE_CURVE('',#${v},#${verts[(i + 1) % verts.length]},#1,.T.)`)},.T.)`));
      const el = add(`EDGE_LOOP('',(${edges.map((e) => `#${e}`).join(',')}))`);
      bounds.push(add(`${li === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${el},.T.)`));
    });
    const ref: Vec3 = Math.abs(f.normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const axis = add(`AXIS2_PLACEMENT_3D('',#${add(`CARTESIAN_POINT('',(${f.loops[0]![0]!.join(',')}))`)},#${add(`DIRECTION('',(${f.normal.join(',')}))`)},#${add(`DIRECTION('',(${ref.join(',')}))`)})`);
    faceIds.push(add(`ADVANCED_FACE('',(${bounds.map((b) => `#${b}`).join(',')}),#${add(`PLANE('',#${axis})`)},.T.)`));
  }
  add('(\nLENGTH_UNIT()\nNAMED_UNIT(*)\nSI_UNIT(.MILLI.,.METRE.)\n)');
  return `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

/** 直方体の 6 面（外向き）。hole は床と天井に開ける四角い穴（柱を通すため） */
function boxFaces(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, hole?: [number, number, number, number]) {
  const h = (y: number): Vec3[][] => (hole ? [[[hole[0], y, hole[2]], [hole[1], y, hole[2]], [hole[1], y, hole[3]], [hole[0], y, hole[3]]]] : []);
  return [
    { normal: [1, 0, 0] as Vec3, loops: [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]] as Vec3[][] },
    { normal: [-1, 0, 0] as Vec3, loops: [[[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]] as Vec3[][] },
    { normal: [0, 1, 0] as Vec3, loops: [[[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]] as Vec3[], ...h(y1)] },
    { normal: [0, -1, 0] as Vec3, loops: [[[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] as Vec3[], ...h(y0)] },
    { normal: [0, 0, 1] as Vec3, loops: [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]] as Vec3[][] },
    { normal: [0, 0, -1] as Vec3, loops: [[[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]] as Vec3[][] },
  ];
}

test('STEP の部屋の形：部屋の空間そのものの立体（mm）は、m に直して内側を向く 6 面になり、床 0・手前 0・左右の中央 0 にそろう', () => {
  const mesh = roomMeshFromStep(makeStep(boxFaces(1000, 5000, 200, 2700, -3500, -500)));
  assert.deepEqual(mesh.size, { widthM: 4, heightM: 2.5, depthM: 3 });
  assert.deepEqual(mesh.prims.map((p) => p.face).sort(), [0, 1, 2, 3, 4, 5]);
  const floor = mesh.prims.find((p) => p.face === 3)!;
  assert.ok(Math.abs(floor.o[1]) < 1e-9);
  const xs = mesh.prims.flatMap((p) => [p.o[0], p.o[0] + p.u[0] + p.v[0]]);
  assert.ok(Math.abs(Math.min(...xs) + 2) < 1e-9 && Math.abs(Math.max(...xs) - 2) < 1e-9);
  const zs = mesh.prims.flatMap((p) => [p.o[2], p.o[2] + p.u[2] + p.v[2]]);
  assert.ok(Math.abs(Math.max(...zs)) < 1e-9 && Math.abs(Math.min(...zs) + 3) < 1e-9);
});

test('STEP の部屋の形：柱の穴のある床は長方形に分かれ（面積が合う）、柱の側面は部屋の中の物（8 + 向き）になる', () => {
  // 部屋の空間 4 × 2.5 × 3 m の真ん中に 0.4m 角の柱。柱の側面の外向きは柱の中を向く
  const room = boxFaces(0, 4000, 0, 2500, -3000, 0, [1800, 2200, -1700, -1300]);
  const pillar = boxFaces(1800, 2200, 0, 2500, -1700, -1300).slice(0, 2).concat(boxFaces(1800, 2200, 0, 2500, -1700, -1300).slice(4))
    .map((f) => ({ ...f, normal: f.normal.map((c) => -c) as Vec3 }));
  const mesh = roomMeshFromStep(makeStep([...room, ...pillar]));
  const area = (face: number): number => mesh.prims.filter((p) => p.face === face)
    .reduce((s, p) => s + Math.hypot(p.u[1] * p.v[2] - p.u[2] * p.v[1], p.u[2] * p.v[0] - p.u[0] * p.v[2], p.u[0] * p.v[1] - p.u[1] * p.v[0]), 0);
  assert.ok(Math.abs(area(3) - (12 - 0.16)) < 1e-6, `床の面積 ${area(3)}`);
  assert.ok(Math.abs(area(2) - (12 - 0.16)) < 1e-6, `天井の面積 ${area(2)}`);
  // 柱の側面：+x を向く面は「左の壁と同じ向き」（1）の物 = 9、−x を向く面は 8、+z は 13、−z は 12
  assert.deepEqual(mesh.prims.filter((p) => p.face >= 8).map((p) => p.face).sort(), [12, 13, 8, 9].sort());
  // 柱の +x 側の面は、部屋の内側（+x）を向いている（外枠の面ではない）
  assert.equal(mesh.prims.filter((p) => p.face < 8).length >= 6, true);
});

test('STEP の部屋の形：細い面（10cm 未満）は外枠の平面の上にあっても縁（部屋の中の物）として扱う', () => {
  // 奥の壁の 1 か所に、外枠の平面から 15mm 手前の幅 5cm の帯（スクリーンの枠のような縁）
  const room = boxFaces(0, 4000, 0, 2500, -3000, 0);
  const strip = { normal: [0, 0, 1] as Vec3, loops: [[[1000, 0, -2985], [1050, 0, -2985], [1050, 2500, -2985], [1000, 2500, -2985]]] as Vec3[][] };
  // 部屋の空間の立体なので、帯の外向き（+z）を逆にして渡す（内側を向く向きが +z になるように）
  const mesh = roomMeshFromStep(makeStep([...room, { ...strip, normal: [0, 0, -1] }]));
  const s = mesh.prims.find((p) => Math.abs(p.o[2] + 2.985) < 1e-9)!;
  assert.equal(s.face, 13);
});
