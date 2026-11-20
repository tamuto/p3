# @infodb/p3-observer

p3-observer（観測基盤）。試作の段階で、起動の確認（`p3 observer status`・`GET /api/observer/status`）と、観測の定義の登録
（`p3 observer list / show / add / update`・`/api/observer/definitions`・画面の `/observer`）と、AI による確認の手順の提案（`p3 observer suggest`・
`/api/observer/suggestions`・画面の「AI に手順を提案してもらう」。AI の接続は入口が渡す）を持つ。観測の実行・結果の保存はまだ無い。
shared だけを読み、入口・アプリ・tasks は読まない。公開しない（入口の [@infodb/p3](../p3/README.md) に同梱する）。

- 所有の境界・起動の構成・観測の実装を置く範囲: [docs/architecture.md の「p3-observer」](../../docs/architecture.md#p3-observer)
- 使い方（起動のしかた）: [使い方ガイド](../../docs/how-to-use.md)
