# infodb p3（P³）

> 正式名称は **infodb p3**。`pnpx @infodb/p3` で CLI を起動する。

ファイルベースのプロジェクト管理ツール。作業の単位は **要望** で、要望ごとにフォルダを作り、
そこから生まれたタスクや評価の記録をすべてその下に置く。

最大の特徴は **Preflight** —— 要望をタスクにする前に、Codex（`codex app-server`）がリポジトリと過去の経緯（git の履歴）を
読んで妥当性・実現可能性・影響範囲を評価し、着手できる粒度のタスク案を **ファイルとして** 書き出す。

- 要望 = フォルダ。タスクは要望の中で連番（T001, T002, ...）。ブランチ名は作業先のリポジトリごとに1つ割り当てる
- 人が Preflight とタスク化と確認を、AI エージェントがタスクの作業を受け持つ。人も AI も同じ **CLI**（`p3`）で操作する
- タスクの状態は 未着手 / 作業中 / 完了 の3つだけ。完了したら成果物（PR など）と変更の記録を残し、人が確かめて「済み」にする
- DB なし。1タスク = 1 Markdown ファイル。人・AI・Codex が直接編集しても整合する。認証も要らない
- ブラウザはローカルのビューア兼エディタ（`p3 serve`）。進捗・タスクボード・Preflight の評価を見る。データはすべてローカルで完結する

> 現在はプロトタイプ。

## 必要なもの

| もの | 何に使う |
| --- | --- |
| Node.js 22 以上 | P3 本体（CLI と `p3 serve`） |
| pnpm（`pnpx`）か npm（`npx`） | P3 を入れずに動かす（`pnpm add -g @infodb/p3` で `p3` コマンドにしてもよい） |
| Git | 管理したいリポジトリと、要望ごとのブランチ |
| Docker（CLI とデーモン） | Preflight の Codex をコンテナの中で動かす |
| ChatGPT のアカウント（プラン） | Preflight の Codex をその人のアカウントで動かす |

Docker と ChatGPT が無くても、要望・タスクの管理は使える（Preflight を通さずにタスクを作る。[使い方ガイド](docs/how-to-use.md#preflight-を通さずにタスクを作る)）。

## 最短の手順

管理したいリポジトリの中で:

```bash
pnpx @infodb/p3 init --agents      # 新しく作る: データのフォルダ（既定はリポジトリの .p3。外にも置ける）を決めて個人設定に登録する。AI 向けの指示とスキルも置く（--agents claude / codex / both。省くと both）
                                   # ほかの人が作ったプロジェクトに参加するなら init ではなく p3 join（個人設定に登録するだけ）
pnpx @infodb/p3 chatgpt login      # Preflight に使う ChatGPT プランに接続する（ブラウザが開く）
pnpx @infodb/p3 codex update       # Codex のイメージを作る（初回は数分）
pnpx @infodb/p3 serve              # http://localhost:4310 を開き、要望を書いて Preflight → タスク化
```

Docker のコンテナで動かすこともできる（Docker Hub の `tamuto/p3`。既定は、個人設定に登録したプロジェクトを跨いで扱う serve。[導入ガイド: Docker で動かす](docs/installation.md#docker-で動かすプロジェクトを跨ぐ-serve)）。

DevContainer の中で動かすとき（Docker はホストのもの）は、この前にパスの対応が要る。Docker の確認から順に
[導入ガイド](docs/installation.md) に沿って進めるのが確実。

## 文書

| 読みたいこと | 文書 |
| --- | --- |
| 入れて最初の Preflight を動かすまで（Docker・パスの対応・ChatGPT・つまずいたとき・マシンごとの設定） | [導入ガイド](docs/installation.md) |
| 要望を1件、作ってから人が確認して閉じるまで。状態・データ・画面・CLI のリファレンス | [使い方ガイド](docs/how-to-use.md) |
| マイルストーンのリリースノート（タスクの変更の記録から機能の要約を作る） | [使い方ガイド: リリースノート](docs/how-to-use.md#リリースノート) |
| P3 そのものの開発・ソースの構成・配布物 | [開発ガイド](docs/development.md) |
| 設計の方針と規則（なぜそうするか） | [docs/architecture.md](docs/architecture.md) |
| ChatGPT のサインインの設計 | [docs/chatgpt-sign-in.md](docs/chatgpt-sign-in.md) |
| npm への公開の手順 | [docs/publishing.md](docs/publishing.md) |

すべてのコマンドとオプションは `p3 help`。

技術: TypeScript, React 19, TanStack Router, Tailwind CSS 4, Vite, Hono, Node（tsx）, pnpm, [@infodb/codex-workspace](https://github.com/tamuto/llmcs/tree/main/codex-workspace-ts)
