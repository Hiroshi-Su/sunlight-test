// 部屋の面に貼る画像（テクスチャ）の読み込み。画像の一覧は src/room/texture-files.ts（src/private/textures/ に置いた画像）。
// 画像は TEX_SIZE 四方に引き伸ばし、縮小した段（ミップマップ）も作って、両方の描き方（WebGL2・WebGPU）に同じ画素を渡す

export interface RoomTexture {
  /** ファイル名（保存する値に使う） */
  id: string;
  url: string;
}

/** 読み込める画像の一覧（texture-files.ts が入れる。テストなど、一覧を入れないときは空） */
export const ROOM_TEXTURES: RoomTexture[] = [];

/** 画像 1 枚の大きさ（画素、正方形）。縦横比は aspect に残し、貼るときに戻す */
export const TEX_SIZE = 1024;
/** 同時に使える画像の数 */
export const MAX_TEXTURES = 8;
/** ミップマップの段の数（TEX_SIZE から 1 画素まで） */
export const TEX_LEVELS = Math.log2(TEX_SIZE) + 1;

export interface TexturePixels {
  /** 段ごとの画素（RGBA、sRGB のまま。0 段目が TEX_SIZE 四方、次の段は半分） */
  levels: Uint8ClampedArray[];
  /** 元の画像の 高さ / 幅 */
  aspect: number;
}

const cache = new Map<string, TexturePixels | 'loading' | 'error'>();

async function load(t: RoomTexture): Promise<TexturePixels> {
  const img = await createImageBitmap(await (await fetch(t.url)).blob());
  const aspect = img.height / img.width;
  const levels: Uint8ClampedArray[] = [];
  // 半分ずつ縮める（1 段前の画像から縮めると、毎回元の画像から縮めるより平均に近い）
  let src: CanvasImageSource = img;
  for (let size = TEX_SIZE; size >= 1; size >>= 1) {
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, size, size);
    levels.push(ctx.getImageData(0, 0, size, size).data);
    src = c;
  }
  img.close();
  return { levels, aspect };
}

/** 読み込んだ画像。まだなら読み込みを始めて null（読み終えたら onReady を呼ぶ）。読めない画像も null */
export function texturePixels(id: string, onReady?: () => void): TexturePixels | null {
  const c = cache.get(id);
  if (c && c !== 'loading' && c !== 'error') return c;
  const t = ROOM_TEXTURES.find((x) => x.id === id);
  if (!c && t) {
    cache.set(id, 'loading');
    load(t).then((p) => { cache.set(id, p); onReady?.(); }, (e) => { console.warn(`面の画像 ${id} を読めません`, e); cache.set(id, 'error'); });
  }
  return null;
}
