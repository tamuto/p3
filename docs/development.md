# 開発ガイド

P3 そのものを開発するときの手順と、ソースの構成。使い方は [使い方ガイド](how-to-use.md)、設計と規則は
[docs/architecture.md](architecture.md)、公開の手順は [docs/publishing.md](publishing.md)。

## このリポジトリから動かす

開発には Node 24 を使う（Vite 8）。使うだけなら Node 22 以上でよい。

```bash
pnpm install
pnpm build                   # 画面（p3 serve で配信する dist/web）
pnpm link --global           # `p3` コマンドをこのチェックアウトで使う（任意）
```

グローバルに入れずに、P3 の場所を指定して pnpm で直接動かしてもよい。管理したいリポジトリ（やその作業ツリー）の中で:

```bash
pnpm -s --dir /path/to/p3 p3 whoami     # -s で pnpm 自身の出力を抑える（--json の出力は stdout だけに出る）
```

pnpm はスクリプトをパッケージの場所で動かすが、P3 は呼び出し元の場所（pnpm が渡す `INIT_CWD`）に戻ってから
対象のプロジェクト・今の要望（作業ツリーのブランチ）・git のユーザーを判定する。

## よく使うコマンド

```bash
pnpm dev                     # API サーバ（p3 serve, tsx watch）+ Vite  http://localhost:5173
pnpm build && pnpm start     # ビルドした画面を p3 serve から配信  http://localhost:4310
pnpm typecheck
pnpm lint                    # oxlint（型情報も使う。下の「lint」）
pnpm test                    # ユニットテスト（vitest）。pnpm test:watch で監視
pnpm test:ui                 # ブラウザで画面を操作する UI テスト（ビルドした画面が要る。下の「UI テスト」）
pnpm check                   # 型検査 + lint + テスト + ビルド + UI テスト
pnpm demo:reset              # デモデータ（.p3-demo/）を作り直す
pnpm verify:pack             # 配布物を別の場所に入れて動かす（--docker で codex update と render も）
pnpm video                   # 使い方の動画を録り直す（.p3-video/p3-demo.mp4。下の「使い方の動画」）
```

- `pnpm dev` / `pnpm start` は P3 自身の開発を題材にしたデモデータ（`.p3-demo/`、git 管理外）を開く。無ければ自動で作る
  （`scripts/demo.ts`。中身は `scripts/demoData.ts`）。作るときに実際に Preflight（Mock）を走らせ、タスク化・作業の進行まで
  済ませるので、各画面をそのまま確かめられる
- `.p3-demo/` が既にあると `pnpm demo` は何もしない。デモの例を増やしたら `pnpm demo:reset` で作り直す（手で直した内容も消える。
  実際のプロジェクトのデータには触れない）
- サーバと Vite は既定で `0.0.0.0` で待ち受ける（DevContainer の外から見るため）。画面に認証は無いので、信頼できない
  ネットワークでは `serve.host: 127.0.0.1`（`P3_HOST=127.0.0.1`）に絞る

## テスト

- テストは一時ディレクトリに git リポジトリと `.p3/` を作って動かす（`test/helpers.ts`）
- Codex の経路は、JSON-RPC を話す偽の app-server（`test/fixtures/fake-codex.mjs`）に差し替えて確かめる。本物の Codex が実際に
  どこまで読むか、読むだけのマウントへの書き込みが拒まれることは、偽の app-server では確かめられない
