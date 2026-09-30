# 展示用 PC の選定

展示用 PC の候補を比べるための資料。第一案は Mac mini（M5 Pro）で、比較のために同じ価格帯の Windows のゲーミング PC を調べた。

- 調べた日：2026-09-30。価格は税込。BTO パソコンの価格はセール・在庫で大きく変わる（2026 年はメモリの値上がりで、Mac・Windows とも値上げが続いている）ので、購入の直前に確認し直すこと
- 性能の数値は公開されているベンチマークの値と、開発用の Mac（Apple M4、GPU 10 コア）でこの作品を実際に動かして測った値から見積もった。候補の PC そのものでは測っていない

---

## 1. この作品が PC に求めること

| 項目 | 内容 | 根拠 |
|---|---|---|
| 映像の出力 | 3840×1080 を 60fps。プロジェクター 2 台（1920×1080 × 2）を OS 上で横に並べて出す | README の `window` の項目 |
| GPU | 映像は全画面のシェーダー（WebGL2）。重さは映像によって 3840×1080 で 1 フレーム 1〜10ms（Apple M4） | docs/visuals.md 10.2 節 |
| CPU | 太陽の計算は 1 フレームに数回の三角関数だけで、ほぼ使わない | `src/solar.ts` |
| メモリ | room モードの機能をすべてオンにした一番重い状態でも、ブラウザ全体で約 0.8GB（開発版で計測） | 下の 1.1 |
| ストレージ | アプリ本体・画像・ログで 1GB 未満 | ― |
| ネット | 不要（オフラインで動く）。時刻合わせのために、ときどきつなげるとよい | docs/verification.md 9.1 節 |
| 長期稼働 | 毎日・長時間つけっぱなし。停電のあとの自動起動、OS の更新での勝手な再起動の防止が必要 | README「長期稼働のための仕組み」 |
| 設置場所 | ロビー。静かで、小さく、熱をあまり出さない方がよい | ― |

### 1.1 メモリの実測

room モードで、雲・スクリーンの映像・水盤・海・水面の反射をすべてオンにした状態（この作品で一番重い使い方）で測った。

| 項目 | 値 |
|---|---|
| JavaScript が使っているメモリ | 15MB |
| ブラウザ（Chrome）全体のメモリ | 約 780MB |

48GB は、この作品には多すぎる。16〜24GB で十分足りる。

### 1.2 GPU の重さの見積もり

GPU の性能を 3DMark（Mac と Windows の両方で同じ内容を計測できる GPU のベンチマーク）の値で比べ、開発用の Mac（Apple M4）で測ったこの作品の重さを、その比で割って見積もった。M4 と M5 Pro は軽いほうの試験（Steel Nomad Light）、M5 Pro と RTX は重いほうの試験（Steel Nomad）で比べ、2 つの比を掛けて M4 との比にした（同じ機種の両方の値がそろっていないため）。

| GPU | Steel Nomad Light | Steel Nomad | M4 との比 |
|---|---|---|---|
| Apple M4（GPU 10 コア。開発用の Mac） | 4,001 | ― | 1 |
| Apple M5 Pro（GPU 20 コア） | 10,018 | 2,323 | 約 2.5 倍 |
| GeForce RTX 5070 Ti（デスクトップ） | ― | 6,967（M5 Pro の約 3.0 倍） | 約 7.5 倍 |
| GeForce RTX 5080（デスクトップ） | ― | 8,938（M5 Pro の約 3.8 倍） | 約 9.6 倍 |

| この作品の処理（3840×1080） | M4（実測） | M5 Pro（見積もり） | RTX 5070 Ti（見積もり） | RTX 5080（見積もり） |
|---|---|---|---|---|
| 一番重い映像（にじみ） | 10.1ms | 約 4.0ms | 約 1.3ms | 約 1.1ms |
| 光の雲 | 3.5ms | 約 1.4ms | 約 0.5ms | 約 0.4ms |
| room モードのパストレーシング（全画面で表示した場合） | 約 43ms（約 23fps） | 約 17ms（60fps にわずかに届かない） | 約 6ms | 約 4.5ms |

60fps で使える時間は 1 フレーム 16.7ms。

- 展示の映像（visuals）は、どの候補でも余裕がある。一番重い映像でも、M5 Pro で 60fps の時間の約 1/4、RTX で 1 割未満
- room モードは検証用で、展示には出さない。全画面で動かしたときだけ差が出る
- 見積もりは目安である。ベンチマークはゲームのような描画で、この作品のシェーダーとは中身が違う。Windows では WebGL が Direct3D に変換されて動くので、その違いも入る。購入後に visuals の「ベンチマーク（60 フレーム）」で実際の値を確かめること

