# infodb p3（P³）

> 正式名称は **infodb p3**。将来は `pnpx @infodb/p3` で CLI を起動する想定。
> プロトタイプの間は、コマンド名・データのフォルダ・環境変数に旧名 `pcube`（`pcube` / `.pcube/` / `PCUBE_*`）を使っている。

ファイルベースのプロジェクト管理ツール。作業の単位は **要望** で、要望ごとにフォルダを作り、
そこから生まれたタスクや評価の記録をすべてその下に置く。

最大の特徴は **Preflight** —— 要望をタスクにする前に、Codex（`codex app-server`）がリポジトリを読んで
妥当性・実現可能性・影響範囲を評価し、着手できる粒度のタスク案を **ファイルとして** 書き出す。

- 要望 = フォルダ = 作業ツリー（ブランチ）。タスクは要望の中で連番（T001, T002, ...）。共有も要望単位
- タスクは AI か人が実施する。状態は 未着手 / 作業中 / 完了 の3つで固定（設定では変えない）。保留や取りやめの状態は持たず、
  手を付けないなら未着手のまま、AI が進めた作業をマージしないなら完了のまま（成果物の側で閉じる）。
  完了したタスクには成果物（PR・MR・ドキュメント）を残す。
  タスクボードは V 字（上段に未着手と完了、下段に作業中）。完了を人が確認して「済み」にするとボードから消え、対応済みの一覧に移る。
  ボードに残るのは要対応のものだけになる
- 進捗は、左に要望・右にスケジュールで横断して見る。タスクボードは要望の中で見る
- タスクは予定の日付や見積りを持たない。ステータスを変えた日時（作業中にした・完了にした）を pcube が記録し、
  完了したものは人が確認して「済み」にする
- タスク間の関係は多元的（型付き・有向・由来/確信度つきのエッジ + 構造 + 暗黙の近さ）。要望をまたぐ影響も辿れる
- DB なし。1タスク = 1 Markdown ファイル。人・AI・Codex が直接編集しても整合する
- 人も AI も同じ **CLI**（`pcube`）で操作する。ファイルを直接読み書きするので認証が要らない
- ブラウザはローカルのビューア兼エディタ（`pcube serve`）。データはすべてローカルで完結する

> 現在はプロトタイプ。設計の方針は [docs/architecture.md](docs/architecture.md) を参照。

## はじめかた

```bash
pnpm install
pnpm build                   # 画面（pcube serve で配信する dist/web）
cp .env.example .env         # Codex の認証・パス対応（マシンごとの設定。プロジェクトには置かない）
pnpm link --global           # `pcube` / `p3` コマンドを使えるようにする（任意）
```

グローバルに入れずに、p3 の場所を指定して pnpm で直接動かしてもよい。管理したいリポジトリ（やその作業ツリー）の中で:

```bash
pnpm -s --dir /path/to/p3 pcube whoami     # -s で pnpm 自身の出力を抑える（--json の出力は stdout だけに出る）
```

pnpm はスクリプトをパッケージの場所で動かすが、p3 は呼び出し元の場所（pnpm が渡す `INIT_CWD`）に戻ってから
対象のプロジェクト・今の要望（作業ツリーのブランチ）・git のユーザーを判定する。

### プロジェクトの始め方

管理したいリポジトリの中（どの作業ツリー・サブフォルダからでもよい）で `p3 init` を実行し、
プロジェクト名と **データを置くフォルダ** を決める。データのフォルダの場所は自由で、リポジトリの外を勧める
（例: `/mnt/assets/pcube`）。端末からなら対話式で、リポジトリの中身から既定値を推測して聞く。

