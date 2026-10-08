# pcube

ファイルベースのプロジェクト管理ツール。最大の特徴は **Preflight** —— 要望をタスクにする前に、
Codex（`codex app-server`）がリポジトリを読んで妥当性・実現可能性・影響範囲を評価し、
着手できる粒度のタスク案を **ファイルとして** 書き出す。

- かんばん + 依存関係を考慮したガントチャート
- タスク間の関係は多元的（型付き・有向・由来/確信度つきのエッジ + 構造 + 暗黙の近さ）
- DB なし。1タスク = 1 Markdown ファイル。人・AI・Codex が直接編集しても整合する
- 1サーバ = 1プロジェクト。要望ごとに作業ツリー（ブランチ / worktree）を割り当てる
- AI エージェントが API でタスクを特定・更新できる（楽観ロック・変更者記録つき）

> 現在はプロトタイプ。到達点と今後は [TODO.md](TODO.md) を参照。

## はじめかた

```bash
pnpm install
cp .env.example .env         # Codex の認証・パス対応を設定
pnpm dev                     # http://localhost:5173 （API は :4310）
```

API サーバと Vite は既定で `0.0.0.0` で待ち受ける（DevContainer の外から見るため）。認証はまだ無いので、
信頼できないネットワークでは `PCUBE_HOST=127.0.0.1` に絞ること。

`PCUBE_DATA_DIR` を指定しなければ、pcube 自身の開発を題材にしたデモデータ（`.pcube-demo/`）を作って起動する。
作り直すときは `pnpm demo:reset`。

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | API サーバ（tsx watch）+ Vite |
| `pnpm build && pnpm start` | 本番ビルドを API サーバから配信 |
| `pnpm typecheck` | 型チェック |
| `pnpm demo:reset` | デモデータを作り直す |

### 実プロジェクトで使う

管理したいリポジトリの中にデータディレクトリを置き、そのディレクトリを指して起動する。
プロジェクトごとに別のサーバ（別ポート）を立てる。

```bash
mkdir -p ~/src/myapp/.pcube
cat > ~/src/myapp/.pcube/project.yaml <<'EOF'
name: myapp
description: 何を作っているプロジェクトか（Preflight の文脈になる）
repo: ..                      # データディレクトリから見たリポジトリルート
branchPattern: req/{id}-{slug}
worktreeDir: .worktrees
EOF
PCUBE_DATA_DIR=~/src/myapp/.pcube PCUBE_PORT=4311 pnpm start
```

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

## AI エージェントから使う

最初に `GET /api/ai/manifest` を読ませる（手順と全エンドポイントの自己記述）。

```bash
# 自然文で対象を特定
curl -G localhost:4310/api/resolve --data-urlencode 'q=ガントチャート'
# 取得（関係グラフつき）→ rev を添えて更新
curl localhost:4310/api/tasks/TASK-0006
curl -X PATCH localhost:4310/api/tasks/TASK-0006 \
  -H 'content-type: application/json' -H 'x-pcube-actor: ai:claude' \
  -d '{"status":"review","progress":100,"rev":3}'
# 関係を1本追加（depends_on は循環チェックあり）
curl -X POST localhost:4310/api/tasks/TASK-0006/relations \
  -H 'content-type: application/json' -H 'x-pcube-actor: ai:claude' \
  -d '{"type":"impacts","target":"TASK-0004","confidence":0.7,"note":"列の描画を共有"}'
```

- `rev` が古ければ 409 と最新状態が返る（人の変更を AI が上書きしない）
- `x-pcube-actor` は `updatedBy` に記録され、AI が張った関係は `origin: ai` になる
- ファイルを直接編集してもよい（サーバが取り込む）

## 構成

```
src/
  shared/            型定義・スケジュール計算（サーバ/Web 共通）
  server/
    store/           Markdown コレクション、frontmatter、Preflight の保存、監視
    intel/           関係グラフ・影響範囲・類似検索（インテリジェンス層）
    preflight/       エンジン（codex-workspace / mock）と実行・タスク化
    api/             REST + SSE、AI 向けマニフェスト
  web/               React + Tailwind（text-base 基準）
    views/           かんばん・スケジュール・Preflight
    components/      タスク詳細ドロワーほか
```

技術: TypeScript, React 19, Tailwind CSS 4, Vite, Hono, Node 24（tsx）, pnpm, [@llmcs/codex-workspace](https://github.com/tamuto/llmcs/tree/main/codex-workspace-ts)
