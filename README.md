# infodb p3（P³）

> 正式名称は **infodb p3**。`npx @infodb/p3`（pnpm なら `pnpx @infodb/p3`）で CLI を起動する。

p3 は、AI と進める開発の要求・判断・実装・検証をつなぎ、その根拠を後から追えるようにするツール。実装そのものは Codex・
Claude Code などの AI エージェントや人が行い、p3 はその前後（何を頼んだか・何を根拠に決めたか・何をどう確かめたか）を記録する。
新しいコーディングエージェントではない。

- 作業の単位は **要望**。要望ごとにフォルダを作り、そこから生まれたタスクと記録をその下にファイルで置く。DB も認証も要らない
- 人も AI エージェントも同じ CLI（`p3`）で操作し、ブラウザの画面（`p3 serve`）で見て書ける
- タスクは 未着手 / 作業中 / 完了 の3つだけ。完了したら成果物・変更の記録・受け入れ基準ごとの証拠を残し、人が確かめて「済み」にする
- 必要になったら、作る前の評価（**Preflight**）や、作った後の AI のレビューを足せる。どれも人の判断の材料で、承認の代わりではない
- 工程ごとに p3 が受け持つこと・受け持たないことは [設計: 開発の工程と P3 の受け持ち](docs/architecture.md#開発の工程と-p3-の受け持ち)

> 現在はプロトタイプ。

## 必要なもの

- Node.js 24 以上（推奨 26）
- Git

始めるのはこの2つだけでよい。Preflight などは、後から必要なものを選んで足す（[導入ガイド](docs/installation.md)）。

## 最短の手順

共有されたプロジェクトのリポジトリを取得してあるなら:

1. そのリポジトリのフォルダに移る: `cd ~/src/myapp`
2. 参加する: `npx @infodb/p3 join --yes`
3. 画面を開く: `npx @infodb/p3 serve` を実行したまま、ブラウザで http://localhost:4310 を開く

ブラウザに、そのプロジェクトの「進捗」（要望の一覧）が出れば始められている。

- `join` は、このマシンにプロジェクトを登録するだけ（共有されたファイルは変えない）。`serve` は画面を開く
- 自分で新しく作るなら、[導入ガイド: 新しく作る](docs/installation.md#新しく作る)
- データがリポジトリの外にある・うまくいかないときも、[導入ガイド](docs/installation.md#段階-0-要望とタスクを使う)

## 次にできること

| 段階 | できるようになること | 文書 |
| --- | --- | --- |
| 1 | 要望をタスクにする前に、評価とタスク案を受け取る（Preflight。Codex か手元の AI エージェント） | [導入ガイド: 段階 1](docs/installation.md#段階-1-preflight-を足す) |
| 2 | 品質基準・タスクやマイルストーンのレビューなど、要るものだけ足す | [導入ガイド: 段階 2](docs/installation.md#段階-2-必要になったら足す) |

P3 を Docker のコンテナで動かすこともできる（[導入ガイド: Docker で動かす](docs/installation.md#docker-で動かすプロジェクトを跨ぐ-serve)）。

観測基盤 **p3-observer**（試作。今は観測の定義の登録だけ）も同じ `p3` に入っている。`p3 serve` は常に tasks と observer の両方を起動し、
画面のナビゲーションで行き来する（[使い方: 製品](docs/how-to-use.md#製品tasks-と-observer)・[設計: p3-observer](docs/architecture.md#p3-observer)）。
観測の定義（タイトル・カテゴリ・観測内容・測定項目・確認の手順）は CLI（`p3 observer add` など）と画面の「観測基盤」の両方で登録できる
（[使い方: 観測の定義を登録する](docs/how-to-use.md#観測の定義を登録する)・[保存の仕様: 設計 p3-observer の「観測の定義の保存」](docs/architecture.md#p3-observer)）。

## 文書

| 読みたいこと | 文書 |
| --- | --- |
| 使い始めるまで（段階 0〜2、つまずいたとき・マシンごとの設定・Docker で動かす） | [導入ガイド](docs/installation.md) |
| 要望を1件、作ってから人が確認して閉じるまで。状態・データ・画面・CLI のリファレンス | [使い方ガイド](docs/how-to-use.md) |
| 作業中に進められなくなったとき（止まっている理由）・受け入れ基準と証拠 | [使い方ガイド: 止まっている理由](docs/how-to-use.md#止まっている理由)・[受け入れ基準と証拠](docs/how-to-use.md#受け入れ基準と証拠) |
| 大きい要望を子の要望に分ける・子の表示順を保つ（表示順は実行の順ではない） | [使い方ガイド: 親と子の要望](docs/how-to-use.md#親と子の要望) |
| マイルストーンの目的と予定している機能（いつでも書き直せる。レビューは保存した内容と要望を比べる） | [使い方ガイド: タグ・期限・マイルストーン](docs/how-to-use.md#タグ期限マイルストーン) |
| マイルストーンレビュー（目的・予定機能に対して実装のコードと履歴を確かめ、達成の度合い・不足・意図しない変更を読む） | [使い方ガイド: マイルストーンレビュー](docs/how-to-use.md#マイルストーンレビュー) |
| マイルストーンのリリースノート（タスクの変更の記録から機能の要約を作る） | [使い方ガイド: リリースノート](docs/how-to-use.md#リリースノート) |
| 記録から開発の指標（要望の到達時間・受け入れ基準の未達・手戻り・AI レビューの所見）と人が記録する費用・不具合を CLI と画面で見る。指標を足す場所 | [使い方ガイド: 開発の指標](docs/how-to-use.md#開発の指標) |
| P3 そのものの開発・ソースの構成・配布物 | [開発ガイド](docs/development.md) |
| 設計の方針と規則（なぜそうするか） | [docs/architecture.md](docs/architecture.md) |
| 開発の工程ごとに P3 が受け持つこと・意図して持たないこと | [設計: 開発の工程と P3 の受け持ち](docs/architecture.md#開発の工程と-p3-の受け持ち) |
| パッケージの構成（入口・製品・kit）と製品ごとの設計の置き場所・機能の棚卸し | [設計: パッケージの構成](docs/architecture.md#パッケージの構成)・[機能の棚卸し](docs/feature-inventory.md) |
| 観測基盤 p3-observer（試作）の所有の境界・起動の構成（常に両方）・観測の定義の保存・観測の実装を置く範囲 | [設計: p3-observer](docs/architecture.md#p3-observer) |
| ChatGPT のサインインの設計 | [docs/chatgpt-sign-in.md](docs/chatgpt-sign-in.md) |
| npm への公開の手順 | [docs/publishing.md](docs/publishing.md) |

すべてのコマンドとオプションは `p3 help`。

技術: TypeScript, React 19, TanStack Router, Tailwind CSS 4, Vite, Hono, Node（tsx）, pnpm, [@infodb/codex-workspace](https://github.com/tamuto/llmcs/tree/main/codex-workspace-ts)
