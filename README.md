# sunlight-test

ソラシティ カンファレンスセンター前ロビーに設置する「日差しと連携するジェネラティブ映像」の第一段階の検証用リポジトリ。
太陽位置の計算（NOAA / Meeus 簡略法）と、それをスクリーン座標の光の向きへ変換する式が正しいかを、three.js の 3840×1080 プレビューと自動テストで確認する。

案件の前提・コンセプトは [sola_city_projection_overview.md](sola_city_projection_overview.md) を参照。

## セットアップ

```sh
npm install
npm run dev          # http://localhost:5173/
```

Python 側のテストも動かす場合（基準値の生成に pvlib を使う）：

```sh
python3 -m venv .venv
.venv/bin/pip install pvlib
```

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー（保存すると即反映） |
| `npm run build` | `dist/` に静的ファイルを出力（オフラインで動作） |
| `npm test` | JS 版のテスト |
| `npm run test:py` | Python 版のテスト |
| `npm run fixtures` | 基準値 `tests/fixtures.json` を再生成（pvlib が必要） |

## 検証画面

- 上段：3840×1080 のスクリーン（ブラウザ幅に縮小表示）。光の進む向きを矢印と光の広がりで表示
- 平面図：北が上、中心が鑑賞者。スクリーン（青）、窓（緑）、太陽の軌跡（金＝窓から光が入る区間）
- 1日の太陽高度グラフ：金の帯が窓から光が入る時間
- 計算値：方位角・高度・赤緯・均時差・光ベクトル・窓への入射など

操作：

- 「現在時刻」：実時間で表示（検証場所で実際の日差しと見比べる用）
- ▶ と倍率：早送り再生
- スライダー／日付：任意の日時へ移動
- 矢印表示（初期 ON）／縞表示（窓枠の影、初期 OFF）

URL パラメータ：

| パラメータ | 例 | 内容 |
|---|---|---|
| `t` | `?t=2026-09-24T10:00` | 開始日時（現地時刻）。指定時は停止状態で開く |
| `site` | `?site=production` | `config/site.json` のどの場所を使うか |

## 設定（`config/site.json`）

場所ごとの値をまとめたファイル。JS・Python（TouchDesigner）の両方がこれを読む。

```json
{
  "activeSite": "verification",
  "sites": {
    "verification": {
      "latitude": 35.692948823007555,
      "longitude": 139.7832292459908,
      "utcOffsetMinutes": 540,
      "screen": { "facingAzimuth": 66, "azimuthReference": "magnetic", "magneticDeclination": -7.5 },
      "window": { "side": "right", "facingAzimuth": null }
    }
  }
}
```

| 項目 | 内容 |
|---|---|
| `facingAzimuth` | 鑑賞者がスクリーンを見る向き（北=0°, 東=90°, 時計回り） |
| `azimuthReference` | `"magnetic"`＝コンパスで測った値、`"true"`＝地図・図面の真北基準 |
| `magneticDeclination` | 磁気偏角（西偏は負）。真北基準 = コンパス値 + 偏角。東京付近は約 −7.5°（国土地理院の値で要確認） |
| `window.side` | 鑑賞者から見て窓がある側。`"left"` / `"right"` |
| `window.facingAzimuth` | 窓が斜めの場合などに、窓の外向き方位（真北基準）を直接指定。`null` なら `side` から算出 |
| `utcOffsetMinutes` | 現地の UTC オフセット（JST = 540）。PC のタイムゾーン設定に依存しない |

本番の値が決まったら `sites` に `production` を追加し、`activeSite` を切り替える。

## 座標の約束

- 方位角：真北 = 0°、東 = 90°（時計回り）。高度：水平 = 0°。大気差補正なし
- 光ベクトル `light` は光の**進む向き**をスクリーン座標で表したもの
  - `x`：右が +、`y`：上が +、`z`：スクリーンの奥（鑑賞者から離れる向き）が +
  - `dirX`, `dirY`：`(x, y)` を正規化したもの。画面内の光の帯・影の向きに使う
- `windowIncidence`：太陽方向と窓の外向きとの cos。`高度 > 0` かつ `> 0` のとき「窓から光が入る」
  - 周囲の建物による遮蔽は未考慮（現地観察で遮蔽テーブルを作る予定）

## 構成

```
config/site.json        場所ごとの設定（JS / Python 共通）
src/solar.js            太陽位置・スクリーン座標変換（three.js 非依存）
src/solar.py            同じ式・同じ API の Python 版（TouchDesigner 用）
src/main.js             検証画面（状態管理・描画ループ・UI）
src/screen.js           three.js のシェーダー（3840×1080）
src/palette.js          太陽高度 → 空の色・色温度（仮値）
src/diagram.js          平面図・高度グラフ・矢印
tests/gen_fixtures.py   NREL SPA（pvlib）とベクトル射影で基準値を生成
tests/fixtures.json     基準値（190 ケース）
tests/solar.test.mjs    JS 版テスト
tests/test_solar.py     Python 版テスト
```

`solar.js` と `solar.py` は同じ `fixtures.json` でテストしているため、どちらかを変えたら両方のテストを通すこと。

## 検証結果

- 太陽位置：NREL SPA との差は最大 約 0.013°（190 ケース、JS・Python とも）
- スクリーン座標変換：ベクトル射影による独立計算と 1e-9 以内で一致

## TouchDesigner で使う場合

`src/solar.py` を Text DAT に貼るか、モジュールとして import する。

```python
site = resolve_site(load_config('config/site.json'))
state = solar_state(datetime.now(timezone.utc), site)
# state['sun']['azimuth'], state['light']['dirX'] などを Constant CHOP へ
```

## 今後

- 検証場所で実際の日差しと画面の向きを照合
- 本番の緯度経度・向き・窓の位置で検証
- 遮蔽テーブル、照度センサー、気象庁データの組み込み
- 常設向け：Electron 化（枠なし 3840×1080）、定期リロード、WebGL コンテキストロスト対策、自動再起動、ログ
