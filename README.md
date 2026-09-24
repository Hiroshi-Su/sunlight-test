# sunlight-test

ソラシティ カンファレンスセンター前ロビーに設置する「日差しと連携するジェネラティブ映像」の第一段階の検証用リポジトリ。
太陽位置の計算（NOAA / Meeus 簡略法）と、それをスクリーン座標の光の向きへ変換する式が正しいかを、three.js の 3840×1080 プレビューと自動テストで確認する。

案件の前提・コンセプトは [sola_city_projection_overview.md](sola_city_projection_overview.md) を参照。
計算の中身・`light` の意味・検証方法は [docs/verification.md](docs/verification.md) を参照。

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
| `npm run build` | `dist/`（描画側）と `dist-electron/`（Electron 側）を出力 |
| `npm run typecheck` | TypeScript の型チェック |
| `npm test` | TypeScript 版のテスト（計算・設定の検証） |
| `npm run test:py` | Python 版のテスト |
| `npm run check` | 型チェック＋全テスト（TypeScript・Python） |
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

## Electron アプリ（展示モード／検証モード）

| コマンド | 内容 |
|---|---|
| `npm run app` | 検証モード（デフォルト）：検証画面をアプリのウィンドウで表示 |
| `npm run app:kiosk` | 展示モード：3840×1080 の枠なしウィンドウ（描画のみ、カーソル非表示） |
| `npm run app:forever` | 監視スクリプト付きで起動。アプリが異常終了したら自動で起動し直す（長期稼働テスト用）。展示モードで動かす場合は `npm run app:forever -- --mode=kiosk` |
| `npm run logs` | ログの集計（期間・FPS・メモリの推移・異常と復帰の履歴）。`-- 2026-09-25` でその日以降に絞る |

キー操作：

| キー | 内容 |
|---|---|
| `Ctrl/Cmd + Shift + Q` | 終了（監視スクリプトも止まる） |
| `Ctrl/Cmd + Shift + M` | 展示モード ⇔ 検証モードの切り替え |
| `Ctrl/Cmd + Shift + I` | DevTools |
| `D` | 矢印表示の切り替え（展示モードでは初期 OFF） |

`config/site.json` はアプリ起動時に読むので、値を変えたらアプリを再起動するだけでよい（ビルド不要）。起動時に内容を検証し、誤りがあれば問題点をまとめてエラー表示・`logs/config-error.log` に記録して終了する（監視スクリプトも再起動せずに止まる）。アプリの動作設定は `config/app.json`：

| 項目 | 内容 |
|---|---|
| `mode` | 起動時のモード `"verify"`（デフォルト）/ `"kiosk"`。起動引数 `--mode=` で上書き |
| `window` | 展示モードのウィンドウ位置・サイズ。2 台のプロジェクターを OS 上で横並びにし、左端のディスプレイの原点に合わせる |
| `forceDeviceScaleFactor` | OS の表示スケール（125% など）を無視して 1px = 1px にする（Windows 向け） |
| `dailyReloadAt` | 毎日ページを再読み込みする現地時刻（`"04:00"`、`null` で無効） |
| `statsIntervalSec` | 稼働状況をログに書く間隔 |
| `heartbeatTimeoutSec` | 描画が止まったと判断して復帰処理に入るまでの秒数 |
| `logDir` | ログの出力先 |

長期稼働のための仕組み：

- スリープ・画面オフの防止、バックグラウンド時の描画間引きの無効化
- 描画が 10 秒ごとにハートビートを送信。途絶えたら描画プロセスを落として読み込み直し、それでも戻らなければウィンドウごと作り直す
- 描画プロセスのクラッシュ、応答なし、WebGL コンテキストロストを検知して自動復帰
- 毎日決まった時刻に再読み込み（メモリの蓄積をリセット）
- アプリ本体が落ちたら監視スクリプトが 5 秒後に起動し直す（10 分に 5 回以上なら 60 秒待つ）
- `logs/YYYY-MM-DD.log`（JSON Lines）に起動・復帰・エラー・5 分ごとの稼働状況（FPS、メモリ、太陽の値）を記録。監視スクリプトの記録は `logs/supervisor.log`

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
config/site.json          場所ごとの設定（TypeScript / Python 共通）
config/app.json           アプリの動作設定
src/config.ts             設定ファイルの型と検証
src/solar.ts              太陽位置・スクリーン座標変換（three.js 非依存）
src/solar.py              同じ式・同じ API の Python 版（TouchDesigner 用）
src/main.ts               検証画面・展示画面（状態管理・描画ループ・UI）
src/screen.ts             three.js のシェーダー（3840×1080）
src/palette.ts            太陽高度 → 空の色・色温度（仮値）
src/diagram.ts            平面図・高度グラフ・矢印
src/bridge.ts             Electron と描画側で共有する型
electron/main.ts          Electron メインプロセス（ウィンドウ・監視・ログ）
electron/preload.ts       描画側への設定の受け渡し
scripts/build-electron.ts electron/ を dist-electron/ へ変換（esbuild）
scripts/supervise.ts      異常終了時の自動再起動
scripts/log-summary.ts    ログの集計
tests/gen_fixtures.py     NREL SPA（pvlib）とベクトル射影で基準値を生成
tests/fixtures.json       基準値（190 ケース）
tests/solar.test.ts       計算のテスト
tests/config.test.ts      設定検証のテスト
tests/test_solar.py       Python 版テスト
```

`solar.ts` と `solar.py` は同じ `fixtures.json` でテストしているため、どちらかを変えたら `npm run check` で両方のテストを通すこと。

TypeScript は Node 24 の型除去でそのまま実行している（テスト・スクリプト）。そのため enum など変換が必要な構文は使わない（`erasableSyntaxOnly`）。

## 検証結果

- 太陽位置：NREL SPA との差は最大 約 0.013°（190 ケース、TypeScript・Python とも）
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
- 常設向け：OS 起動時の自動起動、Windows の通知・更新・スリープ設定、アプリのパッケージ化
