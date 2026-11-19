# @infodb/p3（入口）

npm と Docker で配る p3 本体。起動（`bin/p3.mjs`）・CLI の振り分け・help・guide とスキル（置く・診断）・init / join / project・serve の組み立て・
画面の外枠（`__root.tsx`・プロジェクトの選択）を持ち、製品（[tasks](../tasks/README.md)・[observer](../observer/README.md)）をはっきり呼んで組み込む。kit・製品は公開せず、
ビルドして同梱する（`pnpm build` が `dist/package/` に組み立てる）。

- 利用者向けの README と文書はリポジトリのルート（[README](../../README.md)・[docs/](../../docs/)）。配布物にはそれを写す
- 設計: [docs/architecture.md の「パッケージの構成」](../../docs/architecture.md#パッケージの構成)、配布物: [開発ガイドの「npm で配る中身」](../../docs/development.md#npm-で配る中身)
