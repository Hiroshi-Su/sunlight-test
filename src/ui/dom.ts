export function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof type)) throw new Error(`#${id} が見つからないか型が違います`);
  return e;
}

/**
 * lil-gui のスライダーがホイールで値を変えないようにする（ページのスクロールはそのまま）。
 * 長いパネルをスクロールしている途中でポインターがスライダーの上を通ると、値が勝手に変わってしまうため
 * （「時刻（分）」が動くと「現在時刻」もオフになる）。値はドラッグか数値の入力で変える。
 * lil-gui はスライダー自身にホイールの処理を付けているので、外側で先に受け取り（capture）、そこから先へ届けない
 */
export function ignoreSliderWheel(root: HTMLElement): void {
  root.addEventListener('wheel', (e) => {
    if (e.target instanceof Element && e.target.closest('.slider')) e.stopPropagation();
  }, { capture: true });
}
