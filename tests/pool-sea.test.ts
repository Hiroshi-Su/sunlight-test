import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveSeaLevel, poolSeaMask } from '../src/room/model.ts';

const glass = (on: string[]) => ({ right: on.includes('right'), left: on.includes('left'), ceiling: on.includes('ceiling'), front: on.includes('front'), back: on.includes('back') });

test('水盤と海をつなぐ面：ガラスの壁（右・左・手前・奥）だけ。天井はつながらない', () => {
  assert.equal(poolSeaMask({ pool: true, poolSea: 'glass', glass: glass(['back']) }), 32);
  assert.equal(poolSeaMask({ pool: true, poolSea: 'open', glass: glass(['right', 'left', 'front', 'ceiling']) }), 1 + 2 + 16);
  assert.equal(poolSeaMask({ pool: true, poolSea: 'open', glass: glass(['ceiling']) }), 0);
});

test('水盤と海をつなぐ面：つながない設定・水盤なしでは 0', () => {
  assert.equal(poolSeaMask({ pool: true, poolSea: 'off', glass: glass(['back']) }), 0);
  assert.equal(poolSeaMask({ pool: false, poolSea: 'open', glass: glass(['back']) }), 0);
});

test('窓の外の海の高さ：つなぐ間は水盤の水面（床 0）にそろう。つながる面がなければ設定のまま', () => {
  assert.equal(effectiveSeaLevel({ pool: true, poolSea: 'glass', glass: glass(['back']), seaLevelM: -1.5 }), 0);
  assert.equal(effectiveSeaLevel({ pool: true, poolSea: 'glass', glass: glass([]), seaLevelM: -1.5 }), -1.5);
  assert.equal(effectiveSeaLevel({ pool: true, poolSea: 'off', glass: glass(['back']), seaLevelM: -1.5 }), -1.5);
});