```bash
cd ~/src/myapp
p3 init
#   プロジェクト名（切り替えに使う短い名前） [myapp]:
#   データを置くフォルダ（リポジトリの外を勧めます）: /mnt/assets/myapp
#   何を作っているプロジェクトか（Preflight の前提になります）: 社内向けの経費精算アプリ
#   ドキュメントのパス（カンマ区切り。Preflight で最初に読みます） [docs, README.md]:
#   Preflight で重視する観点・制約（任意）: 個人情報を扱う変更は必ずリスクに挙げる
#   AGENTS.md に AI 向けの p3 の使い方を追記しますか (y/n) [y]:

# AI やスクリプトからは引数で（--yes で質問しない）
p3 init --yes --project myapp --dir /mnt/assets/myapp --description "社内向けの経費精算アプリ" --docs docs,README.md
```

データのフォルダには `project.yaml` と空の `requests/` が作られる。既に作られたフォルダ（他の人が作って共有したもの）を
指したときは、作らずに **参加** だけする。

どちらの場合も **個人設定**（`~/.config/infodb-p3/config.yaml`。このマシン・この人だけのもので共有しない）に
「プロジェクト名 → データのフォルダ・手元のリポジトリ」を登録する。

```yaml
projects:
  pcube:
    dir: /mnt/assets/pcube
    repos:
      main: /workspaces/pcube
  other:
    dir: /somefolder/other
```

**操作するプロジェクトは環境変数ではなく、今いる場所と個人設定から決まる。**

1. `--project <名前>` を付ければそれ
2. 登録したリポジトリ（サブフォルダ・要望の作業ツリーを含む）か、データのフォルダの中ならそのプロジェクト
3. 登録が1つだけなら、どこからでもそれ
4. 決まらなければ、登録済みのプロジェクトと選び方を表示する

`p3 project` で一覧（今いる場所のプロジェクトに `*`）、`p3 project add <名前> <フォルダ> --repo <リポジトリ>` で
init せずに登録、`p3 project rm <名前>` で登録を外す（データは消さない）。`p3 whoami` で今の判定を確かめられる。
（以前の置き方として、リポジトリの中の `.pcube/` もそのまま読める。デモはこの形）

設定はあとから `p3 config`、画面の「設定」、`project.yaml` の直接編集のどれでも変えられる（コメントは p3 が書き換えても残る）。

| 設定 | 使われ方 |
| --- | --- |
| `name` / `description` | 画面の表示と、Preflight の前提（説明が空だと画面に警告を出す） |
| `docs` | Preflight で Codex に最初に読ませるドキュメント（リポジトリ内のパス。複製はしない） |
| `preflight.instructions` | プロジェクト固有の評価の観点・制約。Codex への指示に加わる |
| `branchPattern` / `worktreeDir` | 要望ごとの作業ツリーのブランチ名（既定 `req/{id}-{slug}`）と置き場所 |

### 要望からタスクまで

```bash
pcube milestone add v0.2 --title "通知まわり" --due 2026-11-30   # まとめてリリースする単位（任意）
pcube request new "通知機能を追加したい" --area src/notify --milestone v0.2 --due 2026-11-15 --tag feature \
  --body "- メール送信基盤
- 通知設定画面"                        # → 261009-k7m3x（作成日-乱数。ID の一部 k7m3x でも指せる）
pcube preflight k7m3x                  # Codex で評価・細分化（完了まで待つ）
pcube drafts k7m3x                     # 評価とタスク案（D1, D2 ...）を見る。ファイルを直接直してもよい
pcube accept k7m3x --skip D3           # タスク化 → requests/261009-k7m3x/tasks/T001.md ...
pcube serve                            # http://localhost:4310 で進捗・タスクボードを見る
```

タスク化すると要望は「進行中」になり、作業ツリーのブランチ名（`req/261009-k7m3x-...`）が割り当てられる。
**要望の作業ツリー（そのブランチ）の中で CLI を実行すると、その要望が「今の要望」になり、指定を省ける。**
状態の書き込みは常にプロジェクトのデータのフォルダに行く（ブランチごとに状態が分岐しない）。

```bash
cd .worktrees/261009-k7m3x
export PCUBE_ACTOR=ai:claude
pcube move T001 doing
pcube new "作業中に見つかった追加の作業" --body "..."        # → T004（要望の中の続きの番号）
pcube move T001 done --output https://github.com/me/myapp/pull/42
```

