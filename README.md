# pcube

ファイルベースのプロジェクト管理ツール。最大の特徴は **Preflight** —— 要望をタスクにする前に、
Codex（`codex app-server`）がリポジトリを読んで妥当性・実現可能性・影響範囲を評価し、
着手できる粒度のタスク案を **ファイルとして** 書き出す。

- かんばん + 依存関係を考慮したガントチャート
- タスク間の関係は多元的（型付き・有向・由来/確信度つきのエッジ + 構造 + 暗黙の近さ）
- DB なし。1タスク = 1 Markdown ファイル。人・AI・Codex が直接編集しても整合する
- 1プロジェクト = 1リポジトリの `.pcube/`。要望ごとに作業ツリー（ブランチ / worktree）を割り当てる
- 人も AI も同じ **CLI**（`pcube`）で操作する。ファイルを直接読み書きするので認証が要らない
- ブラウザはローカルのビューア兼エディタ（`pcube serve`）。データはすべてローカルで完結する

> 現在はプロトタイプ。設計の方針は [docs/architecture.md](docs/architecture.md)、到達点と今後は [TODO.md](TODO.md) を参照。

## はじめかた

```bash
pnpm install
cp .env.example .env         # Codex の認証・パス対応（マシンごとの設定。プロジェクトには置かない）
pnpm link --global           # `pcube` コマンドを使えるようにする（または `pnpm pcube ...`）
```

### プロジェクトの始め方

管理したいリポジトリのルート（どの作業ツリーからでもよい）で `pcube init` を実行する。
端末からなら対話式で、git の設定とリポジトリの中身から既定値を推測して聞く。

```bash
cd ~/src/myapp
pcube init
#   プロジェクト名 [myapp]:
#   何を作っているプロジェクトか（Preflight の前提になります）: 社内向けの経費精算アプリ
#   ドキュメントのパス（カンマ区切り。Preflight で最初に読みます） [docs, README.md]:
#   メンバー: Tamuto(mutomob)                    ← git の user.name / user.email から
#   メンバーを追加（id:表示名:メール、空で終了）: hanako:花子:hanako@example.com
#   Preflight で重視する観点・制約（任意）: 個人情報を扱う変更は必ずリスクに挙げる
#   AGENTS.md に AI 向けの pcube の使い方を追記しますか (y/n) [y]:

# AI やスクリプトからは引数で（--yes で質問しない）
pcube init --yes --description "社内向けの経費精算アプリ" --docs docs,README.md \
  --member tamuto:Tamuto:mutomob@gmail.com --member hanako:花子 --agents
```

作られるのは `.pcube/project.yaml` と空の `tasks/` `requests/`。`.pcube/` はリポジトリにコミットして共有する
（同期の方針は [docs/architecture.md](docs/architecture.md)）。あとから変えるときは:

```bash
pcube config                                  # 設定を表示
pcube config set description="..." docs=docs,README.md instructions="外部 SaaS の追加は要相談"
pcube member add claude --name Claude --ai    # AI も担当者になれる
pcube member rm hanako
pcube whoami                                  # CLI での変更者（git の user.email が一致するメンバー）
```

ブラウザの「設定」画面（`pcube serve`）でも同じ項目を編集できる。`project.yaml` を直接編集してもよい
（コメントは pcube が書き換えても残る）。

| 設定 | 使われ方 |
| --- | --- |
| `name` / `description` | 画面の表示と、Preflight の前提（説明が空だと画面に警告を出す） |
| `docs` | Preflight で Codex に最初に読ませるドキュメント（リポジトリ内のパス。複製はしない） |
| `members` | 担当者の候補。`email` が git の user.email と一致すると CLI の変更者になる。`kind: ai` で AI |
| `statuses` | かんばんの列。使用中の列は消せない |
| `preflight.instructions` | プロジェクト固有の評価の観点・制約。Codex への指示に加わる |
| `branchPattern` / `worktreeDir` | 要望ごとの作業ツリーのブランチ名と置き場所 |

その後の流れ:

