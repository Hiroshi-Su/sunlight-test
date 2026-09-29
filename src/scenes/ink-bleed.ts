// にじみ：紙に染み込んだ色が、光の進む向きへゆっくり広がる。先端には色が溜まり、虹色に分離する（水彩・クロマトグラフィー）
import * as THREE from 'three';
import { GLSL_NOISE, fullscreenShader, hexToVec3, wrap } from './shader.ts';
import { type SceneDef, bool, color, num } from './types.ts';

const frag = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform vec2 uDir;       // 広がる向き（画面座標、正規化済み）
uniform vec2 uDrift;     // x: 帯方向の流れ / y: 形の変化（CPU 側で巻き戻し済み）
uniform float uFront;    // 先端の位置（広がる向きの座標、画面の高さ = 1）
uniform vec3 uGround, uC0, uC1, uC2, uC3;
uniform float uReach, uBands, uBandSoft, uWave, uScallop, uScallopFreq, uFray, uRim, uRimStrength, uDeep, uBlotch, uGaps, uChroma, uVivid, uBody, uGrain, uGranulate, uNavyBleed;
${GLSL_NOISE}

// 縁の色：スペクトル上の位置 sp で決まる。0 黄 → 橙 → マゼンタ → 青（ところどころシアン）→ 1 紺
vec3 spectrum(float sp, float cyan) {
  vec3 col = vec3(1.0, 0.88, 0.18);
  col = mix(col, vec3(0.99, 0.52, 0.26), smoothstep(0.18, 0.34, sp));
  col = mix(col, vec3(0.92, 0.22, 0.52), smoothstep(0.32, 0.48, sp));
  col = mix(col, mix(vec3(0.14, 0.28, 0.88), vec3(0.08, 0.66, 0.86), cyan), smoothstep(0.48, 0.66, sp));
  return mix(col, vec3(0.03, 0.05, 0.36), smoothstep(0.70, 0.92, sp));
}
// 帯の色：先端側（u=0）→ 奥（u=1）
vec3 bodyRamp(float u) {
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 0.35, u));
  col = mix(col, uC2, smoothstep(0.35, 0.7, u));
  return mix(col, uC3, smoothstep(0.7, 1.0, u));
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 q = (p - 0.5 * uRes) / uRes.y;
  vec2 d = normalize(uDir);
  vec2 perp = vec2(-d.y, d.x);
  float s = dot(q, d);      // 広がる向き
  float t = dot(q, perp);   // 帯が並ぶ向き

  // 先端の輪郭：大きなうねり（なめらか）＋外側へ丸く膨らむ凹凸＋紙の繊維によるけば立ち
  float waveLow = (fbm(vec2(t * 2.2 + uDrift.x, uDrift.y)) - 0.5) * uWave;
  // 凹凸の大きさ・間隔を不揃いにする
  float lobe = pow(abs(sin(3.14159 * (t * uScallopFreq + (fbm(vec2(t * 1.2, uDrift.y)) - 0.5) * 4.0))), 0.7);
  float lobeAmp = uScallop * (0.25 + 1.1 * noise(vec2(t * 3.0, 2.0 + uDrift.y)));
  float fray = ((noise(vec2(t * 70.0, 1.0)) - 0.5) * 0.004 + (noise(vec2(t * 160.0, 3.0)) - 0.5) * 0.002) * uFray;
  float tip = uFront + waveLow + (noise(vec2(t * 9.0, uDrift.y * 2.0)) - 0.5) * uWave * 0.1 + lobe * lobeAmp + fray;
  float x = s - tip;   // 負 = 染みている側、正 = まだ乾いた紙

  // 縁が薄く細くなって白く抜ける所（0 = 抜ける）
  float gap = smoothstep(0.3, 0.55, fbm(vec2(t * 2.0, 17.0) + uDrift * 0.5));
  // 縁の内側の境界は凹凸に沿わせず、なめらかな線にする（張り出した所ほど縁が長く、湾では詰まって紺が溜まる）
  float rimW = uRim * (0.8 + 0.4 * noise(vec2(t * 3.0 + 4.0, uDrift.y))) * mix(1.0 - 0.45 * uGaps, 1.0, gap);
  float inner = uFront + waveLow + 0.3 * uScallop - rimW;
  float k = (s - inner) / max(tip - inner, 1e-3);   // 0 = 縁の内端, 1 = 先端
  float bay = 1.0 - lobe;

  // 紙
  vec3 col = uGround * (0.97 + 0.06 * fbm(q * 2.0 + 7.0));

  // 帯（染みている側だけ。奥ほど薄く溶け、縁の上では薄くなる）
  float u = clamp(-x / uReach, 0.0, 1.0);
  float phase = t * uBands + (fbm(vec2(t * 1.5, s * 0.8) + uDrift * 0.7) - 0.5) * 1.3;
  float m = 0.5 + 0.5 * cos(6.28318 * phase);
  float bandAmp = 0.45 + 0.55 * noise(vec2(phase * 1.3, 11.0));
  float band = smoothstep(0.5 - uBandSoft, 0.5 + uBandSoft, m + (bandAmp - 0.6) * 0.5) * bandAmp;
  float mottle = 0.75 + 0.5 * (fbm(q * 3.0 + uDrift * 0.5) - 0.5);
  float wet = 1.0 - smoothstep(-0.5 / uRes.y, 0.5 / uRes.y, x);
  float onRim = smoothstep(-0.1, 0.4, k);
  float bodyA = uBody * wet * pow(1.0 - u, 0.8) * mottle * (0.12 + 0.88 * band) * (1.0 - 0.75 * onRim);
  col *= mix(vec3(1.0), bodyRamp(u), clamp(bodyA, 0.0, 1.0));

  // 先端に溜まる色。内側は柔らかく溶け込み、先端は乾いた紙に対してくっきり切れる
  // 縁の色構成は場所ごとに変える：紺は湾やノイズで決まる所にだけ塊として溜まり、それ以外は先端がマゼンタや橙で止まる
  float navyN = fbm(vec2(t * 2.6, 13.0) + uDrift * 0.6);
  float navyAmt = clamp((smoothstep(0.3, 0.6, navyN) + bay * 0.6 - 0.2) * uDeep, 0.0, 1.0);
  float stageMax = mix(0.5, 1.05, navyAmt);
  float yellowGamma = mix(0.7, 1.3, noise(vec2(t * 3.3, 21.0) + uDrift * 0.4));
  float cyan = smoothstep(0.6, 0.85, noise(vec2(t * 4.1, 31.0) + uDrift));
  float rimA = smoothstep(0.0, 0.32, k) * wet;
  float conc = uRimStrength * mix(1.0 - 0.85 * uGaps, 1.0, gap) * mix(0.9, 1.2, navyAmt);

  // 紺のにじみ：紺が溜まる所から内側へ、ぼけながら広がる
  float cloudFall = exp(min(x + rimW * 0.3, 0.0) / (rimW * 1.3));
  float cloudA = uNavyBleed * navyAmt * (0.35 + 0.65 * bay) * cloudFall * wet
               * (0.55 + 0.9 * (fbm(q * 4.0 + uDrift * 0.6) - 0.5)) * (1.0 - smoothstep(0.55, 0.95, k));
  vec3 cloudCol = mix(vec3(0.22, 0.34, 0.84), vec3(0.08, 0.10, 0.45), navyAmt);
  cloudCol = mix(vec3(dot(cloudCol, vec3(0.3, 0.55, 0.15))), cloudCol, 0.55 + 0.45 * uVivid);
  col *= mix(vec3(1.0), cloudCol, clamp(cloudA * 0.85, 0.0, 1.0));
  // 色の境目をゆがませて不規則なむらにする（先端は保つ）
  float kw = clamp(k + (fbm(vec2(t * 5.0, s * 5.0) + uDrift * 0.8) - 0.5) * uBlotch * (1.0 - smoothstep(0.8, 1.0, k)), 0.0, 1.0);
  vec3 rim;
  for (int i = 0; i < 3; i++) {
    // 色の成分ごとに位置を少しずらして虹色に分離（縁の内側だけで。外へははみ出さない）
    float ki = clamp(kw + (float(i) - 1.0) * uChroma * uVivid * (1.0 - kw), 0.0, 1.0);
    float sp = pow(ki, yellowGamma) * stageMax + navyAmt * bay * 0.45 * smoothstep(0.3, 1.0, ki);
    rim[i] = spectrum(sp, cyan)[i];
  }
  // 日差しが弱い時間は、濃さは保ったまま鮮やかさだけ落とす
  rim = mix(vec3(dot(rim, vec3(0.3, 0.55, 0.15))), rim, 0.55 + 0.45 * uVivid);
  // 半透明にして紙の目に顔料が沈む見え方にする（紺の溜まりだけは濃く残す）
  float g1 = noise(p * 0.3), g2 = noise(p * 0.08), g3 = fbm(q * 18.0 + uDrift);
  float gran = mix(1.0, smoothstep(0.1, 0.9, g1 * 0.45 + g2 * 0.3 + g3 * 0.25), uGranulate);
  float opacity = mix(0.88, 1.0, navyAmt * smoothstep(0.6, 1.0, k));
  rim = mix(vec3(1.0), rim, clamp(rimA * conc * opacity * mix(gran, 1.0, 0.3 * navyAmt), 0.0, 1.0));
  col *= rim;

  // 紙の質感。絵の具のある所ほど粒が見える（投影では細部が消えやすいので控えめに）
  float pigment = clamp(rimA * conc + bodyA + cloudA, 0.0, 1.5);
  float grain = mix(noise(p * 0.45), noise(p * 0.15), 0.5) - 0.5;
  col *= 1.0 - uGrain * (1.0 + 2.5 * pigment) * grain;
  gl_FragColor = vec4(col, 1.0);
}
`;

const RAD = Math.PI / 180;

export const inkBleed: SceneDef = {
  id: 'ink-bleed',
  label: 'にじみ',
  sunLinks: [
    { toggle: 'followLight', uses: ['direction'] },
    { toggle: 'sunVivid', uses: ['lit'] },
    { toggle: 'skyColors', uses: ['color'] },
  ],
  params: {
    followLight: { type: 'boolean', label: '光の向きに広がる', value: true },
    angle: { type: 'number', label: '固定の向き（°、右=0）', value: 0, min: 0, max: 360, step: 1 },
    position: { type: 'number', label: '先端の位置', value: 0.62, min: 0, max: 1, step: 0.01 },
    breath: { type: 'number', label: '満ち引きの幅', value: 0.08, min: 0, max: 0.4, step: 0.01 },
    breathPeriod: { type: 'number', label: '満ち引きの周期（秒）', value: 240, min: 20, max: 1200, step: 10 },
    flow: { type: 'number', label: '形の変化の速さ', value: 1, min: 0, max: 4, step: 0.05 },
    wave: { type: 'number', label: '輪郭のうねり', value: 0.16, min: 0, max: 0.5, step: 0.01 },
    scallop: { type: 'number', label: '縁の凹凸', value: 0.06, min: 0, max: 0.12, step: 0.005 },
    scallopFreq: { type: 'number', label: '凹凸の細かさ', value: 6, min: 2, max: 30, step: 0.5 },
    fray: { type: 'number', label: '縁のけば立ち', value: 0.5, min: 0, max: 4, step: 0.1 },
    rim: { type: 'number', label: '縁の太さ', value: 0.16, min: 0.02, max: 0.3, step: 0.005 },
    rimStrength: { type: 'number', label: '縁の濃さ', value: 1, min: 0, max: 1, step: 0.01 },
    deep: { type: 'number', label: '紺の溜まり', value: 1, min: 0, max: 1.5, step: 0.05 },
    blotch: { type: 'number', label: '縁の色むら', value: 0.6, min: 0, max: 1.2, step: 0.05 },
    gaps: { type: 'number', label: '縁の白い抜け', value: 0.7, min: 0, max: 1, step: 0.05 },
    navyBleed: { type: 'number', label: '紺のにじみ（内側へ）', value: 0.8, min: 0, max: 1.5, step: 0.05 },
    granulate: { type: 'number', label: '顔料の粒（透け感）', value: 0.3, min: 0, max: 1, step: 0.05 },
    chroma: { type: 'number', label: '虹色の分離', value: 0.06, min: 0, max: 0.3, step: 0.01 },
    sunVivid: { type: 'boolean', label: '日差しで鮮やかに', value: true },
    bands: { type: 'number', label: '帯の数', value: 2.4, min: 1, max: 12, step: 0.1 },
    bandSoft: { type: 'number', label: '帯のぼかし', value: 0.32, min: 0.05, max: 0.5, step: 0.01 },
    reach: { type: 'number', label: '染み込みの長さ', value: 1.6, min: 0.2, max: 3.5, step: 0.05 },
    body: { type: 'number', label: '帯の濃さ', value: 0.9, min: 0, max: 1, step: 0.01 },
    grain: { type: 'number', label: '紙の質感', value: 0.06, min: 0, max: 0.2, step: 0.005 },
    skyColors: { type: 'boolean', label: '時間帯の色を使う', value: false },
    ground: { type: 'color', label: '紙の色', value: '#e2dcd0' },
    c0: { type: 'color', label: '帯の色 1（先端側）', value: '#e0407e' },
    c1: { type: 'color', label: '帯の色 2', value: '#7479d6' },
    c2: { type: 'color', label: '帯の色 3', value: '#e8c64e' },
    c3: { type: 'color', label: '帯の色 4（奥）', value: '#a79fdc' },
  },
  create({ width, height }) {
    const s = fullscreenShader(frag, {
      uRes: { value: new THREE.Vector2(width, height) },
      uDir: { value: new THREE.Vector2(1, 0) },
      uDrift: { value: new THREE.Vector2() },
      uFront: { value: 0 },
      uGround: { value: new THREE.Vector3() },
      uC0: { value: new THREE.Vector3() },
      uC1: { value: new THREE.Vector3() },
      uC2: { value: new THREE.Vector3() },
      uC3: { value: new THREE.Vector3() },
      uReach: { value: 1.4 },
      uBands: { value: 4.5 },
      uBandSoft: { value: 0.3 },
      uWave: { value: 0.16 },
      uScallop: { value: 0.035 },
      uScallopFreq: { value: 10 },
      uFray: { value: 1 },
      uDeep: { value: 1 },
      uBlotch: { value: 0.5 },
      uGaps: { value: 0.7 },
      uNavyBleed: { value: 0.6 },
      uGranulate: { value: 0.4 },
      uVivid: { value: 1 },
      uRim: { value: 0.07 },
      uRimStrength: { value: 0.85 },
      uChroma: { value: 0.18 },
      uBody: { value: 0.6 },
      uGrain: { value: 0.04 },
    });
    const halfW = width / height / 2;
    const dir = new THREE.Vector2(1, 0);
    const target = new THREE.Vector2();
    let initialized = false;

    return {
      scene: s.scene,
      camera: s.camera,
      update(input, params) {
        const u = s.uniforms;
        if (bool(params, 'followLight')) target.set(input.light.dirX, input.light.dirY);
        else target.set(Math.cos(num(params, 'angle') * RAD), Math.sin(num(params, 'angle') * RAD));
        // 光の向きが変わっても形が急に回らないよう、ゆっくり追従させる
        if (!initialized) { dir.copy(target); initialized = true; }
        else dir.lerp(target, Math.min(1, input.dt * 0.5)).normalize();
        if (dir.lengthSq() < 1e-6) dir.set(1, 0);
        u.uDir.value.copy(dir);

        // 先端の位置：画面の入り口側（0）〜出口側（1）。満ち引きは倍精度で計算
        const corners = [[-halfW, -0.5], [halfW, -0.5], [-halfW, 0.5], [halfW, 0.5]] as const;
        const proj = corners.map(([cx, cy]) => cx * dir.x + cy * dir.y);
        const sMin = Math.min(...proj), sMax = Math.max(...proj);
        const period = Math.max(1, num(params, 'breathPeriod'));
        const breath = num(params, 'breath') * Math.sin((2 * Math.PI * (input.time % period)) / period);
        u.uFront.value = sMin + (sMax - sMin) * num(params, 'position') + breath;

        const flow = num(params, 'flow');
        u.uDrift.value.set(wrap(input.time * 0.004 * flow), wrap(input.time * 0.012 * flow));

        u.uVivid.value = bool(params, 'sunVivid') ? input.lit : 1;
        u.uRimStrength.value = num(params, 'rimStrength');
        u.uChroma.value = num(params, 'chroma');
        u.uRim.value = num(params, 'rim');
        u.uWave.value = num(params, 'wave');
        u.uScallop.value = num(params, 'scallop');
        u.uScallopFreq.value = num(params, 'scallopFreq');
        u.uFray.value = num(params, 'fray');
        u.uDeep.value = num(params, 'deep');
        u.uBlotch.value = num(params, 'blotch');
        u.uGaps.value = num(params, 'gaps');
        u.uNavyBleed.value = num(params, 'navyBleed');
        u.uGranulate.value = num(params, 'granulate');
        u.uBands.value = num(params, 'bands');
        u.uBandSoft.value = num(params, 'bandSoft');
        u.uReach.value = num(params, 'reach');
        u.uBody.value = num(params, 'body');
        u.uGrain.value = num(params, 'grain');
        u.uGround.value.copy(hexToVec3(color(params, 'ground')));

        if (bool(params, 'skyColors')) {
          const lc = input.lightColor, top = input.sky.top, bottom = input.sky.bottom;
          u.uC0.value.set(lc[0] * 0.95, lc[1] * 0.7, lc[2] * 0.75);
          u.uC1.value.set(...bottom);
          u.uC2.value.set(...top);
          u.uC3.value.set((top[0] + 0.8) / 2, (top[1] + 0.8) / 2, (top[2] + 0.8) / 2);
        } else {
          u.uC0.value.copy(hexToVec3(color(params, 'c0')));
          u.uC1.value.copy(hexToVec3(color(params, 'c1')));
          u.uC2.value.copy(hexToVec3(color(params, 'c2')));
          u.uC3.value.copy(hexToVec3(color(params, 'c3')));
        }
      },
      dispose: s.dispose,
    };
  },
};