### CLI

| コマンド | 内容 |
| --- | --- |
| `pcube progress` | 要望ごとの進捗（マイルストーンごと。`--all` で完了・見送りも） |
| `pcube milestone ls\|add\|set\|rm` | マイルストーン（`--title` `--due` `--done`） |
| `pcube request new\|ls\|show\|set\|archive` | 要望の作成・一覧・詳細・更新（`status=done` `due=` `milestone=` `tags=`）・アーカイブ |
| `pcube ls` | 今の要望のタスク（`--status` `--area` `-q`、`--all` で全要望） |
| `pcube show <T003\|要望\|語句>` | 詳細と関係（明示・暗黙・影響範囲） |
| `pcube new <タイトル>` | 今の要望にタスクを足す（`--body -` で標準入力から本文） |
| `pcube set <T003> key=value ...` | 更新（`outputs=URL,...` など。値を空にすると消す） |
| `pcube move <T003> <status>` | 列を移動（`--output` で成果物を足す） |
| `pcube check <T003> [--off]` | 完了したタスクを人が確認して「済み」にする / 外す |
| `pcube link\|unlink <T003> <種類> <相手>` | 関係（相手は `T004` / `<要望>/T004` / `<要望>`。`depends_on` は循環チェックあり） |
| `pcube find <語句>` / `pcube impact <T003>` | 対象の特定 / 変更が波及する項目（要望をまたいで） |
| `pcube preflight\|drafts\|accept [<要望>]` | Preflight の実行・確認・タスク化 |
| `pcube init` / `pcube config` / `pcube whoami` | 初期設定 / 設定 / 変更者と今の要望 |
| `pcube serve` | ビューアの起動 |

今の要望は `--req <要望>` → `PCUBE_REQUEST` → 要望の作業ツリー の順で決まる。
`--json` で機械可読な出力、`--rev` で楽観ロック（競合すると終了コード 3、見つからないと 2）。
サーバが動いていれば、CLI での変更はファイル監視経由ですぐ画面に反映される。

## データの持ち方

```
<データのフォルダ>/                     （例: /mnt/assets/pcube。リポジトリの中なら .pcube/）
  project.yaml                          プロジェクト設定
  requests/
    261009-k7m3x/                       要望のフォルダ（作成日 + 乱数5文字。タイトルが変わっても変わらない）
      request.md                        要望
      tasks/T001.md, T002.md ...        タスク（要望の中の連番。1ファイル1タスク）
      tasks/.archive/                   アーカイブしたタスク
      preflight/PF-.../
        request.md                      評価時点の要望のスナップショット
        context.md                      インテリジェンス層が選んだ関連項目と理由
        assessment.json                 評価（Codex が書く）
        drafts/D1.md, D2.md ...         タスク案（Codex が書く。1案1ファイル。人が直してもよい）
        run.json                        実行メタデータ・ログ・タスク化の結果
    .archive/                           アーカイブした要望（フォルダごと）
```

タスクファイルの例（`<データのフォルダ>/requests/261009-k7m3x/tasks/T003.md`）:

```markdown
---
id: T003
title: ファイル監視で外部編集を取り込む
status: done
areas: [src/server/store/workspace.ts]
outputs:
  - https://github.com/me/myapp/pull/42      # 成果物（PR / MR / ドキュメント）
startedAt: 2026-10-09T10:12:00.000Z         # 作業中にした日時（pcube が記録）
doneAt: 2026-10-09T15:40:00.000Z            # 完了にした日時（pcube が記録）
checkedAt: 2026-10-10T09:00:00.000Z         # 人が確認して「済み」にした日時
relations:
  - type: depends_on
    target: T002                             # 同じ要望のタスク
  - type: impacts
    target: 261001-ab3cd/T001                # 別の要望のタスク
    origin: ai                               # human | ai | preflight
    confidence: 0.6
rev: 3                                       # 楽観ロック
updatedBy: ai:claude
---

AI やエディタがファイルを直接変更したら SSE で画面に反映する。
```

