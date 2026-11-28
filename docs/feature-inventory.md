# 機能の棚卸し（判断表）

今の p3 の機能を一覧にし、それぞれを残すか（維持・統合・簡素化・分離・廃止・保留）と、複数パッケージの構成（B 案）にしたときにどこへ置くか（入口・kit・tasks・未定）の候補をまとめる。
将来、p3 を複数の製品（今の機能の p3-tasks、観測の基盤の p3-observer など）を選んで組み合わせる形にすることを背景にした評価で、
リポジトリを複数パッケージに移す後続の要望 261119-9d1zk は、この表を置き場所の根拠に使う。

- **基準のコミット**: `a881b68`（main。0.13.0 のリリースの後、261119-3d256 のマージまで）。表の根拠のパスはこの時点のもの
- **この文書で決めないこと**: 機能の削除・統合・作り直し、パッケージの分割と公開の方式、p3-observer の責務と実装。表の「統合」「簡素化」「分離」は
  将来の候補で、どれも別の要望で利用実態と影響を確かめてから行う。変えないという判断も含む
- 判断は、コードと文書を読んで行った（静的な調査）。実際の利用の頻度・外部のスクリプトの依存は確かめていない（[追加の調査が要る事項](#追加の調査が要る事項)）

## 読み方

**判断**

| 判断 | 意味 |
| --- | --- |
| 維持 | 今の責務のまま残す |
| 統合 | 重なっている部分を1つにまとめる候補（まとめる範囲を表に書く） |
| 簡素化 | 残すが、入口・手順・持ち物を減らす候補 |
| 分離 | 1つの機能の中に、入口・共通（kit）に属する部分と tasks に属する部分が混ざっている。B 案で分けて置く候補 |
| 廃止 | なくす候補（今回は該当なし） |
| 保留 | 今は判断しない。判断する条件を書く |

**所属の候補**（B 案。依存の向きは 入口 → 製品（tasks・将来の observer） → kit の一方向）

| 所属 | 意味 |
| --- | --- |
| 入口 | 配布（npm の `@infodb/p3`・Docker）・起動・CLI の振り分け・serve・画面の外枠。入っている製品をコマンドと画面に組み込む |
| kit | 2 つ以上の製品が使う最小限の共通処理（保存の土台・個人設定の読み書きなど）。今 1 つの製品しか使わないものは入れない |
| tasks | 今の p3 の機能（要望から人の確認までの記録） |
| 未定 | 今は決めない。B 案での暫定の置き場所と、決め直す条件を書く |

**判断の優先順**: 要望から人の判断までの根拠を追えること（p3 の目的）→ 段階を踏んで導入できること → 既存の契約（データ・CLI・API・画面）への影響 → 製品の間の結合の少なさ。

## 判断表

ID（F01…）は後続の要望から参照するための番号。

| ID | 今の機能 | 判断 | 所属の候補 | 根拠と、変えるときに守る契約 |
| --- | --- | --- | --- | --- |
| F01 | npm の bin・Docker の起動、CLI の最上位の振り分けと help、画面の静的配信 | 維持 | 入口 | `package.json`・`bin/p3.mjs`・`src/cli/main.ts`・`src/cli/help.ts`・`src/server/server.ts`・`Dockerfile`。コマンド名・引数・終了コード・標準出力と標準エラー・ビルドした成果物（`lib/`・`dist/web`）の見つけ方を変えない |
| F02 | 配布物の確認（`verify-pack`・`verify-docker`・`verify-host-paths`・`check-browser`）と公開の手順 | 維持 | 入口 | `scripts/verify-*.mjs`・`scripts/check-browser.ts`・`docs/publishing.md`。B 案でも利用者の入れ方（`pnpx @infodb/p3`・`tamuto/p3`）が同じであることをここで確かめる |
| F03 | AI 向けの入口（スキル・AGENTS.md の節）、`p3 guide`、入口の版の診断（`agents`） | 分離 | 入口 | `skills/p3/SKILL.md`・`src/cli/{project,guide,agentsStatus}.ts`。入口の置き方・更新・診断は入口、`guide.md` の要望の運用の手順は tasks の責務。今の入口から同じ guide に辿り着けることを守る |
| F04 | 初期化・参加・プロジェクトと参照先の登録、今いる場所からのプロジェクトの決定、読むだけの操作の判定 | 分離 | 入口 | `src/cli/{main,project,readOnly}.ts`・`src/core/store/{locate,projectFile}.ts`・`src/core/repoAdmin.ts`。登録・選択は入口。`init` の project.yaml の中身・作業先の規則・コマンドごとの読む／書くの分類は tasks。登録が1つだけで決まったときの書き込みの抑止（`readsOnly`）を守る |
| F05 | 個人設定の読み書き（`user-config`）、マシンごとの設定、変更者の識別 | 分離 | kit | `src/core/{userConfig,machineSettings,machineSettingsEdit}.ts`・`src/cli/userConfig.ts`。ファイルの入出力と出どころ（環境変数／個人設定／既定）の決め方だけを kit の候補にする。tasks 固有の項目・Codex の設定・パスの対応は持ち込まない |
| F06 | 置き換え書き込み・ファイルのロック・frontmatter | 分離 | kit | `src/core/store/{fsutil,frontmatter}.ts`。既に複数の用途（要望・タスク・run・指標・設定）が使う最小単位。要望 ID の採番・知らない項目の保存の規則・アーカイブ・読み込みの正規化（`normalize.ts`）は tasks に残す |
| F07 | serve の待ち受け・プロジェクトの切り替え（`--all-projects` を含む）、ナビゲーション、テーマ、汎用の表示部品 | 分離 | 入口 | `src/server/{server.ts,api/projectsRoutes.ts,api/local.ts}`・`src/core/{projectRegistry,userTheme}.ts`・`src/web/{Boot,App,router}.tsx`・`src/web/routes/__root.tsx`・`src/web/components/{ProjectSwitcher,ThemePanel,ui}.tsx`。外枠だけを入口にし、製品のページと状態は製品側。1 つ／複数プロジェクトの URL、未保存の入力の扱い、テーマの個人設定、待ち受けの既定値（`0.0.0.0`）と個別の API のローカル制限を引き継ぐ。共通部品を kit に移すのは 2 つ目の製品の具体的な利用が出てから（その後 shared に移した。今の置き場所は [docs/architecture.md](architecture.md) の F07 の行） |
| F08 | データのフォルダの変更の監視・画面への変更通知（SSE）・読み直し | 分離 | 入口 | `src/core/store/dataWatcher.ts`・`src/server/api/routes.ts` の `/events`・`/reload`・`src/web/lib/appData.tsx`。監視と通知の仕組みは入口（全製品が使う）、何を読み直すか（要望・タスクのコレクション）は tasks。監視の失敗で serve を落とさない守りを引き継ぐ |
| F09 | AI 向けの API の説明（`/api/ai/manifest`） | 分離 | 入口 | `src/server/api/manifest.ts`。説明の集め方は入口、各 API の説明の中身は製品が持つ。今の URL と形を守る |
| F10 | 要望の登録と本文の編集、タグ・検索と ID の解決（`find`・`resolve`）・期限、親子・子の順・進捗の表示 | 維持 | tasks | `src/core/{requestOps,hierarchy,ops,requestStatus}.ts`・`src/cli/requestCommands.ts`・`src/web/routes/index.tsx`・`src/web/routes/requests/`。親子の完了の判定・集計・表示の順・既存の ID を守る |
| F11 | 確認事項への回答・メモ（要求の出典と確認・前提の変化は廃止） | 簡素化（済み） | tasks | `src/features/requirements/shared/clarify.ts`・`src/core/requestOps.ts`・`src/core/store/noteStore.ts`。要望 261128-gbwmf で、要求の出典と確認・前提の変化を無くし、回答を回答・回答した役割・日だけにした（状態は回答済み・未回答）。回答は評価対象の固定と採用の判定に効く |
| F12 | 添付の保存と参照、xlsx から Preflight の資料を作る経路 | 維持 | tasks | `src/core/store/attachments.ts`・`src/core/preflight/{xlsx,input}.ts`。元の添付と run に固定した資料の関係を守る |
| F13 | Preflight の評価・評価対象の固定・履歴・再評価・取り消し・取り込み（Codex と手元のエージェント） | 維持 | tasks | `src/core/preflight/service.ts`・`src/cli/preflightCommands.ts`。Codex と手元のエージェントを選べること、古い run と評価対象の照合、Mock での確かめる経路が要る |
| F14 | タスク案の編集・タスク化・子の要望への分割と採用 | 維持 | tasks | `src/core/preflight/{service,split,carryover}.ts`。案は人が選ぶ。タスクの直接作成の経路と、採用で引き継ぐ ID・基準・出典・依存を守る |
| F15 | 画面資料の原稿・描画・表示と `render` コマンド | 維持 | tasks | `src/core/preflight/{uiMaterials,uiRender,wireframe,render}.ts`・`src/cli/render.ts`。描画の環境は任意。原稿と描いた画像の対応、描けないときの表示、既存のコマンドを守る |
| F16 | タスクの直接作成・作業先とブランチ・状態・停止・依存・アーカイブ | 維持 | tasks | `src/core/{workTargets,requestOps}.ts`・`src/core/store/archivedTasks.ts`・`src/cli/taskCommands.ts`。要望を単位にした作業、古い ID と履歴を守る（タスク単位の「済み」は要望 261128-gbwmf で無くした） |
| F17 | 受け入れ基準・証拠と根拠の種類・成果物・変更の記録 | 簡素化（済み） | tasks | `src/features/requirements/shared/acceptance.ts`・`src/core/requestOps.ts`。要望 261128-gbwmf で、人の「済み」・完了の記録と参照先のコミットの取得を無くした（人の最終確認は要望の完了済）。古い形の読み込み、申告と未確認の区別を守る |
| F18 | 品質基準と、タスクを作るときの基準への取り込み | 簡素化（済み） | tasks | `src/features/quality/`。要望 261128-gbwmf で、基準を ID・文・対象の参照先・確かめ方だけにし、テンプレート・版・除外・取り込みの出典と差分を無くした。未設定でも使えること、作業先に応じた当てはめを守る |
| F19 | マイルストーンレビューと run の管理（タスクの AI レビューは廃止） | 維持 | tasks | `src/features/milestoneReview/`・`src/core/reviewRuns.ts`。タスクの AI レビューは要望 261128-gbwmf で無くした |
| F20 | 見直し候補・品質の改善要望 | 廃止（済み） | — | 要望 261128-gbwmf で無くした（完了の記録・前提の変化とともに） |
| F21 | マイルストーンの目的・予定機能・並び・リリース済み・要望の一括完了 | 維持 | tasks | `src/shared/{milestoneGoals,milestoneOrder}.ts`・`src/core/releaseNotes/completeRequests.ts`。項目の削除と一括完了は、親子の判定と参照の保護（記録のあるマイルストーンは消さない）に効く |
| F22 | リリースノートの手での編集・保存・出力 | 維持 | tasks | `src/core/releaseNotes/service.ts`・`src/cli/releaseNotesCommands.ts`・`src/web/routes/release-notes.tsx`。マイルストーンと変更の記録に依存する。保存と出力の契約を守る |
| F23 | リリースノートの AI 要約 | 簡素化 | tasks | `src/core/releaseNotes/generate.ts`。任意の生成として扱い、手で書いて保存する導線を先にする候補。生成と保存は既に分かれている。削除や CLI・API の変更の判断には利用実態が要る |
| F24 | 手戻りの履歴（Preflight のリスクの振り返りは廃止） | 簡素化（済み） | tasks | `src/features/records/shared/reworkHistory.ts`。要望 261128-gbwmf で、振り返りと完了の記録を無くし、手戻りの履歴は完了から戻したときだけ足す |
| F25 | 開発の指標（要望の到達時間・完了時の受け入れ基準・手戻り）と、費用・リリース後の不具合などの値 | 分離（済み） | observer・tasks | 要望 261128-c7z79 で観測へ移した。指標は観測のシステムの項目で、tasks が要望・タスクの操作のその場で値を書く（`core/systemObservations.ts`）。費用などは利用者が決める観測の項目キー。以前の見るたびの集計・`p3 metrics`・人の記録（`metrics/manual.json`）は無くした |
| F26 | Codex の準備・起動・診断、ChatGPT の接続、Docker とホストのパス、ログの秘密の除去 | 保留 | 未定 | `src/cli/{codex,chatgpt}.ts`・`src/core/{chatgpt,redact}.ts`・`src/core/preflight/{codexEngine,docker,hostPaths}.ts`・`src/server/api/chatgptRoutes.ts`。**B 案では暫定で tasks**。2 つの製品に共通する認証・実行環境と、設定・秘密の情報の境界が具体化したら決め直す。接続の保存先と各機能が渡す入力の範囲を守る |
| F27 | デモデータと使い方の動画 | 維持 | tasks | `scripts/{demo,demoData}.ts`・`scripts/video/`。tasks の画面と CLI を使う開発用の道具（配布物には入らない）。B 案では tasks のパッケージに付ける |
| F28 | 観測（項目キーと値） | 維持 | observer | `packages/observer`。項目キーに値を登録して貯めて見せるだけで、値を何を実行して得たかは扱わず、判定もしない（要望 261128-c7z79。[設計: p3-observer](architecture.md#p3-observer)）。以前の手順・準備・実行の結果などは外した |

### まとめ

- **廃止**: F20（見直し候補・品質の改善要望）と、F11・F17・F19・F24 の一部（要求の出典と確認・前提・人の済み・完了の記録・タスクの AI レビュー・振り返り）を要望 261128-gbwmf で無くした
- **簡素化の候補**: F23（リリースノートの AI 要約）
- **分離（B 案で分けて置く）**: F03〜F09。入口と kit に切り出すのは起動・登録・外枠・保存の土台・個人設定・監視で、中身（要望の運用）は tasks に残る
- **保留**: F26（AI 接続・実行環境。暫定 tasks）。F25・F28 は要望 261128-c7z79 で観測（項目キーと値）に決めた
- 残りは **tasks に維持**。要望から人の確認（要望の完了済）までの記録は tasks の責務

## B 案（261119-9d1zk）への引き継ぎ

**依存の向き**

- 入口 → 製品（tasks） → kit の一方向。製品どうしは直接 import しない
- 入口は、今の `P3Context`（`src/core/context.ts`）が組み立てている製品固有のサービス（Preflight・レビュー・要約など）を kit に持ち込まず、製品の側で組み立てる
- 今の `src/shared` は「画面と Node の両方から読める」という層の規則で、tasks 固有の型（要望・タスク・基準・根拠など）を多く含む。B 案では
  tasks の共有の型と kit の処理を分けて扱い、`shared` をまるごと kit に移さない
- 依存の向きは `test/layers.test.ts` と同じ仕組みで、パッケージの間についても確かめる

**守る契約（移す前と後で照らす）**

- 外から使う入口と出力: CLI のコマンド・別名・`--json` の形・終了コード・標準エラーの知らせ、HTTP の URL と形、1 つ／複数プロジェクトの画面の
  URL と使い方、スキルと `p3 guide`、npm（`@infodb/p3`・`p3`・`pnpx @infodb/p3`）と Docker（`tamuto/p3`）
- データ: データのフォルダの場所と形（`project.yaml`・`requests/`・`metrics/`・`task-reviews/`・`milestone-reviews/`・`release-notes/` など）、
  古い run・古い記録、知らない frontmatter の項目の保存、ロックと版（`rev`）。データの移行は要らない形にする
- 開発: `pnpm -s check` が型検査から UI テストまで通ること

**回帰の確認に使う既存のテスト**

| 確かめること | テスト |
| --- | --- |
| 層・パッケージの依存の向き | `test/layers.test.ts` |
| 配布物の中身と文書のリンク | `test/package.test.ts`・`test/docs.test.ts`・`scripts/verify-pack.mjs`（`--docker`） |
| CLI の入口・プロジェクトの決まり方・読むだけの判定 | `test/cli*.test.ts`（特に `test/cliResolve.test.ts`） |
| 手元のエージェントの Preflight（Codex・Docker なし） | `test/localPreflight.test.ts` |
| 複数プロジェクトの serve | `test/allProjects.test.ts` |
| 画面の流れ | `test/ui/flow.ui.test.ts` ほか `test/ui/` |
| AI の入口と手順 | `test/agents.test.ts`・`test/guide.test.ts` |

## 文書と今のコードの違い

後続の要望で文書かコードを直す。この文書では直さない。

- 要望の概要（Preflight に渡すプロジェクトの説明）では、ブラウザの画面を「ビューア」と呼んでいる。今の画面は要望の編集・案の採用・タスクの更新もできる
- `docs/architecture.md` の「開発の工程と P3 の受け持ち」の表は、確認事項への回答をメモ中心に書いている。今は ID の付いた回答を要望に保存し、
  評価対象の固定と採用の判定に反映する。同じ表に、リスクの振り返り・開発の指標・証拠の根拠の種類が無い
- 画面を開く例は `http://localhost:4310` だが、serve の待ち受けの既定は `0.0.0.0`。個別の API のローカル制限（`src/server/api/local.ts`）と serve 全体の
  制限を取り違えない
- 見送りにした要望 261119-vgxsq で互換を崩してよいとした回答は、その要望についてのもの。B 案は 261119-9d1zk の互換の条件（入口・データ・CLI・API・画面を変えない）に従う

## 追加の調査が要る事項

- 機能ごとの実際の利用の頻度と、外部のスクリプト・自動化が使っている CLI・API（簡素化・廃止の判断の前に要る。特に F23）
- AI 接続・実行環境を製品の間で共通にするか（F26）: 2 つ目の製品が要る認証・実行環境・秘密の情報の範囲
- B 案の配布の方式: kit・tasks を別のパッケージとして npm に出すか、`@infodb/p3` に同梱するか（261119-9d1zk の Preflight で比べる）

## 照らした範囲

表の漏れを、基準のコミットの次の一覧と照らした。

| 一覧 | 対応する行 |
| --- | --- |
| CLI のコマンド（`src/cli/main.ts` と各 `*Commands.ts` の振り分け） | `init`・`join`・`project`・`whoami` → F04、`user-config` → F05、`agents`・`guide`・`help` → F01・F03、`serve` → F07、`request`・`req`・`find`・`resolve`・`progress`・`ls`・`show` → F10、`source`・`clarify`・`answer`・`premise`・`revisit`・`notes`（メモは `preflight --note`）→ F11・F20、`attach` → F12、`preflight`・`drafts`・`accept` → F13・F14、`render` → F15、`new`・`add`・`set`・`move`・`block`・`unblock`・`archive`・`repo` → F04・F16、`criteria`・`evidence`・`check` → F17、`quality` → F18・F20、`review`・`reviews`・`review-show`・`review-cancel` → F19、`milestone` → F19・F21、`release-notes` → F21〜F23、`retro` → F24、`metrics` → F25、`codex`・`chatgpt` → F26、`config` → F04・F10 |
| HTTP API（`src/server/api/*.ts`） | `/mode`・`/projects`・`/project` → F04・F07、`/events`・`/reload` → F08、`/ai/manifest` → F09、`/requests`・`/tasks`・`/resolve`・`child-order` → F10・F16、`sources`・`answers`・`premises`・`notes`・`/revisit` → F11・F20、`attachments` → F12、`preflight`・`drafts`・`children`・`materialize`・`/engine` → F13〜F15、`quality`・`quality-diff`・`quality-import`・`quality/improvements` → F18・F20、`reviews`・`review-preview`・`milestone-reviews` → F19、`release-notes`・`release-generations`・`complete-requests` → F21〜F23、`retrospective` → F24、`/metrics` → F25、ChatGPT（`login`・`logout`・`paste`）→ F26 |
| 画面のルート（`src/web/routes/`） | `__root.tsx` → F07、`index.tsx`・`requests/` → F10〜F17・F19、`release-notes.tsx` → F21〜F23、`metrics.tsx` → F25、`settings.tsx` → F04・F05・F07・F18・F26 |
| データ（データのフォルダと個人設定） | `project.yaml` → F04、`requests/<ID>/`（`request.md`・`tasks/`・`notes/`・`attachments/`・`preflight/<run>/`・`retrospective.json`）→ F10〜F17・F24、`requests/.locks/`・`.archive/` → F06・F16、`task-reviews/`・`milestone-reviews/` → F19、`release-notes/` → F22・F23、`metrics/manual.json` → F25、`quality-improvements.json` → F20、個人設定 `~/.config/infodb-p3/config.yaml`・`chatgpt.json` → F05・F26 |