- `init --agents` / `p3 agents` で置いたスキルを本物の Codex が見つけて読むかは、偽の app-server では確かめられない。置き場所
  （`AGENT_TARGETS`）や Codex の版を変えたときは、手で確かめる（結果はタスクの変更の記録に残す）:

  ```bash
  # 一時フォルダに git リポジトリを作り、個人設定も分けて置く（p3 を使わない別のリポジトリ other/ も作っておく）
  XDG_CONFIG_HOME=$TMP/cfg node <このチェックアウト>/bin/p3.mjs init --yes --agents --project sample --dir $TMP/data
  # ルート・サブフォルダ・other/ のそれぞれで、スキルの一覧と場所を聞く（p3 は .agents/skills/p3/SKILL.md、other/ では出ない）
  codex exec --ephemeral --ignore-user-config -s read-only "List every skill available to you with its SKILL.md path. Also quote what each skill root alias (r0, r1) maps to."
  # $p3 を明示して、本文だけにあること（whoami --json の via の確認・Preflight と accept は人）を引用させる
  codex exec --ephemeral --ignore-user-config -s read-only '$p3 Do not run p3. Quote what the skill says to check first and who runs Preflight and accept.'
  ```

  個人のスキル（`~/.agents/skills`・`/etc/codex/skills`）と `~/.codex/config.toml` の `[[skills.config]]` に p3 が無いことを先に確かめる。
  Codex がスキルを探す場所は公式の文書（<https://developers.openai.com/codex/skills/> の「Where Codex loads local skills」）
- CLI のテストは別プロセスで `bin/p3.mjs` を動かし、個人設定を一時フォルダに分け、このマシンの `P3_*` の環境変数は効かないようにしている
- `test/layers.test.ts` が src の層の依存の向き、`test/package.test.ts` が配布物の中身と文書のリンクを確かめる
- 短い出力の量を測るときは:

  ```bash
  for t in T001 T002 T003; do p3 show <要望ID>/$t | wc -c; p3 show <要望ID>/$t --brief | wc -c; done
  pnpm vitest run test/showBrief.test.ts --reporter=verbose
  ```

### UI テスト

`test/ui/*.ui.test.ts` は、ブラウザ（Playwright の Chromium headless shell）で `p3 serve` のビルドした画面を開いて操作する。
設定は `vitest.ui.config.ts` で、通常の `pnpm test` には入らない。型検査・lint の対象には入る。

- `pnpm check` は、型検査・lint・テスト・ビルドの後に `pnpm test:ui` を流す。単独で流すときは先に `pnpm build` する
  （ビルドが無ければ、Chromium の有無によらず失敗にする）
- Chromium は `pnpm exec playwright-core install chromium-headless-shell` で入れる（自動では入れない）。Playwright が起動する
  実行ファイル（既定のキャッシュか `PLAYWRIGHT_BROWSERS_PATH`）が無いときだけ、理由と入れ方を出して UI テストを飛ばす（件数は
  vitest の skipped に出る）。実行ファイルがあるのに起動できない（共有ライブラリが無いなど）・サーバが起きない・操作の対象が
  見つからないときは失敗にする（判定は `test/ui/chromium.ts`、本物の Chromium を使わない確認は `test/uiHarness.test.ts`）
- シナリオごとに一時のフォルダを作り、その中に HOME・個人設定（`XDG_CONFIG_HOME`）・git リポジトリ・データを置いて、本物の CLI
  （`bin/p3.mjs init`・`serve`）で動かす（`test/ui/env.ts`）。子の p3 には親の `P3_*`・`INIT_CWD`・`GIT_*`・`XDG_*` を渡さず、
  Mock のエンジン・変更者・cwd を明示する。手元の個人設定・プロジェクト・`.p3-demo/` には触れない。`p3 serve` は 127.0.0.1 の
  空いたポートで起こす（取られていたら別のポートで試し直す）。ブラウザは親の環境で起こす（一時の HOME をブラウザの探索に使わない）
- 主な流れ（`test/ui/flow.ui.test.ts`）: 要望の登録 → Mock の Preflight → 評価と案 → タスク化 → ボード → タスクの着手・完了
  （成果物・変更の記録）→ 済み → 要望の完了済を、すべて画面の操作で進め、再読み込みと CLI でも残っていることを確かめる
