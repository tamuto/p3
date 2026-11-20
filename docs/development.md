# 開発ガイド

P3 そのものを開発するときの手順と、ソースの構成。使い方は [使い方ガイド](how-to-use.md)、設計と規則は
[docs/architecture.md](architecture.md)、公開の手順は [docs/publishing.md](publishing.md)。

## このリポジトリから動かす

開発には Node 26 を使う（Docker のイメージと同じ）。使うだけなら Node 24 以上でよい（`engines` は `>=24`）。

```bash
pnpm install
pnpm build                   # 画面（p3 serve で配信する packages/p3/dist/web）と配布物（dist/package）
pnpm --dir packages/p3 link --global   # `p3` コマンドをこのチェックアウトで使う（任意）
```

グローバルに入れずに、P3 の場所を指定して pnpm で直接動かしてもよい。管理したいリポジトリ（やその作業ツリー）の中で:

```bash
pnpm -s --dir /path/to/p3 p3 whoami     # -s で pnpm 自身の出力を抑える（--json の出力は stdout だけに出る）
```

pnpm はスクリプトをパッケージの場所で動かすが、P3 は呼び出し元の場所（pnpm が渡す `INIT_CWD`）に戻ってから
対象のプロジェクト・今の要望（作業ツリーのブランチ）・git のユーザーを判定する（ルートの `p3-workspace` と入口の `@infodb/p3` の `p3` スクリプトのとき）。

