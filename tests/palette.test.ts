import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPalette, kelvinAt, setPalette, skyColors } from '../src/palette.ts';

test('日差しと空の色の表：差し替えると、その値で色温度と空の色が決まり、既定に戻せる', () => {
  const d = defaultPalette();
  assert.equal(kelvinAt(40), 5800);
  const p = defaultPalette();
  p.kelvin[4] = 3000;
  p.sky[4] = { top: '#ff0000', bottom: '#00ff00' };
  setPalette(p);
  assert.equal(kelvinAt(40), 3000);
  assert.equal(kelvinAt(25), 4000); // 20° の 5000K と 30° の 3000K のまん中
  assert.deepEqual(skyColors(50).top, [1, 0, 0]);
  setPalette(d);
  assert.equal(kelvinAt(40), 5800);
});

test('日差しと空の色の表：おかしい値は既定のまま', () => {
  const p = defaultPalette();
  p.kelvin[0] = Number.NaN;
  p.sky[0] = { top: 'red', bottom: '#12345' };
  setPalette(p);
  assert.equal(kelvinAt(-20), 2000);
  setPalette(defaultPalette());
});
