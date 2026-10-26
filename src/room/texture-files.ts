// 部屋の面に貼る画像の一覧。src/private/rooms/ と同じく、src/private/textures/ に置いた画像を読む
// （公開しないフォルダ。ないときは「なし」だけ）。ファイルを置けば、room モードのパネルの「面の画像」に出る。
// import.meta.glob は Vite だけで使えるので、読み込みの仕組み（textures.ts）とは分けている
import { ROOM_TEXTURES } from './textures.ts';

const files = import.meta.glob<string>('../private/textures/*.{png,jpg,jpeg,webp,PNG,JPG,JPEG,WEBP}', { query: '?url', import: 'default', eager: true });

ROOM_TEXTURES.push(...Object.entries(files)
  .map(([path, url]) => ({ id: path.split('/').pop()!, url }))
  .sort((a, b) => a.id.localeCompare(b.id)));

export { ROOM_TEXTURES };