このリポジトリは pnpm workspace で、入口（`packages/p3`）・tasks（`packages/tasks`）・kit（`packages/kit`）の3つのパッケージに分けている
（下の「構成」と [docs/architecture.md](architecture.md#パッケージの構成)）。コマンドはどれもルートで動かす。

## よく使うコマンド

```bash
pnpm dev                     # API サーバ（p3 serve, tsx watch）+ Vite  http://localhost:5173
pnpm build && pnpm start     # ビルドした画面を p3 serve から配信  http://localhost:4310
pnpm typecheck
pnpm lint                    # oxlint（型情報も使う。下の「lint」）
pnpm test                    # ユニットテスト（vitest）。pnpm test:watch で監視
pnpm test:ui                 # ブラウザで画面を操作する UI テスト（ビルドした画面が要る。下の「UI テスト」）
pnpm check                   # ブラウザの確認 + 型検査 + lint + テスト + ビルド + UI テスト
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
  # $p3 を明示して、入口が最初に実行させるもの（pnpx @infodb/p3 guide --json）と、取れないときに止まることを引用させる
  codex exec --ephemeral --ignore-user-config -s read-only '$p3 Do not run anything. Quote what the skill says to run first and what to do if that fails.'
  ```

  スキルの frontmatter の `metadata`（入口の版 `p3-entry-version`）があっても一覧に出ることも、ここで確かめる。
  個人のスキル（`~/.agents/skills`・`/etc/codex/skills`）と `~/.codex/config.toml` の `[[skills.config]]` に p3 が無いことを先に確かめる。
  Codex がスキルを探す場所は公式の文書（<https://developers.openai.com/codex/skills/> の「Where Codex loads local skills」）
- 入口から手順を読む流れ（入口 → `pnpx @infodb/p3 guide --json` → `whoami --json`）を本物のエージェントが辿るかは、テストでは確かめ
  られない。入口（`skills/p3/SKILL.md`・`agentsSnippet`）か `ENTRY_VERSION` を変えたときは、一時フォルダのプロジェクトに入口を置いて
  Claude Code・Codex に p3 の作業（「進捗を見せて」など）を頼み、guide を読んでから whoami に進むこと、古い入口（前の全文のスキル）に
  したときは `agents` の状態を人に伝えて自分で `p3 agents` を実行しないことを確かめる。入口は公開版（`pnpx @infodb/p3`）を呼ぶので、
  `guide` を含む版を公開する前は guide が取れない（前の版にはコマンドが無い）。その間は「取れなければ p3 を操作せず、エラーと呼び方を
  伝えて終える」ことだけを確かめ、取れたときの流れは公開した後に確かめる（版と結果はタスクの変更の記録に残す。確かめられなければ未検証と書く）
- 手元の対話エージェントの Preflight（`--prepare` / `--complete`）は、CLI と取り込みを別プロセスのテストで確かめる
  （`test/localPreflight.test.ts`。PATH を空にして Codex・Docker・claude を呼べない状態で通す）。Claude Code が入口のスキルから手順（`p3 guide`）を読んで
  担当（`preflight.runner`）どおりに依頼を解釈するか、指示のファイルを読み切るかはテストでは確かめられない。担当で分けた手順の書き方の
  契約は `test/agents.test.ts`、agent の親子の prepare → complete → drafts は `test/localPreflight.test.ts` が確かめる。手順（`packages/p3/src/cli/guide.md`）の Preflight の
  節や指示の形を変えたときは、一時フォルダのプロジェクト（`init --agents claude --preflight-runner agent`）を Claude Code で開き、
  親と子の要望を作って「要望 <ID> の Preflight をして」と頼み、prepare → 成果物 → complete → drafts まで進んで accept しないこと、
  依頼の無い登録では始めないことを確かめる。`p3 config set preflight.runner=codex` に変えて、「Preflight して」とだけ頼むと聞き返すこと、
  「このチャットで実行して」と明示すると手元で評価することも確かめる（版と結果はタスクの変更の記録に残す。確かめられなければ未検証と書く）。Claude Code がスキルを読む場所は公式の文書（<https://code.claude.com/docs/en/skills>）
- CLI のテストは別プロセスで `bin/p3.mjs` を動かし、個人設定を一時フォルダに分け、このマシンの `P3_*` の環境変数は効かないようにしている。
  コマンドのまとまりごとに `test/cli*.test.ts`（init・join・agents・タスク・要望・Preflight・設定・プロジェクトの決まり方・作業先と添付）に分け、
  共通の準備（CLI の呼び出し `p3()`・テストごとの個人設定 `CONFIG_HOME`・初期化済みのプロジェクト `initialized()` など）は `test/cliHelpers.ts` に置く
  - 開発中の CLI は起動のたびに tsx で TypeScript を変換するので、1回に約 0.5 秒かかる。1つのファイルの中のケースは順に動くので、ケースを
    1つのファイルに積むと、そのファイルが `pnpm test` 全体の終わりを決める。CLI のケースを足すときは近いまとまりのファイルに入れ、
    1つのファイルが長くなったら分ける（ファイルの間は Vitest が並べて動かす。ケースどうしで場所や状態を共有しない）
  - 並べて動かすと CPU を取り合うので、CLI のテストファイルだけ1件の待ち時間を 60 秒にしている（`cliHelpers.ts`。ほかは `vitest.config.ts` の 20 秒）
  - 子のプロセスには親の `P3_*` を渡さないので、`vitest.config.ts` の `P3_HOST_PATHS=direct` も CLI の子には届かない。要る値はケースで
    `p3()` の `env` に明示する
  - 所要時間を比べるときは、同じマシンで `pnpm test` を数回流し、全体の時間の中央値とファイルごとの時間を見る
    （`pnpm vitest run --reporter=json --outputFile=<ファイル>` の各ファイルの `startTime`・`endTime`）
- データのフォルダの監視（`packages/tasks/src/core/store/dataWatcher.ts`）は `test/dataWatcher.test.ts` が確かめる。監視の失敗（入れ子の消失・
  読めないエラー・開始の失敗・読み込みの失敗）は監視を差し替えて確実に起こし、ログ・立て直し・続けての失敗でやめること・close の後に
  何も残らないことを見る。実際の監視は、通常の serve を別のプロセスで動かし（`test/fixtures/watchChild.ts`）、`drafts/` を作っては
  消し続けても落ちず、API が答え、close の後に自分で終わることを見る。`--all-projects` で一方の監視が壊れても両方の API と
  Preflight が続くことは `test/allProjects.test.ts`。元の例外（Node 22 の再帰監視の未処理の `'error'`。2026-11-03 に `--all-projects` の
  serve が落ちた）は、Node 22.23.4 では別のプロセスに `drafts/` を作っては消させると再現し、Node 24.22.2・26.13.0 では同じ操作で
  起きなかった（2026-11-03 の記録。261103-fb5z1 / 261103-fx63g）。今の対象の Node（24 以上）では起きないので、毎回の手での確かめは
  しない。`'error'` を必ず聞く守りは残す（Node のほかの監視の失敗でも serve を落とさないため）。退行は差し替えた監視のテストが見る
- `test/layers.test.ts` が src の層の依存の向き、`test/package.test.ts` が配布物の中身と文書のリンクを確かめる
- 短い出力の量を測るときは:

  ```bash
  for t in T001 T002 T003; do p3 show <要望ID>/$t | wc -c; p3 show <要望ID>/$t --brief | wc -c; done
  pnpm vitest run test/showBrief.test.ts --reporter=verbose
  ```

### UI テスト

`test/ui/*.ui.test.ts` は、ブラウザ（Playwright の Chromium headless shell）で `p3 serve` のビルドした画面を開いて操作する。
設定は `vitest.ui.config.ts` で、通常の `pnpm test` には入らない。型検査・lint の対象には入る。

- `pnpm check` は、最初（型検査の前）に `pnpm check:browser`（`scripts/check-browser.ts`）で Chromium を起動してみる。実行ファイルが
  無い・起動できないなら、理由と入れ方を出してそこで止める（コンテナを作り直して消えたことに、単体テストとビルドを待たずに気づくため。
  `pnpm check` では UI テストを飛ばさない）。続けて型検査・lint・テスト・ビルドの後に `pnpm test:ui` を流す。単独で流すときは先に
  `pnpm build` する（ビルドが無ければ、Chromium の有無によらず失敗にする）
- Chromium は `pnpm exec playwright-core install chromium-headless-shell` で入れる（自動では入れない）。`pnpm test:ui` を単独で流した
  ときは、Playwright が起動する実行ファイル（既定のキャッシュか `PLAYWRIGHT_BROWSERS_PATH`）が無いときだけ、理由と入れ方を出して
  UI テストを飛ばす（件数は vitest の skipped に出る）。実行ファイルがあるのに起動できない（共有ライブラリが無いなど）・サーバが起きない・操作の対象が
  見つからないときは失敗にする（判定は `test/ui/chromium.ts`、本物の Chromium を使わない確認は `test/uiHarness.test.ts`）。
  共有ライブラリが無いと出たら `pnpm exec playwright-core install-deps chromium-headless-shell` で入れる
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
- 縦スクロール（`test/ui/verticalScroll.ui.test.ts`）: 幅 1280 / 375・高さ 900 / 600・明暗で、通常のタスク案・子の分割案・
  親を持つ子（長い題の祖先が2段）・Preflight 未実行の要望を開き、文書と `main` が縦に送れず本文（`request-content`）だけが送れること、
  本文を下端まで送ると最後の要素まで届くこと、送ったあともコピーとタブが画面内にあること、横に送るタブと上のナビゲーションが縦に送れないこと、子の分割案の「採用内容を確認」と実行ログの
  末尾に届くことを測る。進捗・新しい要望・設定の3つのタブ・リリースノート・タスクボード・対応済みは、文書と上のナビゲーションとタブ（設定・リリースノートの tablist）が縦に
  送れないことだけを測る。測るのは名指しした要素（文書・`main`・本文・タブ・上のナビゲーション・実行ログ）の送れる量で、すべての要素を数えはしない。ほかの局所スクロールの
  中身や、通知（再読み込みの失敗・外での削除）が出ているときの高さは測らない
- 文字の大きさと拡大（`test/ui/readability.ui.test.ts`）: 下の「画面の文字と余白」の確認する画面を、幅 1280（明るい）と 375（暗い）で開き、
  見えている文字の計算済みの大きさ（本文・見出し・操作は 16px 以上、補助の情報は 14px 以上。`test/ui/layout.ts` の `fontProblems`）と
  横のはみ出しを測る。200% の拡大は CSS の幅 640×450 で同じ画面を開いてはみ出しを測り、新しい要望（タイトル → 作成）・設定（プロジェクト名 →
  保存 → 元に戻す）・タスクの詳細（入力 → 保存）にキーボード（Tab）で届き、届いた操作が画面内に見えることを確かめる
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

- **対象**: package.json の `lint` に並べた各パッケージの `src`（入口・tasks・observer・kit）と入口の `bin`・`scripts`・`test`・`vite.config.ts`・`vitest.config.ts`・
  `vitest.ui.config.ts`。この中の `.mjs`（起動の補助・偽の app-server など）も、TypeScript の対象ではないが型情報なしの規則で検査する
- **除外**: 生成したルート一覧 `packages/p3/src/web/routeTree.gen.ts`。`dist/`・`node_modules/`・`.p3-demo/` は対象のフォルダの外
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
- 失敗を受け止めない処理は `runAction(処理, (文言) => …)`（`packages/tasks/src/web/lib/action.ts`）で、失敗を画面に渡す
- 読み直し（`reload`）のように失敗を状態に入れて投げない関数は、子には `() => void reload()` を渡す

`test/lint.test.ts` が、採用した規則の代表的な違反（Hooks・待たない Promise・Promise の渡し方）で lint が失敗することと、
対象と除外を実際に動かして確かめる。

## 構成

pnpm workspace の4つのパッケージ。依存の向きは 入口 → 製品（tasks・observer）→ kit の一方向で、製品どうしは読まない（`test/packageBoundary.test.ts`）。パッケージの間はパッケージ名
（`@infodb/p3-tasks/core/context.ts` のように、パッケージの `src` からのパス）で読み、相対パスで別のパッケージのファイルを指さない。
入口と製品の `src` は同じ層に分ける（依存の向き: shared ← core ← server / cli、web → shared。`test/layers.test.ts`）。設計と、機能ごとの
置き場所は [docs/architecture.md](architecture.md#パッケージの構成)。

```
packages/
  p3/                入口 @infodb/p3（npm・Docker で配るのはこれ。kit・製品はビルドして同梱する）
    bin/p3.mjs       CLI の起動口（チェックアウトでは tsx でソースを、配布物ではビルドした lib/ を動かす）
    src/cli/         main.ts（引数の解釈・プロジェクトの決定・serve・help・guide・init・join・agents）・project.ts（init / join / agents）・
                     guide.ts と guide.md（AI 向けの作業の手順の原本。p3 guide が返す）・agentsStatus.ts・help.ts
    src/server/      server.ts（待ち受けと画面の配信。全部の製品の API を付ける）・api/projectsRoutes.ts（プロジェクトを跨ぐ serve）
    src/core/        projectRegistry.ts（プロジェクトを跨ぐ serve の登録の一覧）
    src/shared/      products.ts（組み込んだ製品と、廃止した --products の案内）
    src/web/         画面の外枠（main.tsx・Boot・App・router・shell.ts（この画面の製品）・routes/__root.tsx・プロジェクトの選択）と index.html・index.css。
                     routeTree.gen.ts はルート一覧（自動生成。tasks と observer のページも入る）
  tasks/             @infodb/p3-tasks（今の p3 の機能。公開しない）。共通の土台（層ごと）と機能のまとまり（features/）に分ける
    src/shared/      型定義・参照の解き方・日付・判定（core と画面の共通。I/O と node: は使わない）
    src/cli/         tasksCli.ts（プロジェクトを開いた後の振り分け）・コマンドの種類ごと（taskCommands.ts など。変更は core/requestOps.ts を通す）・
                     readOnly.ts・args.ts・output.ts
    src/core/        CLI と serve の共通の中核（HTTP は使わない）。requestOps.ts（変更の手順）・ops.ts（読み取り）・store/（保存・監視・項目の
                     まとまり fieldGroups.ts・JSON の記録 jsonRecord.ts）・preflight/（Preflight と AI の実行: エンジン・Codex と ChatGPT・Docker・
                     画面資料）・reviewRuns.ts（レビューの実行の骨組み）・errorOutcome.ts（エラーから終了コードと HTTP の状態への表）・
                     context.ts（プロジェクトを開く）・userConfig.ts・machineSettings.ts
    src/server/api/  API の組み立て（routes.ts が機能の API をつなぐ）と共通の API
    src/web/         画面の共通の部品（components/）・処理（lib/）・ルートの宣言（routes/。ページの中身は機能の web/ から読む）
    src/features/    機能のまとまり。<機能>/{shared,core,cli,server,web} に層で分ける: metrics・records（完了の記録・手戻り・見直し候補・前提）・
                     quality・retro・requirements（要求の根拠・回答・受け入れ基準）・settings・taskReview・milestoneReview・releaseNotes。
                     読んでよいものは docs/refactoring.md「モジュール構成」（test/featureBoundary.test.ts）
  observer/          @infodb/p3-observer（観測基盤。準備中で、今は起動の確認だけ。公開しない）: shared/status.ts（起動状態の型・ページと API の場所）・
                     core/status.ts・cli/observerCli.ts（p3 observer）・server/api/routes.ts（/api/observer）・web/（/observer のページ）
  kit/               @infodb/p3-kit（入口と製品が使う最小限の共通処理。公開しない）: fsutil.ts・frontmatter.ts・usage.ts・appInfo.ts
skills/p3/SKILL.md   AI 向けの入口のスキルの原本（p3 init --agents / p3 agents で .claude/skills・.agents/skills の選んだ先に写す。本文は p3 guide から読ませる）
scripts/             配布物のビルド（build-cli.mjs）・デモデータ・配布物の確認・使い方の動画（video/）
docs/                導入・使い方・開発・設計・公開の文書（利用者向けの入口。配布物にも入れる）
test/                ユニットテスト（パッケージをまたいで確かめるのでルートに置く）
```

- 外の依存は使うパッケージの manifest に書く（入口は実行時の依存をまとめて持つ。kit・製品の実行時の依存は入口の `dependencies` にも同じ範囲で書く。
  `test/package.test.ts`）。テストだけが直接使う外の部品はルートの `devDependencies`
- 製品を足すときは `packages/` に置き、入口から明示して組み込む。境界・層・版の同期・同梱の検査の一覧（`test/packageBoundary.test.ts`・`test/layers.test.ts`・
  `test/package.test.ts`・`scripts/build-cli.mjs` の `PRODUCTS`・`tsconfig.build.json`・`Dockerfile` の manifest の COPY・`package.json` の `lint`・
  `test/pack.test.ts` と `scripts/verify-pack.mjs` の tarball の中身）も同じ変更で直す。observer の観測の実装を置く範囲は [設計: p3-observer](architecture.md#p3-observer)
- tasks に機能を足すときは `features/<機能>/` に層で分けて置き、CLI は `cli/tasksCli.ts`、API は `server/api/routes.ts`、画面は `web/routes/` からつなぐ。
  ほかの機能の中身は読まず、契約は `shared/` に置く（`test/featureBoundary.test.ts`）。コード量は `node scripts/measure-code.mjs` で数える

画面のページは TanStack Router のファイルベースのルーティングで、`packages/tasks/src/web/routes/` にファイルを置けば足りる
（入口の `__root.tsx` の下に、このフォルダをそのまま付ける。`tsr.config.json` の `virtualRouteConfig`）。機能のページは、ルートのファイルに
URL と検索の値の宣言だけを置き、中身を機能の `web/` に書く（例: `routes/metrics.tsx` と `features/metrics/web/MetricsPage.tsx`）。
小さいページは中身もそのファイルに書く。大きいページは、ルートのファイルを組み立て（状態と並び）だけにし、部品を
`packages/tasks/src/web/components/<ページ>/` に分ける（要望の画面は `components/request/`）。ルート一覧 `packages/p3/src/web/routeTree.gen.ts` は
`pnpm dev` / `pnpm build` / `pnpm typecheck` のたびに生成される（型検査のためにコミットしておく）。画面のビルド（Vite の root）は入口の
`packages/p3/src/web` で、Tailwind は tasks の `src/web` のクラスも拾う（`index.css` の `@source`）。

規則を足すときに直す場所は [docs/architecture.md](architecture.md) の「規則の置き場所」。

## 画面の文字と余白

文字を小さくして詰め込まない。狭い幅でも文字は縮めず、折り返す・行を高くする・局所スクロールにする。

| 用途 | 大きさ | 例 |
| --- | --- | --- |
| 本文・フォームの見出し・主な操作 | 16px 以上（`text-base`。基底の大きさ） | 説明の文、一覧の題、表のセル、ボタン・リンク・入力、`Field` の見出し |
| 見出し | 本文より大きく（`Section` は `text-lg`、ページは `text-xl` / `text-2xl`） | 区切りの見出し、詳細・ダイアログの題 |
| 補助の情報 | 14px 以上（`text-sm`）。要素に `data-aux` を付けるか等幅（`font-mono`） | ID・日時・件数・バッジ（`Badge`・ステータスの札）・パス・入力の下の補足（`Field` の hint） |

- 12px 以下（`text-xs`・`text-[10px]` など）は文字に使わない。記号だけの印（✓ など、文字を持たない装飾）は例外
- 主な説明に淡い色を使わない。明るいテーマの説明・補足は `text-slate-500` 以上の濃さ（`text-slate-400` は暗いテーマ用）。フォームの見出しは
  `text-slate-700`（暗いテーマは `text-slate-300`）
- 補助の情報を本文の要素（p・li・label・button など）の中で 14px にするときは `data-aux` を付ける（UI テストが本文と区別する）
- 狭い進捗の要望名も本文として 16px で、2行まで折り返す（行の高さは2行とステータスの段が入るように決める。`routes/index.tsx` の `ROW_H`）
- 全体の CSS で大きさを強制的に上書きせず、部品ごと・用途ごとに上の大きさを選ぶ
- 確認する画面: 進捗・新しい要望・要望の概要と Preflight の案・タスクボードとタスクの詳細・設定（プロジェクト・品質基準）・リリースノート
  （マイルストーン・レビュー）。幅 375 / 1280・明暗のテーマ・200% の拡大で、はみ出しと操作への到達を確かめる（上の「UI テスト」）

## npm で配る中身

`@infodb/p3`（入口のパッケージ）として npm に公開する（公開そのものは人が行う。手順は [docs/publishing.md](publishing.md)）。kit・製品（tasks・observer）は
公開せず、ビルドして同梱する。画面と CLI・serve をビルドして同梱し、利用者の環境では TypeScript を変換しない（`tsx` とそれが使う esbuild を
入れないので、pnpm がビルドのスクリプトの許可を聞かない）。このリポジトリの開発（`pnpm p3`・テスト）は、今までどおりソースを `tsx` でそのまま動かす。

| 何を | どうする |
| --- | --- |
| 公開する中身 | `pnpm build` が `dist/package/` に組み立てる（`npm pack ./dist/package`・`npm publish ./dist/package`）: 入口の `bin/`、`lib/`（ビルド済みの CLI・serve。入口は `lib/{cli,core,server,shared}`、同梱した製品は `lib/tasks/`・`lib/observer/`、kit は `lib/kit/`。描画のイメージの資材 `lib/tasks/core/preflight/render-image/` などの .ts 以外の資材を含む）、`dist/web`（ビルド済みの画面）と、ルートの `skills/`（AI 向けスキルの原本）・`docs/`（README から辿る文書）・README・LICENSE |
| 公開する manifest | `packages/p3/package.json` から開発だけの項目（`devDependencies` の workspace の参照・`scripts`）を外したもの。workspace のパッケージ（`@infodb/p3-tasks`・`@infodb/p3-observer`・`@infodb/p3-kit`）の名前は manifest にも実行時の import にも残らない（`test/pack.test.ts`） |
| 同梱しないもの | `.env`・個人設定・デモデータ（`.p3-demo/`）・テスト・`scripts/`・TypeScript のソース（`packages/`・`src/`）・開発用のスキル（`.claude/`） |
| 実行時の依存 | `hono`・`@hono/node-server`・`yaml`・`zod`・`@infodb/codex-workspace`・`@infodb/chatgpt-plan`（入口の `dependencies`）。`tsx`（esbuild）と React などの画面の部品は開発用 |
| CLI・serve のビルド | `scripts/build-cli.mjs`（`pnpm build` の後半）。一時のフォルダ `packages/p3/build-src/` に配布物と同じ並び（入口の src/{cli,core,server,shared}・`tasks/`・`observer/`・`kit/`）でソースを集め、パッケージ名の import を集めた先への相対パスに書き換えてから、`tsc` で `packages/p3/lib/` に 1:1 で出す（相対の import の `.ts` は `.js` に書き換わる）。.ts 以外の資材は同じ場所に写す。入口の `lib/{cli,server}` は `src` と同じ深さなので、`import.meta.url` からの相対の参照（`../../package.json`・`dist/web`）はそのまま効く。スキルの原本は上へ探す（配布物は同梱した `skills/`、チェックアウトはルートの `skills/`）。tasks の資材はそのファイルと同じフォルダだけを参照する。資材を足すときは、その層のフォルダに置けば写る。`packages/p3/lib/`・`dist/` は git で追跡しない |
| Node | `>=24`（`@infodb/codex-workspace`・`@infodb/chatgpt-plan` の `>=22` を満たす）。開発と Docker のイメージは Node 26 |
| 公開前のビルド | ルートの `pnpm build`（`vite build` と `scripts/build-cli.mjs --require-web`）。入口の manifest にはスクリプトを書かない。利用者が入れるときにはビルドも Docker の操作もしない |
| bin | `p3`（`packages/p3/bin/p3.mjs`）。`packages/p3/src/cli/main.ts` があるチェックアウトでは tsx でソースを、無ければ（配布物）`lib/cli/main.js` を動かす。ソースを動かすときは今いる場所の `tsconfig.json` を読まない。`INIT_CWD` に戻るのは P3 自身の `pnpm p3` スクリプト（ルートの `p3-workspace` か入口の `@infodb/p3`）のときだけ |
| 動いている版 | 入口が起動のときに自分の package.json の版を kit の `appInfo.ts` に渡し、tasks（Codex に名乗る版など）はそこを読む |

```bash
pnpm -s check                       # 型検査・lint・テスト・画面のビルド・UI テスト
pnpm verify:pack --docker           # pnpm build → npm pack ./dist/package → 実行時の依存だけで別の場所に入れて動かす（scripts/verify-pack.mjs）
# DevContainer の中では、描画の出力先を Docker のホストから見えるところにする
P3_CODEX_PATH_MAP=/workspaces=/home/me/workspaces pnpm verify:pack --docker --render-dir /workspaces/tmp
```

## Docker のイメージ

`Dockerfile`（Docker Hub の `tamuto/p3`。ビルドは Node 26 と packageManager の pnpm でロックファイルどおりに入れ、`pnpm build` の後に `npm pack ./dist/package` で
公開と同じ tarball を作って展開し、実行時の依存は `pnpm --filter @infodb/p3 deploy --prod` で workspace の lockfile のまま入口の分だけを
入れる。実行も Node 26・git・Docker の CLI と buildx。既定は `serve --all-projects --host 0.0.0.0`）と `.dockerignore`
（git・依存・ビルドの出力・データ・個人設定・認証・テストを入れない）。約束は `test/docker.test.ts` が確かめる。
ベースの Node はメジャー版（ビルドも実行も `node:26-bookworm-slim`。描画のイメージも同じ）だけを指定し、同じメジャーの中の更新（セキュリティ
リリースなど）は作り直すと入るようにしている。ただし Docker は手元にあるベースをそのまま使う（キャッシュ）ので、作るときは
`--pull` を付けて今のベースを取る（`scripts/verify-docker.mjs` も付ける。`--no-build` は作らずに既にあるイメージを確かめる）。
Docker の CLI と pnpm は版を固定し、メジャー版を上げるのは別の変更として行う。作り直しても、公開済みのイメージと起動中の
コンテナは変わらない（push し、使う側が pull して起動し直す）。
公開（人が行う）は [publishing.md](publishing.md#6-docker-hubtamutop3) の手順で、`linux/amd64` だけを作り、CI は使わない。使い方は [導入ガイド](installation.md#docker-で動かすプロジェクトを跨ぐ-serve)。

```bash
docker build --pull -t tamuto/p3:dev .
node scripts/verify-docker.mjs                      # ビルド（--pull）して、使い捨ての2つのプロジェクトで動かす（スモーク）
# DevContainer の中では、Docker のホストから見えるフォルダと、そのホストのパスを渡す。公開したポートはホストにしか開かないので、
# このコンテナのネットワークに入れる
P3_CODEX_PATH_MAP=/workspaces=/home/me/workspaces node scripts/verify-docker.mjs --work /workspaces/tmp --network-of auto
```

スモークで確かめること: 起動の約束（ENTRYPOINT・既定の CMD・入れた道具）・2つのプロジェクトの一覧・登録世代つきの作成と手元の
ファイル・同じ ID の分離・添付・ソケットが無いときのエンジンの状態・Mock の Preflight の同時実行と片方の取消・再起動のあとに残る
こと・データのフォルダの欠落と復旧・`docker stop`（SIGTERM）で実行中の Preflight を取り消して止まること・コマンドの明示で通常の
serve になること・どの起動でも製品は両方（observer の API も動く）で、以前の `--products` は使い方の誤り（終了コード 1）になること。本物の Codex（ソケット・pathMap・ChatGPT の接続）での Preflight・画面資料・要約の生成は、このスクリプトでは
確かめない（接続できる環境で手で確かめ、結果を PR に残す。Mock の成功で代わりにしない）。

マウントするパスの自動の決め方（`packages/tasks/src/core/preflight/hostPaths.ts`）は `node scripts/verify-host-paths.mjs` で本物の Docker で
確かめる。このマシン（DevContainer など）と、Dockerfile から作ったイメージ（中と外で違うパスの bind 2つ・名前付きボリューム・
ソケット・コンテナの名前と違うホスト名）の両方で、`codex.pathMap` の無い使い捨ての個人設定の p3 が、`p3 user-config paths` で
自分のコンテナを確かめてパスを決めること、bind の下の原稿を `p3 render` で PNG にすること、volume の下・コンテナの中だけの原稿・
繋がらない `DOCKER_HOST` では描画のコンテナを起こさずに止まること（`docker events` で数える）を確かめる。`--work` は Docker の
ホストから見える（bind の下の）フォルダ（既定はこのリポジトリの親）。本物の Codex の Preflight は ChatGPT のプランを使うので
このスクリプトでは動かさず、人が `codex.pathMap` を外した状態で `p3 preflight` を実行して確かめる。

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
| [README](../README.md) | 何をするツールか・必要なもの・最短の手順（参加して画面を開くまで）・次にできること・文書の案内だけ |
| [docs/installation.md](installation.md) | 導入を段階の順に（段階 0: 参加・作成と画面、段階 1: Preflight の準備（Docker・パスの対応・ChatGPT・Codex のイメージ）、段階 2: 任意の機能への入口）。つまずいたとき・マシンごとの設定・Docker で動かす。段階 0 に段階 1 以降の準備を混ぜない（`test/docs.test.ts`）。段階 2 の機能の操作は使い方ガイドに書き、ここからはリンクする |
| [docs/how-to-use.md](how-to-use.md) | 使い方の手順とリファレンス（操作・状態・データ・画面・CLI） |
| [docs/architecture.md](architecture.md) | 設計と規則（なぜそうするか・どこで守っているか） |
| [docs/chatgpt-sign-in.md](chatgpt-sign-in.md) | ChatGPT のサインインの設計 |
| [docs/publishing.md](publishing.md) | npm への公開のチェックリスト |
| [docs/refactoring.md](refactoring.md) | 重複の整理とモジュール構成の組み直し（計測の定義と基準・重複の棚卸し・契約とテストの対応・段階ごとにまとめたもの） |
| [docs/feature-inventory.md](feature-inventory.md) | 機能の棚卸し（機能ごとの維持・統合・簡素化・分離・廃止・保留の判断と、複数パッケージの構成での所属の候補）。機能を足す・分けるときと、パッケージの構成を変えるときに見直す |
| docs/development.md（この文書） | 開発の手順と構成 |

同じ説明を複数の文書に書かない（片方からリンクする）。確認作業の記録（どの幅・どのブラウザで確かめたか）は文書に書かず、
PR とタスクの変更の記録に残す。CLI のヘルプ（`packages/p3/src/cli/help.ts`）・API の説明（`packages/tasks/src/server/api/manifest.ts`）は入口が変わったとき、
AI の手順が変わったときは手順の原本 `packages/p3/src/cli/guide.md`（`p3 guide` が返す）の1か所を直す。置く入口（`skills/p3/SKILL.md` と
`packages/p3/src/cli/project.ts` の `agentsSnippet`（`AGENTS_SNIPPET`））は、入口に書くこと（呼び方・読み込みの約束）を変えたときだけ両方を直し、
`packages/p3/src/cli/guide.ts` の `ENTRY_VERSION` を上げる（手順の本文だけの改訂では上げない。`test/agents.test.ts` が確かめる）。