- 表示（`test/ui/layout.ui.test.ts`）: 進捗・新しい要望・概要と Preflight の案・タスクボード・タスクの詳細を幅 1280 と 375 で、
  案の詳細（Markdown の本文）を幅 375 / 768 / 1280 の明暗のテーマで開き、長い題・長いパス・複数の案・依存・表とコードのある本文で確かめる:
  ページ全体の横のはみ出し、枠（カード・行・詳細）からのはみ出し、ボードの並び（広い幅は未着手と完了が横、狭い幅は縦に積む）、
  詳細の枠と閉じるボタンが画面に収まること、局所スクロール（進捗の表・案の段階の列・本文・表・コード）の先へ届くこと、主な操作に届くこと、
  閉じる / Escape の後に開いたボタンへフォーカスが戻ること。状態（要望・Preflight・タスク化・案の本文）は CLI とデータのファイルで用意し、
  開く・閉じるなどの確かめる操作はブラウザで行う。測り方（`test/ui/layout.ts`）は DOM の寸法で、意図した局所スクロール（overflow が
  visible 以外の要素の中）とページ全体のはみ出しを分ける。測り方が崩れを見逃さないことも、わざと崩した要素で確かめる
- 限界: 画像の比較はしないので、色・重なり方・文字の欠けなど、測っていない見た目の乱れは保証しない。測るのは上の画面・幅・テーマだけ
- 日本語のフォント: Noto Sans CJK JP があれば、ブラウザを使い方の動画と同じ fontconfig（`scripts/fonts-ja.conf`）で起こし、寸法を
  日本語のフォントで測る（無い環境では既定のフォントのまま測り、そのことを出す。飛ばしはしない）
- 操作の対象は画面の文言・role・label で探し、固定の sleep はせず状態を待つ（上限は `UI_TIMEOUT`。`test/ui/scenario.ts`）。
  失敗すると、シナリオと手順・対象・その時の URL・画面の画像（`/tmp/p3-ui-failed-*/page.png`。中身は一時のデータだけ）・
  `p3 serve` のログの末尾を出す。画面の文言を変えたら、そのテストの対象の名前を直す
- 成功・失敗・時間切れのどれでも、ブラウザとサーバを止めて終わるのを待ってから一時のフォルダを消す（診断用の画像だけ残る）

## lint

