---
name: p3
description: infodb p3（P³）自身の開発で、このリポジトリの要望とタスクを p3 で管理する。ユーザーが要望の登録・Preflight（頼まれた評価の実行と結果の確認）・タスクの着手や完了・進捗の確認を頼んだとき、または要望 ID（261009-k7m3x の形）やタスク（T003）に触れたときに使う。
---

# p3 で P3 自身の開発を管理する（開発向け）

このリポジトリ（infodb p3 本体）の作業も、p3 の要望とタスクで管理する。
操作の手順・人と AI の役割・してはいけないことは、**開発中のソースの CLI が返す手順**に従う。p3 を操作する前に
`pnpm -s p3 guide --json` を実行し、返った `guide` を最後まで読むこと（原本は `src/cli/guide.md`。利用者のプロジェクトでは、置いた
入口 `skills/p3/SKILL.md` から公開版の `guide` を読む）。ここには P3 の開発だけで違う点を書く。
`guide` を取得できなければ（CLI を壊す変更の途中など）、p3 を操作せず、下の「CLI の呼び方」の最後に従ってユーザーに伝える。

## CLI の呼び方（開発中のソースで動かす）

公開版（`pnpx @infodb/p3`）ではなく、このリポジトリのソースで動かす:

```bash
P3_ACTOR=ai:<エージェント名> pnpm -s p3 <コマンド> [引数] --json   # リポジトリのルートで
```

- 別の場所（作業ツリーなど）から呼ぶときは `pnpm -s --dir <依存を入れたチェックアウト> p3 ...`。p3 は呼び出し元の場所
  （`INIT_CWD`）に戻ってから、対象のプロジェクトと今の要望を判定する。作業ツリーで直接動かすなら、そこで `pnpm install` する
- 対象のプロジェクトは `p3 whoami` で確かめる（名前やデータのフォルダを決め打ちしない）
- 手順の中の `p3 <コマンド>` は、この呼び方（`pnpm -s p3 <コマンド>`）に読み替える。頼まれた Preflight（手順の「Preflight を頼まれたとき」）も同じ呼び方: `pnpm -s p3 preflight <要望ID> --prepare --json` → `--complete --run <run> --json`
- ブランチを切り替えると、この CLI もそのブランチのコードで動く。CLI を壊す変更の途中で CLI が動かなくなったら、
  `git stash` などで戻してから操作し、ユーザーに伝える

## 開発の決まり

- タスクを完了にする前に `pnpm -s check`（型検査・lint・テスト・画面のビルド・UI テスト）を通す。CI は足さない。lint の規則と
  例外の書き方は `docs/development.md` の「lint」（指摘を無効化のコメントで一律に黙らせない）
- 完了の順番は `guide` の手順どおり。データのフォルダがこの作業ツリーの中で git 管理されているかは `p3 whoami` と `git check-ignore` で確かめ、そうなら要望のフォルダも
  同じコミットに入れる。push したら、コミットの URL（`git remote get-url origin` のリポジトリの `/commit/<sha>`）か PR の URL を
  `move ... done --output` で足す
- 依存の `@infodb/codex-workspace`・`@infodb/chatgpt-plan`（llmcs）は公開版を使う。手元の llmcs で試すときの一時的な手順と、
  公開から1日を待たずに入れる例外の決まりは `docs/architecture.md`（llmcs の部品の依存）
- 手順の本文（役割・終わり方）は `src/cli/guide.md` の1か所に書く。置く入口の `skills/p3/SKILL.md` と `src/cli/project.ts` の
  `agentsSnippet`（`AGENTS_SNIPPET`）は入口だけで、入口に書くこと（呼び方・読み込みの約束）を変えたら両方を直し、`ENTRY_VERSION`
  （`src/cli/guide.ts`）を上げる。本文だけの改訂では上げない（`test/agents.test.ts` が確かめる）
- このリポジトリの `.claude/skills/p3/SKILL.md`（このファイル）は開発向けで、置く入口とわざと違う。`whoami` / `guide` の `agents` に
  このファイルの `outdated`・`modified` と、AGENTS.md の節の `missing` が出ても、このリポジトリでは人に伝えなくてよい（ほかの状態は伝える）
- 機能を足す・変えるときに直す場所: 規則は `docs/architecture.md` の「規則の置き場所」の1か所（CLI と API の両方に書かない）。
  ドキュメントは、導入を docs/installation.md、使い方を docs/how-to-use.md、開発を docs/development.md、設計と規則を docs/architecture.md に書き、README は入口だけにする（分担は docs/development.md の「文書を直すとき」）。同じ説明を複数に書かない。CLI のヘルプ
  （`cli/help.ts`）・API の説明（`server/api/manifest.ts`）は入口が変わったときだけ。AI の手順が変わったら
  手順の原本 `src/cli/guide.md`（入口が変わったときだけ `skills/p3/SKILL.md`・`AGENTS_SNIPPET`・`ENTRY_VERSION` も）。確認作業の記録（どの幅で確かめたか）はドキュメントに書かず、PR とタスクの成果物に残す
