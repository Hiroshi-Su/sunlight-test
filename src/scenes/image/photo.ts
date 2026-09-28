// 比較用：効果をかけない元の画像
import { imageScene } from './source.ts';

export const photo = imageScene({
  id: 'img-photo',
  label: '画像：元の写真',
  params: {},
  glsl: /* glsl */ `
vec3 effect(vec2 uv, vec2 p) { return img(uv); }
`,
  uniforms: () => ({}),
  update() {},
});