---

## 2. 第一案：Mac mini（M5 Pro）

2026-09-22 発売のモデル。

| 項目 | 内容 |
|---|---|
| 構成 | M5 Pro（18 コア CPU・20 コア GPU）、メモリ 48GB、ストレージ 512GB |
| 価格 | **443,800 円**（標準の M5 Pro 299,800 円 ＋ 18 コア CPU・20 コア GPU 36,000 円 ＋ メモリ 48GB 108,000 円。Apple の価格を積み上げて計算） |
| 映像の出力 | 外部ディスプレイ 3 台まで（6K 60Hz または 4K 165Hz を 3 台）。HDMI 1 つ、Thunderbolt 5 が 3 つ |
| 消費電力 | 最大 155W（連続使用時） |
| 騒音 | アイドル時 5dBA |
| 大きさ・重さ | 12.7 × 12.7 × 5.0cm、0.73kg |
| 動作温度 | 10〜35℃ |
| ネットワーク | 2.5Gb イーサネット（10Gb に変更可） |

### 2.1 よいところ

- **開発と同じ環境**：この作品は Mac（Apple の GPU、WebGL を Metal に変換して動かす）で作り、確認してきた。同じ仕組みの上で動くので、見え方・動き方の違いが出にくい
- **静かで小さく、熱が少ない**：ロビーに置いても音がほとんど気にならない。棚の中などにも収めやすい
- **長期稼働の設定がしやすい**：停電のあとに自動で起動する設定（「停電後に自動的に起動」）、自動ログイン、ログイン時にアプリを起動する設定が OS の標準機能でできる
- **GPU は十分**：展示の映像は、一番重いものでも 60fps の時間の約 1/4 で描ける見込み

### 2.2 気をつけるところ

- **メモリ 48GB はこの作品には不要**：1.1 のとおり、1GB 未満しか使わない。メモリを標準の 24GB にすれば **335,800 円**（108,000 円安い）。ほかの用途（動画の書き出し、AI の処理など）に使う予定がなければ、24GB で足りる
- **GPU は Windows のゲーミング PC より遅い**：RTX 5080 の 1/4 程度。今の映像には十分だが、今後もっと重い映像（room モードのパストレーシングを展示に使う、など）を作るときは余裕が小さい
- **故障したときは本体ごと修理**：部品の交換はできない。予備機を用意するか、AppleCare を検討する
- **Thunderbolt から出すときは変換が要る**：プロジェクター 2 台なら、HDMI 1 本と、Thunderbolt から HDMI（または DisplayPort）への変換ケーブル 1 本で出す

---

## 3. 比較用：同じ価格帯の Windows のゲーミング PC

40〜47 万円で、GPU が GeForce RTX 5080 または RTX 5070 Ti のデスクトップを調べた。

| 機種 | CPU | GPU | メモリ | SSD | 価格 | 確認日 |
|---|---|---|---|---|---|---|
| ドスパラ GALLERIA XPC7A-R58-GD | Core Ultra 7 265F | RTX 5080 | 16GB | 1TB | 403,780 円（価格.com 最安） | 2026-09-30 |
| ドスパラ GALLERIA XPR7A-R58-GD | Ryzen 7 7700 | RTX 5080 | 16GB | 1TB | 394,780 円（価格.com 最安） | 2026-09-30 |
| FRONTIER（型番は FRGHLMB650/SG3 ほか） | Ryzen 7 9800X3D | RTX 5080 | 要確認 | 要確認 | 434,800 円〜 | 2026-08-14 |
| iiyama LEVEL∞（Ryzen 7 7700 モデル） | Ryzen 7 7700 | RTX 5080 | 32GB | 1TB | 469,800 円（価格.com 最安） | 2026-09-30 |
| TSUKUMO G-GEAR GE7A-L261/BH | Ryzen 7 9800X3D | RTX 5080 | 32GB | 2TB | 469,980 円〜（電源 850W GOLD） | 2026-08-14 |
| iiyama LEVEL∞（Ryzen 7 7700 モデル） | Ryzen 7 7700 | RTX 5070 Ti | 32GB | 1TB | 389,800 円（価格.com 最安） | 2026-09-30 |
| マウスコンピューター G TUNE（Ryzen 7 7700 モデル） | Ryzen 7 7700 | RTX 5070 Ti | 32GB | 1TB | 399,800 円（価格.com 最安） | 2026-09-30 |

