# 重複の整理とモジュール構成の組み直し

要望 261119-vwgf8 の記録。機能の取捨（削除・廃止）ではなく、同じ仕組みをまとめるリファクタリングと、複数パッケージの構成
（[設計: パッケージの構成](architecture.md#パッケージの構成)）に合わせた tasks のモジュール構成の組み直しを、段階に分けて行う。
機能と振る舞い（CLI・API・画面）、データの場所と形、配布、パッケージの間の依存の向き（入口 → tasks → kit）は変えない。

この文書は、始める前の基準（計測・重複の棚卸し・契約とテストの対応）と、各段階でまとめたもの・まとめなかったもの（理由）を残す。

## 計測の定義

コード量は `node scripts/measure-code.mjs`（`--json` で全部の値、`--root <チェックアウト>` で別の場所）で数える。

- **基準のコミット**: `f1eddda`（main。261119-9d1zk の後。0.13.0 のリリースの後）
- **製品のコード**: `packages/*/src` と `packages/p3/bin` の `.ts`・`.tsx`・`.mjs`
- **テスト**: `test/` の同じ拡張子。ユニットテスト・UI テスト（`test/ui`）・テストの資材（`test/fixtures`）に分ける
- **除くもの**: 生成したルート一覧（`*.gen.ts`）、`node_modules`、ビルドの出力（`lib`・`dist`・`build-src`。どれも src の外）、.ts 以外の資材
  （`.md`・`.html`・`.png`・Dockerfile など）、コンテナの中で動く描画のスクリプト（`core/preflight/render-image/`）
- **行**: 改行の数（空行・コメントを含む。コメントの行は別に数える）
- **機能別**: `scripts/measure-code.mjs` の `FEATURES` の順に、パスの語で決める（入口と kit はパッケージで、tasks は `src` の中のパスで照らす）。
  語で決めるので、ファイルを機能ごとのフォルダに移しても同じ機能として数える。移した後に当たらなくなったら、名前を変えずに語を足す。
  テストはファイル名で分ける（画面ごとの UI テストなど、名前が機能を表さないものは「未分類」）
- **再計測**: 基準を数え直すときは、別の作業ツリーに基準のコミットを取り出し、今のスクリプトでその場所を数える
  （`git worktree add /tmp/p3-base f1eddda && node scripts/measure-code.mjs --root /tmp/p3-base`）。スクリプトの定義を変えたら基準も数え直して並べる

### 基準（f1eddda）

製品のコード 42,450 行（242 ファイル、コメント 5,269 行）。テスト 27,421 行（173 ファイル）。

| パッケージ | 行 | ファイル |
| --- | --- | --- |
| tasks | 40,110 | 222 |
| 入口（p3） | 2,184 | 16 |
| kit | 156 | 4 |

| パッケージと層 | 行 | ファイル |
| --- | --- | --- |
| tasks/web | 14,552 | 94 |
| tasks/core | 14,359 | 72 |
| tasks/shared | 5,835 | 26 |
| tasks/cli | 3,930 | 21 |
| tasks/server | 1,434 | 9 |
| p3/cli | 1,158 | 5 |
| p3/web | 533 | 7 |
| p3/core | 265 | 1 |
| p3/server | 203 | 2 |
| kit | 156 | 4 |
| p3/bin | 25 | 1 |

| 機能 | 行 | ファイル |
| --- | --- | --- |
| Preflight（評価・案・分割・画面資料） | 6,178 | 32 |
| 要望（親子・進捗・検索・メモ・添付） | 5,238 | 37 |
| リリースノート | 2,468 | 14 |
| タスク（状態・停止・作業先・アーカイブ） | 2,386 | 14 |
| AI 接続・実行環境（Codex・ChatGPT・Docker） | 2,327 | 16 |
| タスクの AI レビュー | 2,302 | 10 |
| 設定・プロジェクト・個人設定 | 2,150 | 19 |
| 画面の共通（部品・処理） | 2,036 | 22 |
| マイルストーンレビュー | 1,989 | 9 |
| 品質基準・改善要望 | 1,718 | 9 |
| 保存（ファイル・コレクション・監視） | 1,507 | 6 |
| 要求の根拠・確認・回答 | 1,456 | 4 |
| 振り返り | 1,390 | 4 |
| 受け入れ基準・証拠 | 1,291 | 2 |
| 完了の記録・手戻り・見直し候補・前提 | 1,289 | 7 |
| 開発の指標 | 1,227 | 6 |
| 入口（起動・振り分け・AI 向けの入口） | 1,183 | 6 |
| 型と判定の共通（shared） | 1,041 | 3 |
| API の組み立て | 1,021 | 3 |
| 入口（serve・画面の外枠） | 1,001 | 10 |
| CLI の共通（引数・出力） | 862 | 4 |
| AI の実行の共通（run） | 234 | 1 |
| kit | 156 | 4 |

| テストの区分 | 行 | ファイル |
| --- | --- | --- |
| ユニットテスト | 21,464 | 127 |
| UI テスト（test/ui） | 5,357 | 36 |
| テストの資材（test/fixtures） | 600 | 10 |

## 重複の棚卸し（基準の時点）

パスは `packages/tasks/src/` からの相対（入口・kit はパッケージから書く）。「差」は機能ごとに違う今の契約で、まとめるときも変えない
（揃えると仕様の変更になる。直すかどうかは別の判断）。

### 1. 壊れた値を消さずに残す（要望・タスク・案の frontmatter の項目）

| 項目のまとまり | 読む関数と項目 | 問題の置き場所 |
| --- | --- | --- |
| 受け入れ基準・証拠・基準の根拠・採番 | `shared/acceptance.ts` の `readAcceptance`・`ACCEPTANCE_KEYS` | `acceptanceProblems` |
| 停止と履歴 | `shared/taskBlock.ts`・`BLOCK_KEYS` | `blockProblems` |
| 完了の記録 | `shared/completionRecord.ts` の `readCompletion`・`COMPLETION_KEYS` | `completionProblems` |
| 手戻りの履歴 | `shared/reworkHistory.ts` の `readRework`・`REWORK_KEYS` | `reworkProblems` |
| 要望の要求の根拠・回答 | `shared/requirementSource.ts` の `readRequirement`・`REQUIREMENT_KEYS` | `requirementProblems` |
| 前提の変更 | `shared/reviewCandidate.ts` の `readPremises`・`PREMISE_KEYS` | `premiseProblems` |
| 案の基準・根拠・採番 | `core/store/preflightStore.ts` の `draftCriteriaOf`、`core/preflight/service.ts` の `updateDraft`（`rawDraftField`・`saveDraftRaw`） | 案の `acceptanceProblems` |

- **既に共用しているもの**: 書き戻しの仕組みは `core/store/collection.ts` の `keepRaw`（汎用）。要望とタスクは `core/store/normalize.ts` の
  `requestKeepRaw`・`taskKeepRaw`（問題がある項目のまとまりを列挙）と `TASK_DERIVED`（書かない項目）で、まとまりごとに手で並べている
- **まとめる候補**: 「項目・読む関数・問題の名前」を 1 つの定義の表にし、`keepRaw` と書かない項目をそこから作る。案の元の値の書き戻しも
  同じ仕組みにする
- **差（残す）**: 壊れたときにどの操作を断るか（基準・根拠・停止は操作を断る、完了の記録と手戻りは状態の変更は通して新しい記録だけを足さず
  `completionSkipped`・`reworkSkipped` で知らせる）と、その文言
- **まとめたもの（T002）**: `core/store/fieldGroups.ts` に要望・タスクのまとまり（`TASK_FIELD_GROUPS`・`REQUEST_FIELD_GROUPS`。項目・問題の名前・読む関数）を
  1 か所で定義し、読む（`readFieldGroups`）・書き戻す（`keepRawOf`）・書かない項目（`problemKeysOf`）・CLI と API の入力から外す項目（`withoutManaged`）を
  そこから作るようにした。`normalize.ts` の手で並べた `taskKeepRaw`・`requestKeepRaw`・`TASK_DERIVED`・`REQUEST_DERIVED` と、`requestOps.ts` の
  3 か所の項目の列挙（作る・タスクの更新・要望の更新）を置き換えた。書き戻しと競合の仕組みは今までどおり `collection.ts` の `keepRaw` と版
- **まとめなかったもの**: 案の元の値の書き戻し（`preflightStore.ts`・`updateDraft`）は、案のファイルが `MarkdownCollection` でなく run の中の
  ファイルで、書き戻す項目が根拠と採番の 2 つだけなので、今の形のまま（JSON の記録をまとめる T003 で、記録のファイルと一緒に見直す）。
  各まとまりの検査・欠けたときの意味・断る操作と文言は各機能のまま（`test/fieldGroups.test.ts` が全部のまとまりを一緒に確かめる）

### 2. JSON・Markdown の記録のファイル（読み方・検査・ロック・置き換え・版）

| ファイル | 置き場所 | ロック | 壊れたとき（今） |
| --- | --- | --- | --- |
| `metrics/manual.json` | `core/metrics/manual.ts` | `metrics/.manual.lock` | 読むときは問題として知らせ、書くのは断る（`metrics_unreadable`） |
| `requests/<ID>/retrospective.json` | `core/retrospective.ts` | あり | JSON として読めなければ断る（`retro_unreadable`）。無ければ空 |
| `quality-improvements.json` | `core/qualityImprovement.ts` | `.quality-improvements.lock` | 読めない（`readFile` の失敗）なら空とみなす。JSON として読めなければ診断・登録とも断る（`invalid`） |
| `release-notes/<ID>.md` | `core/releaseNotes/store.ts` | あり | 読めない・形が違えば `invalid` |
| レビューの run（`run.json`・`input.json`・`review.json`） | `core/reviewRuns.ts` の `readJson`・`writeJson`（タスク・マイルストーンの各 `store.ts`） | run ごと | `broken` |
| Preflight の run・案・子の案 | `core/store/preflightStore.ts` | 案ごと（`drafts/.<key>.lock`） | 項目ごとに問題として知らせる |
| 添付の一覧（`attachments.json`） | `core/store/attachments.ts` | なし | 読めない添付を `invalid` に分ける |
| 画面資料の描画の記録 | `core/preflight/uiRender.ts` | なし | — |
| 個人設定（`config.yaml`） | `core/userConfig.ts` | あり | `UserConfigError` |

- **既に共用しているもの**: kit の `fsutil.ts`（`withFileLock`・`writeFileAtomic`）だけ。レビューの run は `reviewRuns.ts` の `readJson`・`writeJson` を共用
- **まとめる候補**: 「版つきの JSON の記録」の読み書き（無ければ空・壊れていれば問題・ロックの中で読み直す・版を照らす・置き換えで書く）を
  tasks の共通の部品にする（2 つ目の製品が使うまで kit には置かない）
- **差（残す）**: 上の表の「壊れたとき」。まとめた後もこの差を各テストで確かめる
- **まとめたもの（T003）**: `core/store/jsonRecord.ts` に `readJsonRecord`（読むときの扱い — 無い・読めない・空・JSON として読めない・形 — を記録ごとに渡す）と
  `writeJsonRecord`（整形した JSON を置き換えで書く）を置き、指標の人の記録（`metrics/manual.ts`）・振り返り（`retrospective.ts`）・品質の改善要望の登録
  （`qualityImprovement.ts`）・レビューの run（`reviewRuns.ts` の `readJson`・`writeJson`）の読み書きと、Preflight の run・Mock の評価・画面資料の記録・
  固定した添付の一覧の書き込みをこれに替えた。振り返りの確定とリスクの確認は、要望のロック・要望があることの確認（アーカイブの後に書き戻さない）・
  版の照合・書き込みを `changeRetrospective` の 1 か所にした。ファイルの場所・形・ロックの粒度（記録ごとのロックか要望のロック）・各記録の版
  （ファイルの `version`、記録の `rev`、診断の hash）と、品質の改善要望の予約 → 作成 → 確定の順は変えていない
- **まとめなかったもの**: Markdown の記録（リリースノート・案・子の案）は frontmatter で別の形なので今のまま。ロックは kit の `withFileLock` を各記録が
  呼ぶ形のまま（ロックのファイルと、その中で何を確かめるかが記録ごとに違う）。品質の改善要望の「読めない（readFile の失敗）なら空とみなす」は今の扱いとして
  残した（直すなら別の判断）

### 3. AI の実行（run）

| 実行 | 置き場所 | 履歴 | 回復・取り消し |
| --- | --- | --- | --- |
| Preflight | `core/preflight/service.ts`・`owner.ts`・`core/store/preflightStore.ts` | 要望の `preflight/<run>/` に永続 | 独自（所有者の識別子・落ちたプロセスの run の回復・取り消し） |
| タスクの AI レビュー | `core/taskReview/`（`service.ts`・`store.ts`） | `task-reviews/` に永続 | `core/reviewRuns.ts` の `RunControl`（共用） |
| マイルストーンレビュー | `core/milestoneReview/`（`service.ts`・`store.ts`） | `milestone-reviews/` に永続 | `RunControl`（共用） |
| リリースノートの要約 | `core/releaseNotes/generate.ts` | メモリ（保存は人が明示） | 取り消しのみ。材料の変化は警告 |

- **既に共用しているもの**: `RunControl`（保存・終わり・回復・取り消し・遅れた結果の拒否）はレビューの 2 つだけ
- **まとめる候補**: エンジンの選び方（codex / mock、`preflight.engine` の読み直し）、実行中の排他、取り消しの受け付け、進み具合の知らせ
- **差（残す）**: 履歴と回復の有無（Preflight の独自の永続の run、要約はメモリ）。揃えると仕様の変更になる

| 実行 | 開始と材料の固定 | 進み具合 | 取り消し | 回復 | 終わり |
| --- | --- | --- | --- | --- | --- |
| Preflight | 評価対象（要望・回答・根拠・添付）を run に固定。手元のエージェントは prepare → complete の明示 | ログと進み具合（pulse） | 自分のプロセスは止め、ほかは要求のファイル | 所有者の識別子で落ちた run を失敗に | 評価・案・子の案を run に書く |
| タスクの AI レビュー | 材料（基準・証拠・比較対象のファイル）を run に固定。agent の担当なら engine の明示 | ログを run.json に書き足す | `RunControl`（自分は止め、ほかは要求） | `RunControl`（死んだ所有者だけ crashed） | 遅れた結果は取り込まない |
| マイルストーンレビュー | 材料（目的・要望・タスク・コード・品質基準）を run に固定 | 同上 | 同上 | 同上 | 同上。完了の後に材料が変わっていれば `inputChanged` |
| リリースノートの要約 | 材料をメモリに持つ | メモリのログ | このプロセスだけ | なし（メモリ） | 結果は保存しない（人が保存する）。材料の変化は警告 |

- **まとめたもの（T004）**: `core/reviewRuns.ts` に `ReviewRunner` を置き、タスクの AI レビューとマイルストーンレビューの「このプロセスの実行の一覧・
  二重の開始の確かめ（`begin`）・実行（`launch`。ログ・時間切れ・取り消し・ほかのプロセスの取消の要求の監視・失敗の分類・終わる前の確かめ・遅れた
  結果の拒否）・回復・記録の取得（所有者の状態を添える）・取り消し・待つ・終わるまで待つ」を 1 か所にした（それぞれの service.ts は材料・依頼文・
  結果の読み方・断る理由と文言だけを持つ）。頼む先の選び方（`pickReviewer`。明示 → `preflight.engine` → codex）と失敗の分類（`classifyAiFailure`。
  接続できない・使用量の上限・結果を読めない・ほか）は、リリースノートの要約も含めた 3 つで共用した
- **まとめなかったもの**: Preflight の実行（`preflight/service.ts`・`owner.ts`）は、手元のエージェントの待機と明示の確認・評価対象の固定と採用の照合・
  子の案・画面資料の描画を持ち、run の形も違うので、今の形のまま。リリースノートの要約の実行は、履歴を持たないメモリの実行で、取り消しはこのプロセスだけ
  なので `ReviewRunner` は使わない（頼む先の選び方と失敗の分類だけを共用）

### 4. CLI と API の入口（エラーの対応・検査・出力）

| 入口 | 置き場所 | エラーの分岐 |
| --- | --- | --- |
| CLI の終了コード | `cli/tasksCli.ts` の `reportError` | 16 |
| 要望・タスク・Preflight・設定の API | `server/api/routes.ts` の `onError` | 25 |
| タスクの AI レビューの API | `server/api/taskReviewRoutes.ts` の `onError` | 5 |
| マイルストーンレビューの API | `server/api/milestoneReviewRoutes.ts` の `onError` | 4 |
| リリースノートの API | `server/api/releaseNoteRoutes.ts` の `onError` | 4 |

- 同じエラーの分類（規則に合わない・見つからない・競合・読めない）を、CLI は終了コード（1・2・3）、API は状態（400・404・409・422・500・503）で
  別々に書いている。入力の検査も CLI（`cli/args.ts` と各コマンド）と API（zod）で別
- **まとめる候補**: エラーが自分の分類（と code）を持ち、CLI・API はそれを写すだけにする
- **差（残す）**: API が応答に添えるもの（競合の今の値 `current`・`plan`・`existing`・`inputMatch`）、`ConflictError` の今の値の取り方、標準エラーの前置き
  （`競合: `・`設定: `・`見つかりません: `・`エラー: ` の有無）
- **まとめたもの（T006）**: `core/errorOutcome.ts` の 1 つの表（`errorOutcome`）に、エラーごとの CLI の終了コードと標準エラーの文、API の状態と
  code・添える項目を並べ、CLI の `reportError`（`cliExit`）と API の 4 つのアプリの `onError`（`apiError`）はそれを写すだけにした。CLI と API で値が
  違うもの（例: 親子の規則は CLI 1・API 409、振り返りの記録が読めないのは CLI 1・API 409、リリースノートが読めないのは CLI 1・API 422）は、表の同じ行に
  両方を書いて違いが見えるようにした
- **各入口に残したもの**: 入力の解釈（CLI の引数と `cli/args.ts`、API の zod と `invalid input`）、テキストの表示、版の競合で今の値を読む処理（要望・タスクは
  `routes.ts`、リリースノートは `releaseNoteRoutes.ts`。その場で読む必要がある）、タスクの AI レビューの API だけが見つからないにも code を付けること、
  CLI のリリースノートの一括完了の断り（`releaseNotesCommands.ts` が計画を出す）、画面の失敗の表示と読み直し（`web/lib/api.ts` の `failureOf`）
- **振る舞いの差**: 表に載ったエラーは、どの API のアプリで起きても同じ状態になる（以前はそのアプリが扱わないエラーは 400 だった。各アプリの範囲の
  エラーの応答は同じ）

### 5. 完了の時点と今の記録の参照

| 読み手 | 置き場所 | 読むもの |
| --- | --- | --- |
| 見直し候補 | `shared/reviewCandidate.ts`（`diagnoseTask`・`diagnoseRequest`）・`core/reviewCandidates.ts` | 最新の完了の記録と今の条件 |
| 開発の指標 | `core/metrics/definitions.ts` | 最初の対応済・完了済の記録 |
| 作る | `core/requestOps.ts`（`taskCompletionPatch` など） | 完了・済みの契機 |
| 表示 | `cli/showView.ts`・`cli/output.ts`・`web/components/CompletionReview.tsx`・`TaskDrawer.tsx`・`request/RequestReviewNotice.tsx` | 記録の一覧・最新 |

- **まとめる候補**: 「最新の記録」「契機ごとの最初の記録」などの取り出しを `shared/completionRecord.ts` の関数にし、読み手はそれを使う
- **差（残す）**: 見直し候補の判断と各レビューの材料はそれぞれのまま（入力が同じと確かめたところだけ共用する）
- **まとめたもの（T005）**: 同じ値・同じ時点を読む取り出しだけを共用にした。契機ごとの最初の完了の記録（`shared/completionRecord.ts` の `firstCompletion`。
  指標の到達の時点と、対応済を経ずに完了済にしたかの判定）、1 つの更新（rev）に 1 件として数える手戻り（`shared/reworkHistory.ts` の `reworkPerRev`。
  指標）、振り返りの根拠の手戻りの 1 件の引き方（`retrospective.ts` の `reworkEntry`。保存するときと照らすときで同じ）、ディスクから読み直した別の
  `Workspace`（`Workspace.snapshot`。タスクの AI レビュー・マイルストーンレビュー・リリースノートの材料と、要望の一括完了の判定）。最新の記録の取り出しは
  基準の時点で既に `latestCompletion` を共用していた
- **まとめなかったもの**:

  | 経路 | 取得元と時点 | 残した理由 |
  | --- | --- | --- |
  | 見直し候補 | 最新の完了の記録（その時点の写し）と、今の品質基準・要望・基準の根拠・前提 | 候補の判断の規則そのもの |
  | タスクの AI レビューの材料 | 読み直した要望・タスクと、参照先の git（比較対象のコミット・差分。`core.quotepath=off`・30 秒・64 MB） | 材料の固定と hash は run に残す契約 |
  | マイルストーンレビューの材料 | 読み直したマイルストーンの要望・タスクと、参照先の HEAD・未コミットの変更の識別子（10 秒・4 MB、差分は 30 秒・256 MB） | 同上。git の呼び方（時間・大きさ・標準入力）が違う |
  | リリースノートの材料 | 読み直したマイルストーンの要望・タスク・変更の記録 | 収録の条件がレビューと別 |
  | 指標 | 今の要望・タスクの完了の記録と手戻りの履歴、レビューの最新の完了した run | 欠損と未到達の扱いが指標の定義 |
  | 振り返り | 採用した run のリスクと、保存した根拠（レビューの結果の版・手戻りの ID） | 根拠の版を照らす規則 |

  git の呼び出しはタスクの AI レビュー（`taskReview/material.ts`）とマイルストーンレビュー（`milestoneReview/code.ts`・`review.ts`）にそれぞれあるが、
  時間切れ・出力の上限・パスの書き方・標準入力が違い、揃えると材料（と hash）が変わりうるので、まとめていない

## モジュール構成

tasks の中は、移す前と同じ技術の層（`shared` / `core` / `cli` / `server` / `web`）の共通の土台と、機能のまとまり
（`features/<機能>/{shared,core,cli,server,web}`）に分ける。1 つの機能のコードは、その機能のフォルダの中で層に分かれる。

- **読んでよいもの**: 機能の `shared/`（型と判定の純粋な契約）はどこからでも読める。機能の中身（`core`・`cli`・`server`・`web`）を読めるのは、
  その機能自身と、組み立ての場所（`test/featureBoundary.test.ts` の `ASSEMBLY`。理由と一緒に列挙）と、画面のルートの宣言（`web/routes/`）だけ。
  機能どうしの読み込みは循環しない（同じテスト）。層の向き（shared ← core ← server / cli、web → shared）は機能の中でも同じ（`test/layers.test.ts`）
- **組み立ての場所（入口と製品の接点）**: CLI はコマンドの振り分け（`cli/tasksCli.ts`）が機能の `cli/` を呼ぶ。API は `server/api/routes.ts` が機能の
  `server/` のアプリ（Hono）を `app.route` でつなぐ。画面は `web/routes/` のファイルがルートの宣言（URL と検索の値）だけを持ち、ページの中身は機能の
  `web/` から読む（物理のルートのフォルダは入口の `__root.tsx` の下にそのまま付く）。プロジェクトを開くとき（`core/context.ts`）に各機能の
  サービスを作り、保存の入口（`core/store/workspace.ts`）が各機能の記録のストアを持つ
- **配布**: `scripts/build-cli.mjs` は tasks の `features/` も Node の JavaScript に入れる（`web/` を除く）。画面は入口で vite がビルドし、Tailwind は
  tasks の `src` 全体のクラスを拾う

| 段階 | 移した機能 |
| --- | --- |
| T007 | 開発の指標（`features/metrics`: `shared/metrics.ts`・`core/{definitions,index,manual}.ts`・`cli/metricsCommands.ts`・`server/metricsRoutes.ts`（API から切り出した）・`web/MetricsPage.tsx`（ルートの宣言は `web/routes/metrics.tsx`）） |

## 契約と既存のテストの対応

まとめるときに変えない契約と、それを確かめるテスト。基準の時点で足りなかったものは、この要望で足した（下の「足したもの」）。各段階は、
変えた範囲のテストと `pnpm -s check` を通し、境界・ルート一覧・配布に触れた段階は `test/packageBoundary.test.ts`・`test/layers.test.ts`・
`test/pack.test.ts`（必要なら `scripts/verify-pack.mjs`）も通す。

| 契約 | 確かめるテスト |
| --- | --- |
| CLI のコマンド・オプション・出力・読む／書くの判定 | `test/cli*.test.ts`（9 ファイル。特に `cliResolve.test.ts`）・`test/recordSkipJson.test.ts`・各機能の CLI のテスト |
| CLI の終了コードと標準エラー（エラーの種類ごと） | `test/errorContract.test.ts`（足したもの） |
| API の成功の応答 | `test/api.test.ts`・`test/allProjects.test.ts`・各機能の API のテスト（`completionRecord`・`requirementSource`・`workTarget` など） |
| API の失敗の状態と code（エラーの種類ごと） | `test/errorContract.test.ts`（足したもの）・各機能の API のテスト |
| 画面の URL と主な操作 | `test/ui/*.ui.test.ts`（31 ファイル。流れは `flow.ui.test.ts`） |
| 旧データ・壊れた値・知らない項目・ロックと版 | `test/store.test.ts`・`archivedTasks`・`completionRecord`・`reworkHistory`・`sourceSeq`・`taskBlock`・`requirementSource`・`metricsManual`・`retrospective`・`qualityImprovement`・`milestoneReviewStore` |
| パッケージの境界・層・配布物 | `test/packageBoundary.test.ts`・`test/layers.test.ts`・`test/pack.test.ts`・`test/package.test.ts` |

**足したもの**（基準の時点で確かめていなかった契約）:

- `test/errorContract.test.ts`: エラーの種類ごとの CLI の終了コードと標準エラー（44 件）と、API の状態と code（routes・タスクの AI レビュー・
  マイルストーンレビュー・リリースノートのアプリ）
- `test/qualityImprovement.test.ts`: `quality-improvements.json` が JSON として読めないときの今の扱い（診断の時点で断り、ファイルを変えない）