`pnpm lint` は [oxlint](https://oxc.rs/docs/guide/usage/linter) で、型情報を使う規則（`--type-aware`。`oxlint-tsgolint` が
TypeScript 7 の型検査器で tsconfig.json を読む）も動かす。設定は `.oxlintrc.json`。ESLint・Biome・整形の道具は入れていない
（書式はそろえて書く）。指摘は全部エラーで、警告も使われていない無効化コメントも `pnpm check` を落とす。

- **対象**: tsconfig.json の include と同じ `src`・`scripts`・`test`・`vite.config.ts`・`vitest.config.ts`。この中の `.mjs`
  （起動の補助・偽の app-server など）も、TypeScript の対象ではないが型情報なしの規則で検査する。`bin/` は対象の外
- **除外**: 生成したルート一覧 `src/web/routeTree.gen.ts`。`dist/`・`node_modules/`・`.p3-demo/` は対象のフォルダの外
- **規則**: plugin は typescript・unicorn・oxc・react・import・promise・vitest。それぞれの correctness（誤りか無意味なコード）を全部
  使い、ほかのカテゴリは一括では入れず、次を選んで足す

| 足した規則 | 理由 |
| --- | --- |
| `react/rules-of-hooks` | Hooks を条件の中で呼ばない（`react/exhaustive-deps` は correctness に入っている） |
| `typescript/no-misused-promises` | Promise を返す関数を `onClick` など void を期待する所に渡さない（失敗が未処理になる。下の「待たない Promise」）。`typescript/no-floating-promises` は correctness に入っている |
| `typescript/no-unnecessary-type-assertion` | 要らない `as` / `!` を残さない（型が変わったときに隠れる） |
| `typescript/switch-exhaustiveness-check` | 状態の union の switch で漏れを出さない（`default` があればよい） |
| `typescript/only-throw-error`・`typescript/prefer-promise-reject-errors` | Error 以外を投げない・拒否しない（画面は `e.message` で知らせる） |
| `import/no-duplicates`・`import/no-cycle` | 同じモジュールの import を分けない・循環させない（層の向きは `test/layers.test.ts`） |

| 調整・外した規則 | 理由 |
| --- | --- |
| `eslint/no-unused-vars` に `ignoreRestSiblings` | `const { drafts, ...meta } = run` のように、項目を外すための分割代入を許す（使っていない変数そのものは tsc の `noUnused*` も見る） |
| `vitest/valid-expect` に `maxArgs: 2` | vitest の `expect(値, 失敗時の文言)` を許す |
| `react/refs`・`react/set-state-in-effect`（off） | React Compiler を前提にした規則。P3 は Compiler を使わず、最新の handler を ref に持つ形（`lib/live.ts`）や、外で変わった設定を編集中でなければ取り込む effect（設定の画面）を意図して書いている。直すと再取得・入力を残す約束を書き換えることになる |
| `typescript/no-base-to-string`（off） | YAML・frontmatter の読めない値を `String(v)` で文字にするところ（`core/store/normalize.ts` など）を全部指摘する。値の正規化の振る舞いは変えない |
| `vitest/no-conditional-expect`（off） | 画面をビルドしてあるときだけ確かめるなど、環境で分ける確認を意図して書いている |
| `vitest/require-mock-type-parameters`（off） | `vi.fn(async () => …)` の型は実装から推論される |

入れなかった規則: `typescript/no-unnecessary-condition`（nursery で、まだ変わる。試すと 56 件で、`?.` の防御も指摘する）、
suspicious カテゴリの一括（JSX で要らない `react-in-jsx-scope` などが大量に出る）、`typescript/no-unsafe-*`（テストの応答の JSON
など `any` を読む所が多く、試すと合わせて 1,400 件を超える。型を付ける作業は別にする）。

無効化のコメントは、その行で意図して違反するときだけ、規則と理由を付けて書く
（`// oxlint-disable-next-line no-control-regex -- 制御文字を外すのが目的`）。使われなくなったコメントは lint が落とす。
`eslint-disable` の形の既存のコメント（`react-hooks/exhaustive-deps`）も oxlint が読む。

**待たない Promise**: 画面の操作から非同期の処理を呼ぶときは、失敗を必ずどこかで知らせる。

- 中で try / catch して画面に知らせる関数（保存・Preflight の開始など）は `onClick={() => void save()}`。`void` は
  「待たない」の印で、失敗を隠すためには使わない
- 失敗を受け止めない処理は `runAction(処理, (文言) => …)`（`src/web/lib/action.ts`）で、失敗を画面に渡す
- 読み直し（`reload`）のように失敗を状態に入れて投げない関数は、子には `() => void reload()` を渡す

`test/lint.test.ts` が、採用した規則の代表的な違反（Hooks・待たない Promise・Promise の渡し方）で lint が失敗することと、
対象と除外を実際に動かして確かめる。

## 構成

```
src/                 依存の向き: shared ← core ← server / cli、web → shared（test/layers.test.ts で確かめる）
  shared/            型定義・参照の解き方・日付・判定（core と画面の共通。I/O と node: は使わない）
  cli/               p3 CLI（core でファイルを直接操作。serve でサーバも起動する）
    main.ts          振り分け・プロジェクトと変更者と今の要望の決定・終了コード
    taskCommands.ts / requestCommands.ts / preflightCommands.ts   コマンドの種類ごと（変更は core/requestOps.ts を通す）
    args.ts / output.ts / help.ts   入力の解釈・出力・p3 help
  core/              CLI と serve の共通の中核（HTTP は使わない）
    requestOps.ts    要望・タスクの変更の手順（CLI と API はここを呼ぶ。確かめる → 保存 → ブランチの割り当て・進行中に戻す → 変更通知）
    ops.ts           CLI と API で共通の読み取り（一覧・参照の解き方・進捗の集計など）
    store/           要望のフォルダとタスクのコレクション、frontmatter、Preflight の保存、監視
    preflight/       エンジン（codex-workspace / mock）と実行・タスク化
    chatgpt.ts       ChatGPT の接続（アプリ名・保存先・トークンの長さ。サインインと保存は @infodb/chatgpt-plan）
    context.ts / userConfig.ts / machineSettings*.ts   プロジェクトを開く・個人設定・マシンごとの設定
  server/            HTTP だけ（p3 serve）
    server.ts        待ち受けと画面の配信
    api/             REST + SSE（core を呼ぶ）
  web/               React + TanStack Router + Tailwind（text-base 基準）
    routes/          ページ（1ファイル1ページ。__root.tsx が共通の枠）
    routeTree.gen.ts ルート一覧（自動生成）
    components/      部品（複数のページで使うもの。大きいページの部品は components/<ページ>/）
bin/p3.mjs           CLI の起動口（tsx でソースをそのまま動かす）
skills/p3/SKILL.md   AI 向けスキルの原本（p3 init --agents / p3 agents で各プロジェクトの .claude/skills・.agents/skills の選んだ先に写す）
scripts/             デモデータ・配布物の確認・使い方の動画（video/）
docs/                導入・使い方・開発・設計・公開の文書
test/                ユニットテスト
```

画面のページは TanStack Router のファイルベースのルーティングで、`src/web/routes/` にファイルを置けば足りる。
小さいページは中身もそのファイルに書く。大きいページは、ルートのファイルを組み立て（状態と並び）だけにし、部品を
`src/web/components/<ページ>/` に分ける（要望の画面は `components/request/`）。ルート一覧 `src/web/routeTree.gen.ts` は
`pnpm dev` / `pnpm build` / `pnpm typecheck` のたびに生成される（設定は `tsr.config.json`。型検査のためにコミットしておく）。

規則を足すときに直す場所は [docs/architecture.md](architecture.md) の「規則の置き場所」。

## npm で配る中身

`@infodb/p3` として npm に公開する（公開そのものは人が行う。手順は [docs/publishing.md](publishing.md)）。TypeScript のソースを
`tsx` でそのまま動かし、画面だけをビルドして同梱する。

| 何を | どうする |
| --- | --- |
| 同梱するもの（`files`） | `bin/`・`src/cli`・`src/core`・`src/server`・`src/shared`（実行するソース。描画のイメージの資材 `src/core/preflight/render-image/` を含む）、`dist/web`（ビルド済みの画面）、`skills/`（AI 向けスキルの原本）、`docs/`（README から辿る文書）、README・LICENSE |
| 同梱しないもの | `.env`・個人設定・デモデータ（`.p3-demo/`）・テスト・`scripts/`・画面のソース（`src/web`）・開発用のスキル（`.claude/`） |
| 実行時の依存 | `tsx`・`hono`・`@hono/node-server`・`yaml`・`zod`・`@infodb/codex-workspace`・`@infodb/chatgpt-plan`。React などの画面の部品はビルドに使うだけなので開発用 |
| Node | `>=22`（`@infodb/codex-workspace` と同じ）。開発（Vite 8）は Node 24 |
| 公開前のビルド | `prepack` で `pnpm build`。利用者が入れるときにはビルドも Docker の操作もしない |
| bin | `p3`。起動口は今いる場所の `tsconfig.json` を読まない。`INIT_CWD` に戻るのは P3 自身の `pnpm p3` スクリプトのときだけ |

```bash
pnpm -s check                       # 型検査・lint・テスト・画面のビルド・UI テスト
pnpm verify:pack --docker           # npm pack → 実行時の依存だけで別の場所に入れて動かす（scripts/verify-pack.mjs）
# DevContainer の中では、描画の出力先を Docker のホストから見えるところにする
P3_CODEX_PATH_MAP=/workspaces=/home/me/workspaces pnpm verify:pack --docker --render-dir /workspaces/tmp
```

## 使い方の動画

一般公開する使い方の動画（日本語の字幕、約3分）は `pnpm video` で録り直す（`scripts/video/record.mjs`）。機能や画面を
変えて動画と合わなくなったら、台本（同じファイルの `scenes`。場面ごとの操作と字幕）を直して録り直す。出来上がりは
`.p3-video/p3-demo.mp4`（git 管理外。`--out <mp4>` で変える）で、リポジトリには入れない（公開先は人が決める）。

- 架空の経費精算アプリのリポジトリを使い捨ての HOME（`/home/me`）に作り、① 導入（`p3 init`）→ ② 要望の登録（AI の CLI と
  `p3 serve`）→ ③ Preflight → ④ 作業（AI の CLI と再読み込み）→ ⑤ 確認とリリース の順に、実際に p3 を動かしながら録る。
  ② の前に過去の要望と v1.0 のリリースを入れる（`scripts/video/seed.sh`。その間は録らない）。Preflight とリリースノートの
  要約は Mock（字幕とタイトルでそう断る）
- 映るのは汎用のパスと名前だけにする（`/home/me/src/expense`・`human:demo`・`github.com/example`）。P3 自身のデータは映さない
- 前提: Chromium（`pnpm exec playwright-core install chromium-headless-shell`）、ffmpeg（libx264）、日本語のフォント
  Noto Sans CJK JP（Debian / Ubuntu なら `fonts-noto-cjk`）、`/home/me` を作れること（DevContainer の root なら作れる）、
  ポート 4310 が空いていること。足りなければ録り始める前に止める。日本語は録画のときだけの fontconfig（`scripts/fonts-ja.conf`。UI テストと共用）で
  Noto Sans CJK JP に寄せる（中国語の字形のフォントで描かれないように）
- `/home/me` は印（`.p3-video-demo`）のあるときだけ消して作り直す。終わったら消す
- 画面の文言や操作が変わって操作の対象が見つからないと、15 秒で「場面「③ Preflight」で止まりました（対象: ボタンの名前）」と
  その時の画面の画像の場所を出して止まる（作業のフォルダは残す）。台本の対象の名前を今の画面に合わせて直す
- 録画は Chrome DevTools Protocol の screencast（変わったときだけ届く JPEG）で、届いた時刻から各フレームの長さを決めて
  ffmpeg で 30fps の mp4 にする（字幕・カーソル・CLI のパネルはページに重ねる `scripts/video/overlay.js`）

## 文書を直すとき

| 文書 | 書くこと |
| --- | --- |
| [README](../README.md) | 何をするツールか・必要なもの・最短の手順・文書の案内だけ |
| [docs/installation.md](installation.md) | 導入（Docker・パスの対応・ChatGPT・Codex のイメージ・つまずいたとき・マシンごとの設定） |
| [docs/how-to-use.md](how-to-use.md) | 使い方の手順とリファレンス（操作・状態・データ・画面・CLI） |
| [docs/architecture.md](architecture.md) | 設計と規則（なぜそうするか・どこで守っているか） |
| [docs/chatgpt-sign-in.md](chatgpt-sign-in.md) | ChatGPT のサインインの設計 |
| [docs/publishing.md](publishing.md) | npm への公開のチェックリスト |
| docs/development.md（この文書） | 開発の手順と構成 |

同じ説明を複数の文書に書かない（片方からリンクする）。確認作業の記録（どの幅・どのブラウザで確かめたか）は文書に書かず、
PR とタスクの変更の記録に残す。CLI のヘルプ（`src/cli/help.ts`）・API の説明（`src/server/api/manifest.ts`）は入口が変わったとき、
AI の手順が変わったときは `skills/p3/SKILL.md` と `src/cli/project.ts` の `agentsSnippet`（`AGENTS_SNIPPET`）の両方を直す。
