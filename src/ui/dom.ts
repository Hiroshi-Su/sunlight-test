export function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof type)) throw new Error(`#${id} が見つからないか型が違います`);
  return e;
}
