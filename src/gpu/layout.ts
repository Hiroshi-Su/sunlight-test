// WebGPU：シェーダーに渡す値（uniform）の並べ方。
// 映像のコードは WebGL と同じ「名前 → { value }」の形で値を持つので、その値の種類から WGSL の構造体を自動で作り、
// 毎フレーム、同じ並びでバッファに書き込む。並べ方は WGSL の storage バッファの規則（型ごとの整列）に従う。
import * as THREE from 'three';

export type FieldType = 'f32' | 'vec2f' | 'vec3f' | 'vec4f' | 'mat4x4f' | `array<f32, ${number}>` | `array<vec2f, ${number}>` | `array<vec3f, ${number}>`;

export interface Field {
  name: string;
  type: FieldType;
  offset: number; // バイト
}

export interface Layout {
  fields: Field[];
  /** バッファの大きさ（バイト） */
  size: number;
  /** 画像（テクスチャ）の値の名前。構造体には入れず、別に結び付ける */
  textures: string[];
  /** WGSL の構造体の宣言 */
  wgsl: string;
}

type Uniforms = Record<string, { value: unknown }>;

// 型ごとの整列（バイト）と大きさ
const ALIGN: Record<string, [number, number]> = {
  f32: [4, 4], vec2f: [8, 8], vec3f: [16, 12], vec4f: [16, 16], mat4x4f: [16, 64],
};

const isTexture = (v: unknown): boolean => v instanceof THREE.Texture || v === null;

function typeOf(name: string, v: unknown): FieldType {
  if (typeof v === 'number') return 'f32';
  if (v instanceof THREE.Vector2) return 'vec2f';
  if (v instanceof THREE.Vector3) return 'vec3f';
  if (v instanceof THREE.Vector4) return 'vec4f';
  if (v instanceof THREE.Matrix4) return 'mat4x4f';
  if (v instanceof Float32Array) return `array<f32, ${v.length}>`;
  if (Array.isArray(v) && v.length > 0 && v[0] instanceof THREE.Vector2) return `array<vec2f, ${v.length}>`;
  if (Array.isArray(v) && v.length > 0 && v[0] instanceof THREE.Vector3) return `array<vec3f, ${v.length}>`;
  throw new Error(`uniform ${name} の値の種類に対応していません`);
}

function alignOf(t: FieldType): [align: number, size: number] {
  const m = /^array<(f32|vec2f|vec3f), (\d+)>$/.exec(t);
  if (m) {
    const [a, s] = ALIGN[m[1]!]!;
    const stride = Math.ceil(s / a) * a; // 配列の要素の間隔は整列の倍数（vec3f は 16 バイトごと）
    return [a, stride * Number(m[2])];
  }
  return ALIGN[t]!;
}

/**
 * 値の一覧から並べ方を決める。extra は映像の値の後ろに足す値（描く画像の大きさなど、土台が書き込むもの）
 * @param structName WGSL の構造体の名前
 */
export function buildLayout(uniforms: Uniforms, structName: string, extra: Record<string, FieldType> = {}): Layout {
  const fields: Field[] = [];
  const textures: string[] = [];
  let offset = 0;
  let maxAlign = 4;
  const add = (name: string, type: FieldType): void => {
    const [a, s] = alignOf(type);
    offset = Math.ceil(offset / a) * a;
    fields.push({ name, type, offset });
    offset += s;
    maxAlign = Math.max(maxAlign, a);
  };
  for (const [name, u] of Object.entries(uniforms)) {
    if (isTexture(u.value)) { textures.push(name); continue; }
    add(name, typeOf(name, u.value));
  }
  for (const [name, type] of Object.entries(extra)) add(name, type);
  const size = Math.max(16, Math.ceil(offset / maxAlign) * maxAlign);
  const wgsl = `struct ${structName} {\n${fields.map((f) => `  ${f.name}: ${f.type},`).join('\n')}\n}`;
  return { fields, size, textures, wgsl };
}

/** 今の値をバッファ用の配列に書き込む（extra の値は extraValues から） */
export function writeLayout(layout: Layout, uniforms: Uniforms, out: Float32Array, extraValues: Record<string, number[]> = {}): void {
  for (const f of layout.fields) {
    const i = f.offset / 4;
    const v = f.name in extraValues ? extraValues[f.name] : uniforms[f.name]!.value;
    if (typeof v === 'number') out[i] = v;
    else if (Array.isArray(v) && typeof v[0] === 'number') out.set(v as number[], i);
    else if (v instanceof THREE.Vector2) { out[i] = v.x; out[i + 1] = v.y; }
    else if (v instanceof THREE.Vector3) { out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z; }
    else if (v instanceof THREE.Vector4) { out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z; out[i + 3] = v.w; }
    else if (v instanceof THREE.Matrix4) out.set(v.elements, i); // three.js も WGSL も列ごとの並び
    else if (v instanceof Float32Array) out.set(v, i);
    else if (Array.isArray(v)) {
      const stride = f.type.startsWith('array<vec2f') ? 2 : 4;
      (v as (THREE.Vector2 | THREE.Vector3)[]).forEach((e, k) => {
        out[i + k * stride] = e.x;
        out[i + k * stride + 1] = e.y;
        if (e instanceof THREE.Vector3) out[i + k * stride + 2] = e.z;
      });
    }
  }
}
