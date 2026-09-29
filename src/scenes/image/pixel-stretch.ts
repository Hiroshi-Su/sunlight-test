// ピクセルの引き伸ばし（ピクセルソートの簡易版）：明るさが範囲内のピクセルが続く「区間」を、流れの上流端の色で埋める。
// 1 列ずつ別々に処理するので筋の中に細い縞が残り、長方形のブロックごとにかけるので四角く硬い塊になる
import * as THREE from 'three';
import { bool, num } from '../types.ts';
import { TIME_PERIOD, imageScene } from './source.ts';

const glsl = /* glsl */ `
uniform float uLo, uHi, uMaxLen, uWidth, uAmount, uBlock, uHoriz, uSwap, uInvert;
uniform vec2 uFlowDir;

bool inRange(vec3 c) {
  float l = luma(c);
  if (uInvert > 0.5) l = 1.0 - l;
  return l >= uLo && l <= uHi;
}

// 区間の外か（範囲外のピクセル、またはブロックの外）
bool outside(vec2 q, vec2 bid, vec2 bsz) {
  return floor(q / bsz) != bid || !inRange(img(q / uRes));
}

vec3 effect(vec2 uv, vec2 p) {
  vec3 base = img(uv);

  // 長方形のブロックごとに、かけるかどうかを決める。かかるブロックはゆっくり入れ替わる
  vec2 bsz = vec2(uBlock * 1.6, uBlock);
  vec2 bid = floor(p / bsz);
  float phase = hash(bid + 4.1) * 6.28318 + uT * 6.28318 * floor(uSwap) * (1.0 + floor(hash(bid + 8.3) * 3.0)) / ${TIME_PERIOD.toFixed(1)};
  if (hash(bid + 1.7) > uAmount * (0.65 + 0.35 * sin(phase))) return base;

  // ブロックごとに縦（流れの向き）か横に引き伸ばす
  vec2 d = normalize(uFlowDir);
  if (hash(bid + 2.9) < uHoriz) d = hash(bid + 5.3) < 0.5 ? vec2(1.0, 0.0) : vec2(-1.0, 0.0);
  vec2 perp = vec2(-d.y, d.x);

  // 筋の太さの幅でまとめる（外光の下でも見えるよう太くできる）
  float a = dot(p, perp);
  vec2 pq = p + perp * ((floor(a / uWidth) + 0.5) * uWidth - a);
  vec3 c0 = img(pq / uRes);
  if (!inRange(c0)) return base;

  // 上流へたどって区間の始まり（範囲外のピクセルかブロックの端の手前）を探す。
  // 粗く探してから二分探索で境目を絞り込み、同じ区間のピクセルがすべて同じ始まりの色になるようにする
  float stepPx = uMaxLen * uRes.y / 32.0;
  float okDist = 0.0, ngDist = -1.0;
  for (int i = 1; i <= 32; i++) {
    float dist = stepPx * float(i);
    if (outside(pq - d * dist, bid, bsz)) { ngDist = dist; break; }
    okDist = dist;
  }
  if (ngDist > 0.0) {
    for (int j = 0; j < 6; j++) {
      float mid = 0.5 * (okDist + ngDist);
      if (outside(pq - d * mid, bid, bsz)) ngDist = mid; else okDist = mid;
    }
  }
  vec3 startCol = img((pq - d * okDist) / uRes);
  return startCol;
}
`;

export const pixelStretch = imageScene({
  id: 'img-pixel-stretch',
  label: '画像：ピクセルの引き伸ばし',
  sunLinks: [{ toggle: 'followLight', uses: ['direction'] }, { toggle: 'sunLinked', uses: ['lit'] }],
  glsl,
  params: {
    lo: { type: 'number', label: '引き伸ばす明るさ（下限）', value: 0.2, min: 0, max: 1, step: 0.01 },
    hi: { type: 'number', label: '引き伸ばす明るさ（上限）', value: 0.7, min: 0, max: 1, step: 0.01 },
    invert: { type: 'boolean', label: '明るさを反転して判定', value: false },
    maxLen: { type: 'number', label: '区間の最大長さ', value: 0.5, min: 0.02, max: 1.5, step: 0.01 },
    width: { type: 'number', label: '筋の太さ（px）', value: 3, min: 1, max: 64, step: 1 },
    block: { type: 'number', label: 'ブロックの大きさ（px）', value: 220, min: 20, max: 1080, step: 5 },
    amount: { type: 'number', label: 'かかるブロックの割合', value: 0.55, min: 0, max: 1, step: 0.01 },
    horiz: { type: 'number', label: '横に伸ばすブロックの割合', value: 0.25, min: 0, max: 1, step: 0.01 },
    swap: { type: 'number', label: 'ブロックの入れ替わり（回/20分）', value: 2, min: 0, max: 20, step: 1 },
    followLight: { type: 'boolean', label: '光の向きに伸ばす（オフで下へ）', value: false },
    sunLinked: { type: 'boolean', label: '日差しで範囲が広がる', value: true },
  },
  uniforms: () => ({
    uLo: { value: 0.35 },
    uHi: { value: 0.9 },
    uMaxLen: { value: 0.5 },
    uWidth: { value: 3 },
    uAmount: { value: 0.55 },
    uBlock: { value: 220 },
    uHoriz: { value: 0.25 },
    uSwap: { value: 2 },
    uInvert: { value: 0 },
    uFlowDir: { value: new THREE.Vector2(0, -1) },
  }),
  update(u, input, params) {
    const widen = bool(params, 'sunLinked') ? 0.15 * input.lit : 0;
    u.uLo.value = Math.max(0, num(params, 'lo') - widen);
    u.uHi.value = Math.min(1, num(params, 'hi') + widen);
    u.uMaxLen.value = num(params, 'maxLen');
    u.uWidth.value = Math.max(1, num(params, 'width'));
    u.uAmount.value = num(params, 'amount');
    u.uBlock.value = num(params, 'block');
    u.uHoriz.value = num(params, 'horiz');
    u.uSwap.value = num(params, 'swap');
    u.uInvert.value = bool(params, 'invert') ? 1 : 0;
    if (bool(params, 'followLight')) u.uFlowDir.value.set(input.light.dirX, input.light.dirY);
    else u.uFlowDir.value.set(0, -1);
  },
});