- **ID**: 要望は「作成日-乱数」なので、複数人が別々に作っても衝突しない。タスクは要望をまたいで移動しないので、要望の中の素直な連番でよい
- **参照**: 同じ要望の中は `T003`、別の要望は `<要望ID>/T003`、要望そのものは `<要望ID>`
- 書き込みは tmp → rename で原子的に行い、番号は排他作成で採番する（同じマシンの別プロセスと衝突しない）
- サーバはデータのフォルダを監視し、外部での編集（git pull で要望のフォルダが増えた場合も）を取り込んで画面へ通知する
- 読めないファイルがあっても全体は止めず、画面上部に件数を出す

## タスクの関係（多元的な紐付け）

単純な親子や1本の依存では表せないので、3つの次元を重ねて扱う（`src/server/intel/`）。

1. **明示エッジ** — `relations` に型付きで持つ。`depends_on` / `part_of` / `derived_from` / `impacts` /
   `relates_to` / `duplicates` / `supersedes`。エッジは張った側のファイルに保存し、逆向きはインデックスで導く。
   誰が張ったか（`origin`）と AI の確信度（`confidence`）を持ち、AI 由来の関係は人が見直せる。
2. **構造** — タスクは要望（フォルダ = 作業ツリー）に所属する。
3. **暗黙の近さ** — 影響領域（`areas`、パスの包含関係を考慮）の重なりと、内容の類似（TF-IDF、日本語は bigram）。
   明示されていないが関係しそうなもの（過去の要望の作業を含む）を「理由つき」で提示する。

これらから次を導く:

- **影響範囲** — `depends_on` / `part_of` の逆向きと `impacts` を、要望をまたいで推移的に辿る
- **循環検出** — `depends_on` を追加するときに拒否する
- **文脈選定** — Preflight で Codex に渡す関連項目を、全件ではなくスコア上位に絞る（トークン節約）


## Preflight

```
要望を書く ─▶ 文脈選定 ─▶ Codex が評価・細分化 ─▶ レビュー（案を取捨・編集）─▶ タスク化
             (intel)      (codex-workspace)         (drafts/D*.md)              (tasks/T*.md + 関係 + ブランチ)
```

