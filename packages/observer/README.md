# @infodb/p3-observer

p3-observer（観測）。項目キーごとに値（メトリクス）を貯めて見せるだけで、値を何を実行して得たかは扱わず、判定もしない（目安は並べて見せるだけ）。
起動の確認（`p3 observer status`・`GET /api/observer/status`）と、項目キーと値（`p3 observer list / show / key / value`・`/api/observer/keys`・画面の `/observer`）を持つ。
システムの項目（`p3.` で始まる開発の指標）の値は tasks が要望・タスクの操作のときに書く（tasks → observer の一方向。observer は tasks を読まない）。
shared だけを読む。公開しない（入口の [@infodb/p3](../p3/README.md) に同梱する）。

- 線引き・システムの項目・保存・入口: [docs/architecture.md の「p3-observer」](../../docs/architecture.md#p3-observer)
- 使い方: [使い方ガイド: 製品（tasks と observer）](../../docs/how-to-use.md#製品tasks-と-observer)
