---
name: p3
description: infodb p3（pcube）で、このリポジトリ自身の要望とタスクを管理する。ユーザーが要望の登録・Preflight・タスクの着手や完了・進捗の確認を頼んだとき、または要望 ID（261009-k7m3x の形）やタスク（T003）に触れたときに使う。
---

# p3 でこのプロジェクトを管理する（ドッグフーディング・試験運用）

このリポジトリ（pcube = infodb p3 自身）の作業は、p3 の要望とタスクで管理する。
データは `/mnt/assets/pcube`、登録は個人設定 `~/.config/infodb-p3/config.yaml`（プロジェクト名 `pcube`）。
データのフォルダのファイルは直接編集しない。必ず CLI を通す。

## CLI の呼び方

```bash
PCUBE_ACTOR=ai:claude pnpm -s --dir /workspaces/pcube p3 --project pcube <コマンド> [引数] --json
```

- `--dir /workspaces/pcube` は p3 本体の場所（作業ツリーの写しには node_modules が無いので、必ずメインを指す）
- `--project pcube` はどこから呼んでも対象を固定するため。`PCUBE_ACTOR=ai:claude` は変更者の記録
- 結果は `--json` で読む。人に見せる表はオプションなしの出力でよい
- 終了コード: 0 成功 / 1 使い方の誤り（メッセージに次にすることが出る）/ 2 見つからない / 3 競合（`show` で読み直してやり直す）
- 迷ったら `p3 help`。最初に `p3 whoami` で対象のプロジェクトを確かめる

## 要望を登録する（ユーザーから新しい作業を頼まれたとき）

1. `request new "<タイトル>" --body "<背景・やりたいこと・完了条件を箇条書きで>"`（任意で `--area src/web --tag ui --due YYYY-MM-DD --milestone <id>`）
2. Preflight を頼まれたら `preflight <要望ID>`（実際の Codex では 3〜5 分。終わるまで待つ）→ `drafts <要望ID>` で評価とタスク案を読む
3. 評価の要点（GO / 要確認 / NO GO、リスク、確認事項）とタスク案（D1, D2 ...）をユーザーに要約して見せる
4. **タスク化（`accept`）はユーザーの了承を得てから。** 外す案があれば `--skip D3`、一部だけなら `--only D1,D2`

確認事項（questions）はタスクにしない。チャットでユーザーに聞く。

## タスクを進める

作業は **要望ごとのブランチ** で行う。ブランチ名はタスク化のときに要望に割り当てられる
（`request show <要望ID> --json` の `item.workstream.branch`。例: `req/261009-k7m3x`）。

1. ブランチに入る: 無ければ最新の main から作る（`git switch main && git pull --ff-only && git switch -c <branch>`）、あれば `git switch <branch>`。
   作業ツリー（git worktree）は作らない（作業ツリーでは依存の `link:../llmcs/...` が解決できない）
2. `ls --req <要望ID>` で一覧、`show <要望ID>/T003 --json` で中身と依存（depends_on）を読む。依存が完了していないタスクから始めない
3. 着手: `move T003 doing --req <要望ID>`
4. 作業し、テスト（`pnpm -s check`）を通してブランチにコミット・push したら、完了: `move T003 done --req <要望ID> --output https://github.com/tamuto/pcube/commit/<sha>`
   （成果物が複数あれば `--output` を繰り返す）
5. 作業中に見つけた追加の作業は `new "<タイトル>" --req <要望ID> --body "..."` でタスクにする。依存は `link T004 depends_on T003 --req <要望ID>`
6. 要望のタスクが揃って完了したら、PR を作るかユーザーに確認し、了承を得てから `gh pr create`（本文に要望 ID とタスクの一覧）。
   作った PR の URL は最後のタスクの `--output` に足す。マージは人が行う

ブランチを切り替えると、この CLI（p3 本体）もそのブランチのコードで動く。CLI を壊す変更の途中で
CLI が動かなくなったら、`git stash` などで戻してから操作し、ユーザーに伝える。

## してはいけないこと

- `check`（済み）を付けない。済みは人が成果物を確認して付ける
- 要望のステータスを `done` / `rejected` にしない（人が決める）。タスク化で `active` になるのは自動
- タスクを要望をまたいで動かさない。別の要望の作業なら、その要望にタスクを足すか、新しい要望を提案する
- データのフォルダ（`/mnt/assets/pcube`）や `~/.config/infodb-p3/` のファイルを直接書き換えない
- 人への質問をタスクにしない

## 状況を報告する

- 全体: `progress`（マイルストーンごと）。要望の中: `ls --req <要望ID>`
- 画面はユーザーが `pnpm -s p3 serve` で開く（http://localhost:4310）。CLI の変更はそのまま画面に反映される