参考（予算を超えるもの）：マウスコンピューター G TUNE FG-A7G80（Ryzen 7 9800X3D・RTX 5080・32GB・1TB、**3 年保証**）564,800 円〜、ドスパラ GALLERIA の TGS2026 出展記念モデル（RTX 5080・32GB・2TB）549,980 円〜。

- この価格帯では、RTX 5070 Ti の機種と RTX 5080 の機種の価格がほぼ同じ。同じ値段なら RTX 5080 の方が GPU が約 3 割速い
- CPU は、この作品ではほとんど使わないので、Ryzen 7 7700 や Core Ultra 7 で十分（ゲーム向けの Ryzen 7 9800X3D は不要）
- メモリは 16GB でも足りる（1.1）
- 多くの BTO パソコンは Windows 11 Home で届く。展示用なら Pro（更新の延期などの設定ができる）にしておく方がよい（数千〜1 万円程度の追加）

### 3.1 よいところ

- **GPU が速い**：M5 Pro の 3〜4 倍。今後もっと重い映像を作っても余裕がある
- **部品を交換できる**：GPU・メモリ・電源などが壊れても、その部品だけ交換・増設できる
- **NVIDIA の GPU でしか使えない機能が使える**：今後 TouchDesigner（`src/solar.py` は TouchDesigner から使う想定）で、NVIDIA 専用の機能（CUDA を使う処理、深度カメラの一部など）を使う場合は Windows と NVIDIA が必要になる
- **映像の出力端子が多い**：RTX 5080 のカードには、ふつう DisplayPort 3 つと HDMI 1 つがある。プロジェクター 2 台を変換なしでつなげる

### 3.2 気をつけるところ

- **大きく、音と熱が出る**：ミドルタワー（高さ 40〜50cm 前後）。この作品の負荷は軽いのでファンは静かめで済むはずだが、ロビーでの音は現地で確かめる必要がある。ほこりの掃除も要る
- **消費電力が大きい**：電源は 750〜1000W クラス。この作品の負荷なら実際は 100〜200W 程度と見込まれる（未計測）が、Mac mini（最大 155W）よりは多い
- **OS の更新での再起動**：Windows Update が勝手に再起動すると展示が止まる。Pro にして更新の時間・延期を設定するか、展示専用の Windows（IoT Enterprise LTSC など）を検討する
- **Windows での動作確認がまだ**：この作品は Mac で作って確かめてきた。Windows では WebGL が Direct3D に変換されて動くので、シェーダーの細かい違いが出る可能性がある。表示の拡大率（125% など）の問題は `forceDeviceScaleFactor` で対策済み（README）
- **停電のあとの自動起動**：BIOS の「AC 電源が戻ったら起動する」設定（Restore on AC Power Loss など）が必要。機種ごとに設定の名前が違う

---

## 4. 比べた結果

| 観点 | Mac mini（M5 Pro） | Windows のゲーミング PC（RTX 5080） |
|---|---|---|
| 価格 | 443,800 円（メモリ 24GB なら 335,800 円） | 約 40〜47 万円 |
| 展示の映像の余裕 | 十分（一番重い映像で 60fps の時間の約 1/4） | 大きな余裕（1 割未満） |
| 今後の重い映像への余裕 | 小さい | 大きい |
| 開発環境との違い | 同じ（Mac で開発・確認している） | 違う（Windows で動作確認が必要） |
| 音・大きさ・熱 | 静か・手のひら大・少ない | ファンの音・ミドルタワー・多め |
| 消費電力 | 最大 155W | 実際は 100〜200W 程度の見込み、電源は 750〜1000W |
| 長期稼働の設定 | OS の標準機能でできる | 更新の設定・BIOS の設定が必要 |
| 故障のとき | 本体ごと修理 | 部品ごとに交換できる |
| NVIDIA 専用の機能 | 使えない | 使える |

### 4.1 おすすめ

- **第一案は Mac mini（M5 Pro）のままでよい**。展示の映像には十分な GPU があり、開発と同じ環境で、静かで小さく、長期稼働の設定もしやすい。ただし**メモリは 24GB で足りる**ので、48GB にする理由（ほかの用途）がなければ 335,800 円の構成で約 11 万円安くできる
- **Windows のゲーミング PC を選ぶのは**、今後 room モードのような重い表現を展示に使う予定があるとき、TouchDesigner で NVIDIA 専用の機能を使うとき、部品交換のしやすさを重視するとき。その場合は、RTX 5080・メモリ 16〜32GB・Windows 11 Pro の構成（40〜47 万円）が同じ価格帯になる

