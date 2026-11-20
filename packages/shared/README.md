# @infodb/p3-shared

入口・アプリ・機能が共通に使う処理。`src/node` は Node だけ（置き換え書き込み・ロック・採番・使い方の誤り・動いている版）、`src/web` は画面。
何も読まない。公開しない（入口の [@infodb/p3](../p3/README.md) に同梱する）。設計: [docs/architecture.md の「パッケージの構成」](../../docs/architecture.md#パッケージの構成)