```bash
pcube new request "通知機能を追加したい" --area src/notify --body "- メール送信基盤
- 通知設定画面"
pcube preflight 1            # Codex で評価・細分化（完了まで待つ）
pcube drafts 1               # 評価とタスク案を見る（.pcube/preflight/... のファイルを直接直してもよい）
pcube accept 1 --skip T3     # タスク化
pcube serve                  # http://localhost:4310 でかんばん・ガント・Preflight・設定を見る
```

`pcube` は git のメインの作業ツリーの `.pcube/` を探して使う。要望ごとの作業ツリー（`git worktree`）の中で
実行しても、タスクの状態はメインの1か所に書かれる（ブランチごとに状態が分岐しない）。

### CLI

| コマンド | 内容 |
| --- | --- |
| `pcube ls [tasks\|requests]` | 一覧（`--status` `--request` `--area` `-q`） |
| `pcube show <ID\|語句>` | 詳細と関係（明示・暗黙・影響範囲） |
| `pcube find <語句>` / `pcube impact <ID>` | 対象の特定 / 変更が波及する項目 |
| `pcube new task\|request <タイトル>` | 作成（`--request` `--area` `--estimate` `--body -` で標準入力から本文） |
| `pcube set <ID> key=value ...` | 更新（値を空にすると消す） |
| `pcube move <ID> <status>` | かんばんの列を移動 |
| `pcube link\|unlink <ID> <種類> <相手>` | 関係の追加・削除（`depends_on` は循環チェックあり） |
| `pcube archive <ID>` | `.archive/` へ移す |
| `pcube preflight\|drafts\|accept <REQ>` | Preflight の実行・確認・タスク化 |
| `pcube init` / `pcube config` / `pcube member` / `pcube whoami` | 初期設定 / 設定 / メンバー / 変更者の確認 |
| `pcube serve` | ビューアの起動 |

ID は `TASK-0012` / `task-12` / `12`（要望を取るコマンドでは `12` は `REQ-0012`）のどれでもよい。
`--json` で機械可読な出力、`--rev` で楽観ロック（競合すると終了コード 3、見つからないと 2）。
サーバが動いていれば、CLI での変更はファイル監視経由ですぐ画面に反映される。

### pcube 自体の開発

```bash
pnpm dev                     # API サーバ（tsx watch）+ Vite  http://localhost:5173
pnpm build && pnpm start     # 本番ビルドを API サーバから配信
pnpm typecheck
pnpm test                    # ユニットテスト（vitest）。pnpm test:watch で監視
pnpm check                   # 型検査 + テスト + ビルド
pnpm demo:reset              # デモデータ（.pcube-demo/）を作り直す
```

テストは一時ディレクトリに git リポジトリと `.pcube/` を作って動かす（`test/helpers.ts`）。
Codex の経路は、JSON-RPC を話す偽の app-server（`test/fixtures/fake-codex.mjs`）に差し替えて確かめる。
CLI のテストは別プロセスで `bin/pcube.mjs` を動かし、マシンの `.env` の Codex 設定は効かないようにしている。

`pnpm dev` / `pnpm start` は pcube 自体の開発用で、`.pcube/` が見つからなければ pcube 自身の開発を題材にした
デモデータ（`.pcube-demo/`、git 管理外）で起動する。`pnpm demo:reset` はこのデモデータを作り直すだけで、
実際のプロジェクトの `.pcube/` には触れない。
サーバと Vite は既定で `0.0.0.0` で待ち受ける（DevContainer の外から見るため）。認証は無いので、
信頼できないネットワークでは `PCUBE_HOST=127.0.0.1` に絞ること。

## データの持ち方

```
<data>/
  project.yaml                       プロジェクト設定（ステータス列・ブランチ命名など）
  requests/REQ-0001.md               要望（= 作業ツリー単位）
  tasks/TASK-0001.md                 タスク（1ファイル1タスク）
  tasks/.archive/                    削除したタスク（物理削除しない）
  preflight/REQ-0001/PF-.../
    request.md                       評価時点の要望のスナップショット
    context.md                       インテリジェンス層が選んだ関連項目と理由
    assessment.json                  評価（Codex が書く）
    drafts/T1.md, T2.md ...          タスク案（Codex が書く。1案1ファイル。人が直してもよい）
    run.json                         実行メタデータ・ログ・タスク化の結果
```

タスクファイルの例:

```markdown
---
id: TASK-0003
title: ファイル監視で外部編集を取り込む
status: in_progress
request: REQ-0001                  # 所属する要望（作業ツリー）
areas: [src/server/store/workspace.ts]
estimate: 2                        # 人日
start: 2026-10-05
progress: 50
relations:
  - type: depends_on
    target: TASK-0002
  - type: impacts
    target: TASK-0007
    origin: ai                     # human | ai | preflight
    confidence: 0.6
    note: 外部編集時に resolve の結果が変わる
rev: 3                             # 楽観ロック
updatedBy: ai:claude
---

AI やエディタがファイルを直接変更したら SSE で画面に反映する。
```

- 書き込みは tmp → rename で原子的に行い、ID は排他作成で採番する（別プロセスと衝突しない）
- サーバはデータディレクトリを監視し、外部での編集をそのまま取り込んで画面へ通知する（SSE）
- 読めないファイルがあっても全体は止めず、画面上部に件数を出す

## タスクの関係（多元的な紐付け）

単純な親子や1本の依存では表せないので、3つの次元を重ねて扱う（`src/server/intel/`）。

1. **明示エッジ** — `relations` に型付きで持つ。`depends_on` / `part_of` / `derived_from` / `impacts` /
   `relates_to` / `duplicates` / `supersedes`。エッジは張った側のファイルに保存し、逆向きはインデックスで導く。
   誰が張ったか（`origin`）と AI の確信度（`confidence`）を持ち、AI 由来の関係は人が見直せる。
2. **構造** — タスクは要望（作業ツリー）に所属する。
3. **暗黙の近さ** — 影響領域（`areas`、パスの包含関係を考慮）の重なりと、内容の類似（TF-IDF、日本語は bigram）。
   明示されていないが関係しそうなものを「理由つき」で提示する。

これらから次を導く:

- **影響範囲** — `depends_on` / `part_of` の逆向きと `impacts` を推移的に辿る
- **循環検出** — `depends_on` を追加するときに拒否する
- **文脈選定** — Preflight で Codex に渡す関連項目を、全件ではなくスコア上位に絞る（トークン節約）
- **スケジュール** — `depends_on` だけを制約に、日付未設定のタスクを見積りから前詰めで配置（`src/shared/schedule.ts`）

## Preflight

```
要望を書く ─▶ 文脈選定 ─▶ Codex が評価・細分化 ─▶ レビュー（案を取捨・編集）─▶ タスク化
             (intel)      (codex-workspace)         (drafts/*.md)               (tasks/*.md + 関係 + ブランチ)
```