Codex は llmcs の [codex-workspace-ts](https://github.com/tamuto/llmcs/tree/main/codex-workspace-ts)
（`@llmcs/codex-workspace`）で、操作する人のマシンのコンテナの中で、その人のアカウントで動かす。
コンテナには管理対象リポジトリだけを `/workspace` としてマウントする。途中経過は SSE で画面に流れる。

依存は今は手元の llmcs を `link:../llmcs/codex-workspace-ts` で参照している。llmcs 側にタグ
（`codex-workspace-ts-v0.1.0`）が打たれたら `github:tamuto/llmcs#codex-workspace-ts-v0.1.0&path:/codex-workspace-ts`
へ切り替える（サブディレクトリの git 依存を扱えるので、パッケージマネージャは pnpm）。

- Codex に書かせるのは要望のフォルダの `preflight/<RUN>/` 配下だけ。それ以外の変更があればログに警告を出す
- 結果は戻り値ではなく **ファイル契約**（`assessment.json` + `drafts/*.md`）。Mock エンジンでも人手でも同じ取り込み処理になる
- 存在しない要望・タスクへの関係はタスク化のときに捨てる
- 使用量の上限に当たっている場合は頼まずに失敗させる

| 環境変数 | 内容 |
| --- | --- |
| `PCUBE_CODEX_AUTH_VOLUME` / `PCUBE_CODEX_AUTH_FILE` | Codex の `auth.json`（Docker ボリューム内 / ホストのファイル）。どちらかがあれば Codex エンジンが有効 |
| `PCUBE_CODEX_PATH_MAP` | 開発コンテナ内のパス → Docker デーモンから見たパス（例 `/workspaces=/root/workspaces`） |
| `PCUBE_CODEX_MODEL` / `PCUBE_CODEX_EFFORT` | モデル・推論の深さ（省略時は Codex の既定） |
| `PCUBE_CODEX_ENSURE_IMAGE` | `0` でイメージの自動更新確認をしない |
| `PCUBE_PREFLIGHT_ENGINE` | `mock` にすると Codex が設定されていても Mock で評価する |

概要ページには評価エンジンの状態を出す（Codex なら Docker・認証情報・イメージを確かめ、使えなければ理由を出して実行させない）。

エンジンは1つだけで、選ぶものではない。Codex の認証が設定されていなければ **Mock**（要望本文の箇条書きを
そのままタスク案にするだけの簡易評価）になり、画面にその旨を出す。Codex を使えない環境で画面とファイルの流れを
確かめるためのもの。

Preflight でステータスが動くのはタスク化する前の要望（下書き → 評価中 → 開始前）だけで、
進行中・完了の要望を再評価してもステータスは変わらない。

## 画面

`pcube serve` で開くローカルのビューア兼エディタ（React + TanStack Router + Tailwind CSS）。
画面の状態は URL に載るので、URL を共有すれば同じ画面が開ける。

| URL | 画面 |
| --- | --- |
| `/` | 進捗。左に要望、右にスケジュール（`?show=closed\|all` `?tag=`）。下の記号で描く |
| `/requests/new` | 新しい要望 |
| `/requests/261009-k7m3x` | 要望の概要（期限・マイルストーン・タグ）と Preflight（`?run=PF-...` で過去の評価）。評価エンジンの状態も出す |
| `/requests/261009-k7m3x/board` | 要望のタスクボード（V 字。ドラッグで列を移動。完了カードの「✓ 済み」でボードから外す） |
| `/requests/261009-k7m3x/done` | 要望の対応済み（済みにしたタスクと成果物の一覧） |
| `/settings` | プロジェクト設定（マイルストーン・列・ドキュメントなど） |

要望の中のページでは `?task=T003` でタスク詳細を重ねて開く。

進捗のスケジュールの記号:

| 記号 | 意味 |
| --- | --- |
| ○ / ✓ | 完了にした日 / 人が確認して「済み」にしたもの |
| ◐ | 作業中にした日 |
| □ | 未着手のタスク（今日の線の右に、残りの数だけ） |
| ⚑ | 要望の期限（過ぎて未完了なら赤） |
| ◆ と縦の破線 | マイルストーン |
| 縦の線・丸囲みの日付 | 今日 |

どの印もクリックするとタスクの詳細が開く（進捗の画面のまま）。同じ日・週・月にまとまった印は件数が付き、クリックで
中のタスクを選ぶ。「済み」は詳細の「済みにする」ボタン（または `pcube check`）で付け外しする。

期間に上限はなく、データのある全期間（最初の出来事から、最後の期限・マイルストーンまで）を描く。描画するのは
見えている範囲の日付・印・行だけ（仮想スクロール）なので、1年・2年と運用して横に長くなっても重くならない
（2年分・要望300件・タスク3,000件で、描く要素は画面1枚分の約250〜1,000、表示まで約0.3秒）。
ズーム（日 / 週 / 月。1日あたり 30 / 10 / 3px）で長い期間を見渡せる。ズームは URL（`?zoom=week`）に載り、
切り替えても画面中央の日付を保つ。「今日」ボタンで今日に戻る。マウスを乗せると内容を大きめの文字で出す。

要望のステータスは、並べて位置がそろうよう3文字: 下書き（Preflight 前）/ 評価中 / 開始前（評価済み・タスク化の前）/
進行中 / 完了済 / 見送り。一覧で長いタイトルは「…」で切り、マウスを乗せると全文が出る。

ページは TanStack Router のファイルベースのルーティングで、`src/web/routes/` にファイルを置けば足りる。
ページの中身もそのファイルに書き、複数のページで使う部品だけを `src/web/components/` に置く
（`requests/$requestId.tsx` は要望の枠、`requests/$requestId/board.tsx` → `/requests/:id/board`、`__root.tsx` は全画面共通の枠）。
ルート一覧 `src/web/routeTree.gen.ts` は `pnpm dev` / `pnpm build` / `pnpm typecheck` のたびに生成される
（設定は `tsr.config.json`。生成物だが、型検査のためにコミットしておく）。

## AI エージェントから使う

AI にも CLI を使わせる（API ごとの認証を持たせずに済む）。`pcube init --agents` でプロジェクトの
`AGENTS.md` / `CLAUDE.md` に使い方を追記できる（内容は [docs/architecture.md](docs/architecture.md) を参照）。

- 要望の作業ツリーの中で作業すれば、要望を指定せずに `pcube move` / `pcube new` が使える
- 作業中に新しく必要になった作業は、AI がそのままタスクとして足す（可視化される）
- 人への質問（Human in the Loop）はタスクにせず、Claude Code などのチャットで行う

ブラウザ用の REST API（`/api/...`、自己記述は `GET /api/ai/manifest`）もあるが、ローカルの画面のためのもの。

## pcube 自体の開発

```bash
pnpm dev                     # API サーバ（pcube serve, tsx watch）+ Vite  http://localhost:5173
pnpm build && pnpm start     # ビルドした画面を pcube serve から配信  http://localhost:4310
pnpm typecheck
pnpm test                    # ユニットテスト（vitest）。pnpm test:watch で監視
pnpm check                   # 型検査 + テスト + ビルド
pnpm demo:reset              # デモデータ（.pcube-demo/）を作り直す
```

`pnpm dev` / `pnpm start` は pcube 自身の開発を題材にしたデモデータ（`.pcube-demo/`、git 管理外）を開く。
デモデータは無ければ自動で作られる（`scripts/demo.ts`。製品のコードではないので `src/` の外に置いている）。
作るときに実際に Preflight（Mock）を走らせ、評価・タスク案・タスク化・作業の進行（成果物つきの完了など）まで
済ませるので、マイルストーン・期限・タグを含めて各画面をそのまま確かめられる。
`pnpm demo:reset` はこのデモデータを作り直すだけで、実際のプロジェクトの `.pcube/` には触れない。
サーバと Vite は既定で `0.0.0.0` で待ち受ける（DevContainer の外から見るため）。認証は無いので、
信頼できないネットワークでは `PCUBE_HOST=127.0.0.1` に絞ること。

テストは一時ディレクトリに git リポジトリと `.pcube/` を作って動かす（`test/helpers.ts`）。
Codex の経路は、JSON-RPC を話す偽の app-server（`test/fixtures/fake-codex.mjs`）に差し替えて確かめる。
CLI のテストは別プロセスで `bin/pcube.mjs` を動かし、マシンの `.env` の Codex 設定は効かないようにしている。

## 構成

```
src/
  shared/            型定義・参照の解き方・日付（サーバ/Web 共通）
  cli/               pcube CLI（ファイルを直接操作。serve でサーバも起動する）
  server/
    ops.ts           CLI と API で共通の操作（参照・関係の規則・進捗の集計など）
    store/           要望のフォルダとタスクのコレクション、frontmatter、Preflight の保存、監視
    intel/           関係グラフ・影響範囲・類似検索（インテリジェンス層）
    preflight/       エンジン（codex-workspace / mock）と実行・タスク化
    api/             REST + SSE
  web/               React + TanStack Router + Tailwind（text-base 基準）
    routes/          ページ（1ファイル1ページ。__root.tsx が共通の枠）
    routeTree.gen.ts ルート一覧（自動生成）
    components/      複数のページで使う部品（タスク詳細のドロワー、要望のステータスなど）
bin/pcube.mjs        CLI の起動口（tsx でソースをそのまま動かす）
scripts/demo.ts      開発用のデモデータを作る
docs/                設計の方針
test/                ユニットテスト（store / locate / intel / ops / preflight / api / cli）
```

技術: TypeScript, React 19, TanStack Router, Tailwind CSS 4, Vite, Hono, Node 24（tsx）, pnpm, [@llmcs/codex-workspace](https://github.com/tamuto/llmcs/tree/main/codex-workspace-ts)