### 4.2 購入前・購入後に確かめること

1. **購入前**：どちらの場合も、同じ系統の PC を借りられれば、`npm run app:kiosk` で映像を映し、visuals の「ベンチマーク（60 フレーム）」で重さを測る。Windows の場合は、すべての映像が Mac と同じに見えるかも確認する
2. **購入後**：`npm run app:forever -- --mode=kiosk` で 1 週間ほど動かし続け、ログ（`logs/`）の FPS・メモリ・復帰の記録を確認する。あわせて、PC の時計のずれをスマホと見比べて測る（docs/verification.md 9.1 節）
3. **設置の前**：停電のあとの自動起動、自動ログイン、アプリの自動起動、OS の自動更新の止め方を設定し、電源を抜き差しして展示が自動で戻ることを確かめる

---

## 5. 出典

- Apple：[Mac mini（M5 Pro、18 コア CPU、20 コア GPU、48GB、512GB）の購入ページ](https://www.apple.com/jp/shop/buy-mac/mac-mini/m5-pro-%E3%83%81%E3%83%83%E3%83%97-18%E3%82%B3%E3%82%A2cpu-20%E3%82%B3%E3%82%A2gpu-48gb-%E3%81%AE%E3%83%A1%E3%83%A2%E3%83%AA-512gb-%E3%81%AE%E3%82%B9%E3%83%88%E3%83%AC%E3%83%BC%E3%82%B8)、[Mac mini の技術仕様](https://www.apple.com/jp/mac-mini/specs/)
- 価格の内訳：[MonoDeck「Apple、M6／M5 Pro搭載の新型Mac miniを発表」](https://monodeck.jp/mac-mini-m6-m5-pro-launch/)（標準の M5 Pro 299,800 円、18 コア CPU・20 コア GPU ＋36,000 円）、[スタジオ さぼてん「新型Mac mini（M6・M5 Pro）発表まとめ」](https://saboten-blog.com/mac-mini-m6-m5pro-announcement-2026/)（メモリ 48GB ＋108,000 円）、[ガッキー・ガジェットブログ「新型Mac mini（M6／M5 Pro）の値段を全部調べた」](https://ggc-japan.com/mac-mini-m6-price-guide/)
- M5 Pro の性能：[Macworld「Mac mini (M5 Pro) review」](https://www.macworld.com/article/3239233/mac-mini-m5-pro-review-killer-performance-at-a-lethal-price.html)（GPU は M4 Pro より約 20% 速い）、[iTechGuides「Apple M5 Pro & M5 Max GPU Analysis」](https://www.itechguides.com/apple-m5-pro-m5-max-gpu-analysis-is-the-m5-max-really-on-par-with-the-rtx-5070-laptop-gpu/)（M5 Pro 20 コア GPU の Steel Nomad 2,323。Notebookcheck の計測）、[Notebookcheck「Apple M5 Pro 20-Core GPU」](https://www.notebookcheck.it/Apple-M5-Pro-20-Core-GPU.1252377.0.html)（Steel Nomad 2,323、Steel Nomad Light 10,018）、[MacRumors「M5 Ultra and M6 Chip Benchmark Results」](https://www.macrumors.com/2026/09/18/m5-ultra-and-m6-chip-gpu-benchmarks/)
- M4 の性能：[Beebom「Apple M4 Benchmarks」](https://beebom.com/apple-m4-benchmarks/)（M4 GPU の Steel Nomad Light 4,001）
- RTX の性能：[UL Benchmarks「NVIDIA GeForce RTX 5080 Review」](https://benchmarks.ul.com/hardware/gpu/NVIDIA+GeForce+RTX+5080+review)（RTX 5080 の Steel Nomad 8,938、RTX 5070 Ti 6,967）
- Windows の PC の価格：[価格.com（RTX 5080 搭載ゲーミング PC）](https://kakaku.com/pc/gaming-pc/itemlist.aspx?pdf_Spec115=306)、[価格.com（RTX 5070 Ti 搭載ゲーミング PC）](https://kakaku.com/pc/gaming-pc/itemlist.aspx?pdf_Spec115=307)、[ゲーミングPCのトリセツ「RTX 5080搭載ゲーミングPCおすすめ5選」](https://gamingpc-torisetsu.jp/rtx-5080-gaming-pc/)（2026-08-14 確認の価格）、[PC Watch「GALLERIA、TGS2026出展記念のRTX 5080搭載PC 3機種」](https://pc.watch.impress.co.jp/docs/news/2140191.html)