Codex は llmcs の [codex-workspace-ts](https://github.com/tamuto/llmcs/tree/main/codex-workspace-ts)
（`@llmcs/codex-workspace`、Python 版 codex-workspace の TypeScript 版）で動かす。
`codex app-server` を、管理対象リポジトリだけを `/workspace` にマウントした Docker コンテナの中で起動する部品で、
他のプロジェクト（bluenix/slim3 など）とも共有する。途中経過（実行したコマンド・書いたファイル）は SSE で画面に流れる。

依存は今は手元の llmcs を `link:../llmcs/codex-workspace-ts` で参照している。llmcs 側にタグ
（`codex-workspace-ts-v0.1.0`）が打たれたら `github:tamuto/llmcs#codex-workspace-ts-v0.1.0&path:/codex-workspace-ts`
へ切り替える（サブディレクトリの git 依存を扱えるので、パッケージマネージャは pnpm）。

- Codex に書かせるのは `preflight/<REQ>/<RUN>/` 配下だけ。それ以外の変更があればログに警告を出す
- 結果は戻り値ではなく **ファイル契約**（`assessment.json` + `drafts/*.md`）。Mock エンジンでも人手でも同じ取り込み処理になる
- 使用量の上限に当たっている場合は頼まずに失敗させる

| 環境変数 | 内容 |
| --- | --- |
| `PCUBE_CODEX_AUTH_VOLUME` / `PCUBE_CODEX_AUTH_FILE` | Codex の `auth.json`（Docker ボリューム内 / ホストのファイル）。どちらかがあれば Codex エンジンが有効 |
| `PCUBE_CODEX_PATH_MAP` | 開発コンテナ内のパス → Docker デーモンから見たパス（例 `/workspaces=/root/workspaces`） |
| `PCUBE_CODEX_MODEL` / `PCUBE_CODEX_EFFORT` | モデル・推論の深さ（省略時は Codex の既定） |
| `PCUBE_CODEX_ENSURE_IMAGE` | `0` でイメージの自動更新確認をしない |
| `PCUBE_PREFLIGHT_ENGINE` | 既定のエンジン（`codex` / `mock`） |

Codex を使えない環境では **Mock エンジン**（要望本文の箇条書きをタスク案にする単純なヒューリスティック）で
同じ画面・ファイルの流れを確認できる。

## 画面

`pcube serve` で開くローカルのビューア兼エディタ（React + TanStack Router + Tailwind CSS）。
画面の状態は URL に載るので、URL を共有すれば同じ画面が開ける。

| URL | 画面 |
| --- | --- |
| `/board` | かんばん（ドラッグで列を移動） |
| `/schedule` | スケジュール（依存を考慮したガント） |
| `/preflight` / `/preflight/new` | 要望の一覧 / 新しい要望 |
| `/preflight/REQ-0001?run=PF-...` | 要望の詳細と Preflight の結果（`run` を省くと最新） |
| `/settings` | プロジェクト設定 |

どの画面でも `?task=TASK-0003` でタスク詳細を重ねて開き、`?stream=REQ-0002` で作業ツリー（要望）に絞る。

ページは TanStack Router のファイルベースのルーティングで、`src/web/routes/` にファイルを置けば足りる。
ページの中身もそのファイルに書き、複数のページで使う部品だけを `src/web/components/` に置く
（`board.tsx` → `/board`、`preflight/$requestId.tsx` → `/preflight/:requestId`、`__root.tsx` は全画面共通の枠）。
ルート一覧 `src/web/routeTree.gen.ts` は `pnpm dev` / `pnpm build` / `pnpm typecheck` のたびに生成される
（設定は `tsr.config.json`。生成物だが、型検査のためにコミットしておく）。

## AI エージェントから使う

AI にも CLI を使わせる（API ごとの認証を持たせずに済む）。プロジェクトの `AGENTS.md` / `CLAUDE.md` に書く例は
[docs/architecture.md](docs/architecture.md#ai-エージェントへの指示プロジェクトの-agentsmd--claudemd-に書く例) を参照。

```bash
export PCUBE_ACTOR=ai:claude                 # updatedBy に残り、張った関係は origin: ai になる
pcube find ガントチャート --json              # 対象を特定（match が null なら candidates から選ぶ）
pcube show TASK-0006 --json                  # 関係グラフと影響範囲、現在の rev
pcube move TASK-0006 review --rev 3          # 他者が先に変えていたら終了コード 3
pcube link TASK-0006 impacts TASK-0004 --confidence 0.7 --note "列の描画を共有"
```

ブラウザ用の REST API（`/api/...`、自己記述は `GET /api/ai/manifest`）もあるが、ローカルの画面のためのもの。

## 構成

```
src/
  shared/            型定義・スケジュール計算（サーバ/Web 共通）
  cli/               pcube CLI（ファイルを直接操作）
  server/
    ops.ts           CLI と API で共通の操作（関係の規則・対象の特定など）
    store/           Markdown コレクション、frontmatter、Preflight の保存、監視
    intel/           関係グラフ・影響範囲・類似検索（インテリジェンス層）
    preflight/       エンジン（codex-workspace / mock）と実行・タスク化
    api/             REST + SSE、AI 向けマニフェスト
  web/               React + TanStack Router + Tailwind（text-base 基準）
    routes/          ページ（1ファイル1ページ。__root.tsx が共通の枠）
    routeTree.gen.ts ルート一覧（自動生成）
    components/      複数のページで使う部品（タスク詳細のドロワー、要望のステータスなど）
bin/pcube.mjs        CLI の起動口（tsx でソースをそのまま動かす）
docs/                設計の方針
test/                ユニットテスト（store / locate / intel / schedule / ops / preflight / api / cli）
```

技術: TypeScript, React 19, TanStack Router, Tailwind CSS 4, Vite, Hono, Node 24（tsx）, pnpm, [@llmcs/codex-workspace](https://github.com/tamuto/llmcs/tree/main/codex-workspace-ts)
