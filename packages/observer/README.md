# @infodb/p3-observer

p3-observer（観測基盤）。今は準備の段階で、起動の確認（CLI の `p3 observer status`・API の `GET /api/observer/status`・画面の `/observer`）だけを持つ。
観測データの収集・保存・スキーマはまだ無い。kit だけを読み、入口と tasks は読まない。公開しない（入口の [@infodb/p3](../p3/README.md) に同梱する）。

- 所有の境界・起動の構成・観測の実装を置く範囲: [docs/architecture.md の「p3-observer」](../../docs/architecture.md#p3-observer)
- 使い方（起動のしかた）: [使い方ガイド](../../docs/how-to-use.md)
