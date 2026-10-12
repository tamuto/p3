---
name: p3
description: infodb p3（P³）自身の開発で、このリポジトリの要望とタスクを p3 で管理する。ユーザーが要望の登録・Preflight の結果の確認・タスクの着手や完了・進捗の確認を頼んだとき、または要望 ID（261009-k7m3x の形）やタスク（T003）に触れたときに使う。
---

# p3 で P3 自身の開発を管理する（開発向け）

このリポジトリ（infodb p3 本体）の作業も、p3 の要望とタスクで管理する。
操作の手順・人と AI の役割・してはいけないことは、利用者向けのスキル **`skills/p3/SKILL.md`**（パッケージに同梱し、
`p3 init --agents` で各プロジェクトに置く原本）に従う。最初にそれを読むこと。ここには P3 の開発だけで違う点を書く。

## CLI の呼び方（開発中のソースで動かす）

公開版（`pnpx @infodb/p3`）ではなく、このリポジトリのソースで動かす:

```bash
P3_ACTOR=ai:<エージェント名> pnpm -s p3 <コマンド> [引数] --json   # リポジトリのルートで
```

- 別の場所（作業ツリーなど）から呼ぶときは `pnpm -s --dir <依存を入れたチェックアウト> p3 ...`。p3 は呼び出し元の場所
  （`INIT_CWD`）に戻ってから、対象のプロジェクトと今の要望を判定する。作業ツリーで直接動かすなら、そこで `pnpm install` する
- 対象のプロジェクトは `p3 whoami` で確かめる（名前やデータのフォルダを決め打ちしない）
- ブランチを切り替えると、この CLI もそのブランチのコードで動く。CLI を壊す変更の途中で CLI が動かなくなったら、
  `git stash` などで戻してから操作し、ユーザーに伝える

## 開発の決まり

- タスクを完了にする前に `pnpm -s check`（型検査・テスト・画面のビルド）を通す。CI は足さない
- 成果物の `--output` には push したコミットの URL（`git remote get-url origin` のリポジトリの `/commit/<sha>`）か PR の URL
- 依存の `@infodb/codex-workspace` は公開版を使う。手元の llmcs で試すときの一時的な手順は `docs/architecture.md`（codex-workspace の依存）
- `skills/p3/SKILL.md` と `src/cli/project.ts` の `AGENTS_SNIPPET` は内容をそろえる（役割・終わり方を変えたら両方を直す。
  `test/agents.test.ts` が確かめる）
