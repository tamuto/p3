import { RELATION_TYPES } from "../../shared/types.ts";

/**
 * 自己記述。GET /api/ai/manifest
 * この REST API はローカルの画面のためのもので、AI エージェントには CLI を使わせる。
 */
export const AI_MANIFEST = {
  name: "p3",
  description:
    "1リポジトリ=1プロジェクトのファイルベースのタスク管理。作業の単位は要望で、要望ごとにフォルダを分ける" +
    "（.p3/requests/<要望ID>/request.md, tasks/T001.md, preflight/）。" +
    "AI エージェントは `p3` CLI（`p3 help`、`--json` 出力）を使うこと。要望の作業ツリーの中で実行すると、その要望が対象になる。",
  refs: {
    request: "<要望ID>（例: 261009-k7m3x）",
    task: "<要望ID>/T003。同じ要望の中なら T003",
  },
  relationTypes: RELATION_TYPES, // タスクの関係は depends_on だけ（Preflight のタスク化が張る。手で張る API は無い。以前の supersedes はファイルに残っても出さない）
  endpoints: [
    { method: "GET", path: "/api/mode", desc: "serve の形 {mode: single（project: 名前）| all-projects, products: この serve の製品（常に tasks・observer の両方）}" },
    { method: "GET", path: "/api/observer/status", desc: "p3-observer の起動状態 {product, version（共通の版）, state, dataDir, products}。どの serve でも使える" },
    { method: "GET", path: "/api/observer/definitions", desc: "観測の定義の一覧 {definitions, unreadable（読めないファイルと理由）}。プロジェクトを跨ぐ serve では /api/projects/<名前>/observer/definitions" },
    { method: "GET", path: "/api/observer/definitions/:id", desc: "観測の定義 {definition}" },
    { method: "POST", path: "/api/observer/definitions", desc: "観測の定義を作る（本文 {title, category, description, measures, procedures}。項目は docs/how-to-use.md「観測の定義を登録する」）。誤りは 400 {code: invalid, problems: [{path, message}]}" },
    { method: "PUT", path: "/api/observer/definitions/:id", desc: "観測の定義を直す（本文 {rev: 今の版, definition}）。版が違えば 409 {code: conflict, current}" },
    { method: "GET", path: "/api/observer/definitions/:id/draft", desc: "観測の編集途中の入力 {draft: {version, basedOnRev, input, savedAt} | null}。PUT {version: 読んだ版か null, basedOnRev, input} で保存（版が違えば 409）" },
    { method: "POST", path: "/api/observer/definitions/:id/suggestions", desc: "保存した観測に手順の提案を頼む {definition: 頼むときの入力, note, basedOnRev}。依頼を観測に残してから始める（202）。GET で履歴（新しい順。中断は interrupted）、GET .../:sid で1件、POST .../:sid/cancel で取り消す" },
    { method: "POST", path: "/api/observer/definitions/:id/procedures/:pid/switch", desc: "手順を置き換え候補のスクリプトに切り替える {rev, invoke, evidence}。ファイルが参照先の中に有ること・今の版が要る。前の実行方法は history に残る" },
    { method: "GET", path: "/api/observer/files", desc: "ファイルの有無 ?ref=<参照先>:<パス>（繰り返せる）→ {files: {<参照先>:<パス>: {state: exists|planned|unverified, checkedAt}}}" },
    { method: "GET", path: "/api/observer/suggestions/context", desc: "手順の提案の頼む先の状態 {engine: {name, ok, detail}, repos: [{name, available, reason}]}" },
    { method: "POST", path: "/api/observer/suggestions", desc: "ID の無い互換の経路: 未保存の入力から確認の手順の提案を始める（本文 {definition, note}）。202 で実行 {id, status}。保存しない（このプロセスの中だけ）" },
    { method: "GET", path: "/api/observer/suggestions/:id", desc: "提案の実行 {status: running|completed|failed|cancelled, result: {surface, rationale, procedures: [{procedure, evidence}], missing, warnings}, failure, error}" },
    { method: "POST", path: "/api/observer/suggestions/:id/cancel", desc: "提案を取り消す" },
    {
      method: "GET",
      path: "/api/projects",
      desc:
        "（all-projects だけ）個人設定を読み直した一覧 {projects: [{name, generation（登録世代）, state: ok|error, error?, open}], invalid: [{name, reason}], configError?}。" +
        "ここに無い API は /api/projects/:project/... の下に置く（通常の serve の /api/... と同じ）。変える操作には x-p3-project-generation が要る（無ければ 428、違えば 409 code: changed）。" +
        "プロジェクトを書かないデータの API は 404 code: project_required。/api/chatgpt（engine は null）・/api/user-theme・/api/events（一覧・テーマ・接続の変更）はプロジェクトを選ばずに使える",
    },
    {
      method: "GET|POST",
      path: "/api/quality",
      desc:
        "品質基準（project.yaml の quality）。GET は {quality: {state: unset | set | invalid, ...}, version, diffs（採用したテンプレートの改版の差分）, templates}。" +
        "POST {ops: [{op: init | adopt | upgrade | add | replace | edit | remove | exempt | unexempt, ...}], version?} で操作を順に当てて quality だけを書く（version が違えば 409 quality_conflict、" +
        "規則に合わなければ 400 quality_invalid、読めない設定は 400 quality_unreadable。設定の保存 PUT /api/project は quality を書かない）。コマンドは実行しない",
    },
    { method: "GET", path: "/api/requests/:rid/tasks/:tid/quality-diff", desc: "タスクの受け入れ基準と今の品質基準の差分 {quality, version, diff: [{kind: add | change | remove | exempt | edited, quality, criterion?, text?, reason?}]}（読むだけ）" },
    {
      method: "POST",
      path: "/api/requests/:rid/tasks/:tid/quality-import",
      desc: "差分を明示して受け入れ基準に取り込む {keys?: [\"<kind>:<品質 ID>\"], rev?}（add は足す、change は文と出典を直す（証拠は再確認が必要になる）、remove・exempt は消す）。POST tasks の quality: auto | none | [ID] で作るときにも取り込む",
    },
    {
      method: "POST",
      path: "/api/quality/improvements/preview",
      desc:
        "品質の不足の診断と改善要望の原稿 {source: {type: project} | {type: task-review, request, task, run} | {type: milestone-review, milestone, run}, keys?}。" +
        "{findings: [{key, kind: unset | invalid | violated | undetermined | exempt, ...}], hash, registered, picked, draft?}（読むだけ。除外は既定で選ばない）",
    },
    {
      method: "POST",
      path: "/api/quality/improvements",
      desc:
        "改善要望を明示して登録する {source, keys, title, body, hash, reopenClosed?}（201 {request, keys}）。診断が変わっていれば 409 diagnosis_changed、開いている登録先があれば 409 existing（existing.request）、" +
        "閉じた要望で扱った不足は reopenClosed が無ければ 409 closed_existing。不足ごとの登録先は quality-improvements.json に残す",
    },
    { method: "GET", path: "/api/quality/templates/:id[?version=]", desc: "同梱の品質基準のテンプレートの中身（版つきの例。業界の標準への認証ではない）" },
    { method: "GET", path: "/api/project", desc: "プロジェクト設定と milestonesVersion（マイルストーンの版）" },
    {
      method: "PUT",
      path: "/api/project",
      desc:
        "プロジェクト設定を項目ごとに保存する。milestones の各項目は purpose（目的）・goals（予定機能 {id, text}）を持てる（キーを省くと今の値を残す。null・空で消す）。" +
        "milestonesVersion を付けると最新の版と照らし、違えば 409 code: milestones_conflict で何も書かない",
    },
    {
      method: "POST",
      path: "/api/reload",
      desc:
        "データのフォルダ（project.yaml・要望・タスク）を全部読み直し、関係の索引も作り直す。応答 {requests, tasks, errors, loadedAt} は読み直しを終えた後。" +
        "読み込み中に呼ぶと、終わってからもう1回読む。project.yaml などが読めなければ 503 で何も変えない。終えたら変更通知 kind: reload",
    },
    {
      method: "GET|POST|PATCH|DELETE",
      path: "/api/repos[/:name]",
      desc: "参照先（共有の定義）。GET は読めたかの状態と、ローカルの画面にだけこのマシンのパス。POST {name, role?, readFirst?, writable?, map?, path?}",
    },
    { method: "PUT|DELETE", path: "/api/repos/:name/path", desc: "参照先のこのマシンのパス（個人設定）。このマシンのローカルの画面（Origin）からだけ" },
    { method: "GET", path: "/api/requests[?parent=<要望ID>]", desc: "要望の一覧と進捗（更新の新しい順。parent で直下の子だけを親の表示順に）。止まっている自分のタスクの数 blocked と配下の数 subtree.blocked（作業中にも数える）、タスクの印に停止の今の値 block と証拠の概要 evidence（{met, total, declarationOnly, metByBasis, problems}。本文は載せない。基準も証拠も無ければ省く）・完了したタスクの見直しの状態 review、要望ごとの見直し候補の数 review: {self?, tasks, below}（below は自分を除く配下）" },
    { method: "POST", path: "/api/requests", desc: "要望の作成（parent で子の要望にする。省いた期限・マイルストーン・タグは親から写す）" },
    {
      method: "GET",
      path: "/api/requests/:rid",
      desc: "要望・タスク・Preflight・対応済なのに未完了のタスクがあるときの知らせ（issue）・親子（parent・ancestors・children・hierarchyIssues）・対応済にできるか（completion: blocker・見送りで対象外の子 excluded）・" +
        "要求の出典と確認（requirement: {state, sources, answers, problems}。state は unrecorded / unconfirmed / confirmed / reconfirm / unlinked。申告の記録で P3 の保証ではない）・" +
        "見直しが必要（候補）（review: {self?（対応済・完了済のときの要望自身の診断）, tasks（タスクごとの概要）, counts: {tasks, below}}）",
    },
    {
      method: "GET|POST",
      path: "/api/requests/:rid/premises",
      desc:
        "前提の変更（外部の規則の変更など。要望の premiseChanges に追記）。POST {op: \"add\", targets: [要望 ID|タスク ID|要望の根拠の ID], reason, condition, rev?} / {op: \"ack\", id, target, condition, rev?}（変更を確かめたことを残す）。" +
        "基点の完了の記録より後の変更で、確認の無い対象は見直し候補の理由になる。過去の完了の記録・状態・済みは変えない。対象が無い・規則に合わなければ 400 premise_invalid、rev が違えば 409（何も書かない）",
    },
    {
      method: "GET|POST",
      path: "/api/requests/:rid/retrospective[/target]",
      desc:
        "要望の振り返り。GET は {version, target?（今の対象）, targets（確定と訂正の履歴）, candidates（採用を終えた run: {run, kind: tasks|split|legacy, latest, basis: [{key?, target, state}], risks}）, none?}。" +
        "POST /target {run, reason?, version?} で対象を確定する（候補の run だけ。評価の版とリスクの原文を写す。2回目からの訂正は reason が要る）。候補でない・理由が無い → 400 retro_invalid、版が違う → 409 retro_conflict（何も書かない）。" +
        "GET は今の対象のリスクと確認 risks: [{index, text, state, judgment?, history}]・三状態の件数 counts・全部の確認 judgments・根拠の今の照合 checks（ok|changed|missing|manual）も返す。" +
        "POST /judgments {risk（0 から）, state: occurred|not_occurred|unchecked, facts?, scope?, reason?, evidence: [{kind: task_review, task, run, section, index?} | {kind: milestone_review, milestone, run, section, index?, reason?} | {kind: rework, task, history} | {kind: manual, reference, note?}], version?} でリスクの確認を追記する（人の判断。起きた → facts と根拠、起きなかった → scope と根拠、判断を変える → reason。範囲外の根拠は 400）",
    },
    {
      method: "GET",
      path: "/api/metrics[?milestone=<ID>]",
      desc:
        "開発の指標（p3 metrics と同じ）。範囲は省けばプロジェクト全体（マイルストーンなしを含む）、milestone は登録済みのマイルストーンに直接属する要望（見送り・アーカイブは除く。登録に無い ID は 400 metrics_invalid）。" +
        "{scope, scopeLabel, scopeRule, metrics: [{id, label, kind: record|manual, unit: hours|count|amount, source, target, method, missingRule, recordHint?, state: ok|no_targets|no_data|not_reached|unrecorded, value（ok 以外は null。manual は1行のときだけ）, targets, observed, missing, denominator?, breakdown, missingItems, rows?（manual: 範囲が一致する人の記録 {id, from, to, value, unit, source, note?, rev, ...}。合算しない）}], notices（broken_request|manual_unreadable|manual_orphan）, scopes}。" +
        "記録の欠けは 0 にせず missing に数える。読むだけ（レビューは実行しない。人の記録を書くのは CLI の p3 metrics record だけ）",
    },
    {
      method: "GET",
      path: "/api/revisit[?request=<要望ID>]",
      desc:
        "見直しが必要（候補）の一覧（完了したタスクと対応済・完了済の要望。完了済みも含む）。各項目は {target, state, record, qualityVersion, reasons: [{code, target, was?, now?, related?}], unreadable?}。" +
        "品質は作業先に当てはまる項目の差だけを見て、設定全体の版の違い・参照先の HEAD の更新では候補にしない。読むだけでファイルを書かない。タスクの一覧は ?review=true で候補だけに絞れる",
    },
    {
      method: "POST",
      path: "/api/requests/:rid/sources",
      desc:
        "要求の根拠の記録を変える {ops: [{op:\"add\", target?, source?, basis?, confirm?:{by, on}} | {op:\"edit\", id, target?, source?, basis?, confirm?} | {op:\"confirm\", id, by, on} | {op:\"remove\", id}], rev?}（CLI の p3 source と同じ。結果は {request, requirement}）。" +
        "確認には出典・根拠・確かめた人（役割名・アクター名）・YYYY-MM-DD の日が要る。題・本文・記録の内容が変わると確認は再確認が必要になる（元に戻しても戻らない）。" +
        "規則に合わなければ 400 code: requirement_invalid、rev が違えば 409 rev_conflict（どちらも何も書かない）。要望の根拠・回答は評価対象に入る（変えるとその評価からは採用しない）",
    },
    {
      method: "POST",
      path: "/api/requests/:rid/answers",
      desc:
        "Preflight の確認事項（run の assessment.clarifications）に回答する {run, question, answer（null で消す）, by?, on?, source?, basis?, links?: [根拠の記録の ID], rev?}（CLI の p3 answer と同じ）。" +
        "回答は要望の clarifyAnswers に残し、過去の run は書き換えない。回答しただけでは根拠の記録を確認記録ありにしない。再評価は別に明示して始める",
    },
    {
      method: "PATCH",
      path: "/api/requests/:rid",
      desc:
        "要望の更新（rev で楽観ロック。競合は 409 code: rev_conflict）。タイトル・本文はどの状態でも変えられる（評価のあとで変えるとその評価からはタスク化できない）。" +
        "status=resolved（対応済）は全タスクが完了のときだけ。done / rejected は人が決める。" +
        "parent で親を付け替える（null で外す）。無い・自分・子孫・アーカイブ済みの親は 409 code: hierarchy_invalid（reason）、ほかの操作と重なれば 409 code: hierarchy_busy（やり直してよい）",
    },
    {
      method: "PUT",
      path: "/api/requests/:rid/child-order",
      desc:
        "子の表示順の保存 {children: [直下の子の ID を全部、上から順に], rev?}（親の childOrder だけを書く。結果は {request, children}）。" +
        "重複・無い要望・直下の子でない・足りないは 409 code: child_order_invalid（reason・ids・今の並び children。子が変わっていれば読み直す）、rev が違えば 409 code: rev_conflict。" +
        "表示の順で、実行の順・着手できるかは表さない",
    },
    { method: "GET|POST", path: "/api/requests/:rid/tasks", desc: "要望のタスク（GET の ?blocked=true で止まっているものだけ（status・area・q と AND）。POST の criteria: [文] で受け入れ基準を付ける（ID は p3 が振る）。対応済の要望に未完了のタスクを足すと進行中に戻し reopened を返す。対応済の祖先も戻して reopenedAncestors、完了済の祖先は warnings の ancestor_done）" },
    { method: "GET|PATCH|DELETE", path: "/api/requests/:rid/tasks/:tid", desc: "タスク（GET は受け入れ基準の状態 acceptance（不足 shortfalls。基準なしは null）も返す。PATCH は rev で楽観ロック、null で項目を消す。" +
        "受け入れ基準・証拠は PATCH の acceptance: [{op: add|edit|remove|order|record|unrecord|source, ...}] で順に当て（source は {op:\"source\", id: 基準の ID, source: 要求の根拠への操作}。POST sources と同じ操作で、from で要望の記録を写す）、規則に合わなければ何も書かず 400 code: acceptance_invalid。" +
        "record の basis は根拠 {kind: unverified|declaration} / {kind: read, reference} / {kind: machine, command, result, target}（作業した側の申告。P3 は検査を実行しない）。" +
        "省くと同じ結果の前の証拠の根拠を引き継ぎ、無ければ unverified は未確認・ほかは申告のみ。met / unmet に未確認、unverified にほかの根拠は付けられない。" +
        "acceptance には根拠ごとの met の件数 metByBasis と申告のみの基準 declarationOnly も入る。" +
        "済みのタスクの基準・証拠の中身が変わると済みを外し checkCleared を返す。" +
        "完了・済みにすると、そのときの条件の写しを completionRecords に追記する（要望の PATCH の対応済・完了済も同じ。記録の値は受け付けない。記録が読めず足せなければ completionSkipped）。" +
        "GET は見直しの診断 review（完了したタスクだけ。state: no_record|unreadable|none|candidate、基点の record、reasons: [{code, target, was?, now?, related?}]。状態は変えない）も返す。" +
        "止まっている理由（停止）は PATCH の blockOp: {op: set, reason, decision?}（作業中だけ。内容を直しても since は変えない）/ {op: clear, resolution}（解除。状態は変えない）で変え、" +
        "日時・履歴は受け付けない。規則に合わなければ 400 block_invalid / block_not_doing、止まったまま未着手・完了へ動かすと 409 blocked（解除と移動を同じ PATCH に書けば一緒に保存する））" },
    {
      method: "GET",
      path: "/api/requests/:rid/archived-tasks[/:tid]",
      desc:
        "アーカイブしたタスク（読むだけ。各タスクに archived: true）。一覧は {request, tasks, errors}（ID の数値順。壊れたファイルは errors）、" +
        "1件は {task}。無い → 404、読めない → 500 code: archive_unreadable。通常の tasks・進捗・対応済の判定には入らない。DELETE /tasks/:tid がアーカイブする",
    },
    { method: "POST", path: "/api/requests/:rid/preflight", desc: "Preflight の実行 {engine?: codex|mock, note?: メモ}。前回の結果とまだ渡していないメモを引き継ぐ。タスク化した後の要望は 409 code: preflight_closed（メモも残さない。変えたいことは新しい要望に）" },
    { method: "GET|POST", path: "/api/requests/:rid/notes", desc: "Preflight へのメモ（GET は渡し済みか・次に引き継ぐ前回の run も返す。POST {body}）" },
    {
      method: "GET",
      path: "/api/requests/:rid/preflight/:run/ui/:material",
      desc: "画面資料の画像（PNG / JPEG）。資料の一覧は run の ui（items の id・対象のタスク案・説明・前提）。原稿（HTML）は返さない",
    },
    {
      method: "GET|POST",
      path: "/api/requests/:rid/attachments",
      desc: "要望の添付（PNG / JPEG / xlsx）。POST は multipart {file, description?, source?}。中身で形式を確かめ、件数・容量に上限。次の Preflight を始めるときに run に固定する",
    },
    { method: "GET|DELETE", path: "/api/requests/:rid/attachments/:aid", desc: "添付の原本（xlsx はダウンロード）・外す（固定済みの過去の run の資料は残る）" },
    { method: "GET", path: "/api/requests/:rid/preflight/:run/attachments/:aid", desc: "その run に固定した添付の原本（run の attachments に一覧）" },
    { method: "GET", path: "/api/requests/:rid/preflight/:run/attachments/:aid/extract", desc: "その run に固定した xlsx から取り出した内容（Markdown のテキスト）" },
    {
      method: "GET",
      path: "/api/requests/:rid/preflight-status[?run=PF-...]",
      desc:
        "最新の Preflight と見ている run の今の状態だけ（要望と run.json をディスクから読む。読み込んだ内容・ファイル・rev は変えない。案・ログは返さない）。" +
        "{requestId, state: ok|gone|broken, latest: RunPulse|null, run?: RunPulse}。RunPulse は {id, state: ready|pending|missing|broken, status?, startedAt?, finishedAt?, version?}" +
        "（pending は保存の途中、version が変われば run を取り直す）。latest は要望の lastPreflight（未実行なら null）。ID の形が違えば 400",
    },
    {
      method: "GET",
      path: "/api/requests/:rid/preflight[/:run]",
      desc:
        "Preflight の run。各 run に inputMatch {status: same|changed|unknown, changed?: [title|body], reason?}（評価対象と今の要望が同じか。タグ・期限・ステータスは比べない）。" +
        "running の run には liveness {state: alive|waiting|dead|unknown, reason?}（実行しているプロセスの今の状態）と、頼まれていれば cancelRequested {at, by?}。" +
        "中断した run には interrupted {reason, at, acknowledgedBy?}",
    },
    {
      method: "POST",
      path: "/api/requests/:rid/preflight/:run/cancel",
      desc:
        "run を中断する {acknowledgeStopped?: boolean}（最新でなくてもよい）→ {state: cancelled|requested|already, message, run, acknowledgeable?}。" +
        "requested は中断を頼んだ（まだ running。実行しているプロセスが止める）。acknowledgeable は動いているか確かめられない run で、" +
        "止まっていることを人が確かめたら acknowledgeStopped: true で中断にできる。無い run は 404、完了した run・動いている run への確認は 409（code: completed|alive）",
    },
    {
      method: "PATCH",
      path: "/api/requests/:rid/preflight/:run/drafts/:key",
      desc:
        "タスク案を直す {title?, description?, include?, repo?, acceptanceCriteria?, expectedTitle?, expectedCriteria?}。" +
        "acceptanceCriteria は受け入れ基準の並び全体 [{id?, text}]（id は残し、無い項目に振る。空で基準なし）で、expectedCriteria（編集を始めたときの基準）が要る。違えば 409 rev_conflict。" +
        "sourceOps: 基準ごとの要求の根拠への操作 [{id: 基準の ID, source: 上の sources と同じ操作（add は from: 要望の記録の ID で写せる）}]。expectedSources（編集を始めたときの acceptanceSources）が要り、違えば 409 rev_conflict。" +
        "expectedTitle（編集を始めたときの題。制御用で案には書かない）を渡すと、" +
        "案のファイルを読み直した今の題と比べ、違えば 409 code: rev_conflict（current に今の案）で書かない。画面から題を変えるときは必ず渡す",
    },
    {
      method: "PATCH",
      path: "/api/requests/:rid/preflight/:run/children/:key",
      desc: "子の要望の案（分割の run）を直す {title?, description?, include?, expectedTitle?}（expectedTitle はタスク案と同じ。採用を始めた run は変えない）",
    },
    {
      method: "GET",
      path: "/api/requests/:rid/preflight/:run/materialize",
      desc: "タスク化の確認（mode: tasks。採用する案と inputMatch。何も変えない）。分割の run は mode: children で、採用する子の案・version（案の版）・problems・adoption（途中経過）",
    },
    {
      method: "POST",
      path: "/api/requests/:rid/preflight/:run/materialize",
      desc:
        "採用したタスク案をタスク化 {archive?: [{id, rev}]}（選んだ候補だけアーカイブ）。結果は {tasks, archived, kept}。" +
        "評価のあとで要望のタイトル・本文が変わった（か確かめられない）run は 409 code: stale_input {inputMatch} で何も書かない（再評価する）。候補の rev の競合は 409 code: rev_conflict。" +
        "分割の run は子の要望を作る {version?}: 結果は {created, failed, pending}（失敗があれば 207。同じ要求でやり直せる）。親の題・本文・子の集合が変わった run は stale_input（inputMatch.changed に children）、確認のあとで案が変わったら 409 code: drafts_changed",
    },
    { method: "GET", path: "/api/release-notes", desc: "マイルストーンごとのリリースノートの有無（ok / invalid / none）・要望の数。project.yaml に無いノートは known: false と警告" },
    {
      method: "GET",
      path: "/api/release-notes/:mid",
      desc: "保存したノート {note（本文・出典・版 version）, noteError（読めない理由）, material（対象の要望・収録の可否・警告・材料の hash）, materialChanged（保存のあとで材料が変わった）, completion（要望を一括で完了済にできるか {ready, targets, alreadyDone, skipped, blockers, basedOn}）}",
    },
    {
      method: "POST",
      path: "/api/release-notes/:mid/complete-requests",
      desc:
        "対応済の要望を一括で完了済にする {basedOn: completion.basedOn}。見送り以外の全要望が全タスク完了のときだけ。タスク（済み）・ノート・マイルストーンは変えない。" +
        "材料が変わった・できないときは何も書かずに 409 code: material_changed / blocked {plan}。途中で止まったら 409 code: partial {result: completed, failed, notRun}",
    },
    {
      method: "PUT",
      path: "/api/release-notes/:mid",
      desc:
        "保存 {body, title?, basedOn?（元にした材料の hash）, version?（更新は読んだときの版が必須）}。版が違う・既にあるは 409 code: rev_conflict {reason, current}、消えたノートの更新は 404。" +
        "要望・マイルストーンの状態は変えない。材料が変わっていれば warnings に material_changed",
    },
    { method: "GET", path: "/api/release-notes/:mid/export", desc: "保存した本文だけ（Markdown のダウンロード。出典・frontmatter は含めない）" },
    {
      method: "POST",
      path: "/api/release-notes/:mid/generate",
      desc: "機能の要約の生成を始める {engine?: codex|mock}（202。保存しない）。材料が無い・上限超えは 400 code: no_material / too_large（Codex は呼ばない）、実行中は 409 code: running",
    },
    { method: "GET", path: "/api/release-notes/:mid/generations", desc: "このマイルストーンの生成（新しい順。serve のメモリにだけある）" },
    {
      method: "GET|POST",
      path: "/api/release-generations/:id[/cancel]",
      desc: "生成1件 {status: running|completed|failed|cancelled, failure?, items（文と出典）, markdown（本文の案）, warnings, materialChanged, log} / 取り消し",
    },
    {
      method: "POST",
      path: "/api/requests/:rid/tasks/:tid/review-preview",
      desc: "タスクの AI レビューの今の材料の要約と hash {targets?, viewpoint?}（比較項目・作業した側の証拠の状態・比較対象・観点の出典・注意・engineRequired。何も書かない）",
    },
    {
      method: "GET|POST",
      path: "/api/requests/:rid/tasks/:tid/reviews",
      desc:
        "タスクの AI レビューの履歴（新しい順。読めない記録も broken）/ 始める（202。{targets?, viewpoint?, engine?, expectedHash?}。完了したタスクだけ。" +
        "材料が変わっていれば 409 material_changed、実行中なら 409 running、Preflight の担当が agent で engine を明示していなければ 400 engine_required）。結果はタスクの状態・済み・基準・証拠を変えない",
    },
    { method: "GET", path: "/api/requests/:rid/tasks/:tid/reviews/:run", desc: "タスクの AI レビューの1回分（固定した材料・結果。実行中は所有者の状態 owner）。結果を直す口は無い" },
    { method: "POST", path: "/api/requests/:rid/tasks/:tid/reviews/:run/cancel", desc: "タスクの AI レビューを取り消す {acknowledgeStopped?}（マイルストーンレビューと同じ規則）" },
    { method: "GET", path: "/api/milestone-reviews", desc: "レビューの履歴のあるマイルストーン {milestones}（project.yaml に無い孤立も。履歴のあるマイルストーンは消せず ID も変えられない）" },
    { method: "GET", path: "/api/milestones/:mid/review-preview", desc: "マイルストーンレビューの今の材料（比較単位・目的・要望の件数と状態・参照先のコード・範囲・警告・hash）。何も書かない" },
    {
      method: "GET|POST",
      path: "/api/milestones/:mid/reviews",
      desc: "レビューの履歴 {items}（新しい順。読めない記録は state: broken）/ 実行を始める {engine?: codex|mock}（202。目的も予定機能も無ければ 400 no_goals、実行中は 409 running）",
    },
    {
      method: "GET|POST",
      path: "/api/milestones/:mid/reviews/:run[/cancel]",
      desc: "1回分 {run, input, result, owner?} / 取消 {acknowledgeStopped?}（ほかのプロセスの run は要求を残す。終わっている・所有者が動いていれば 409）。結果は参考で、要望・ノート・リリース済みを変えない",
    },
    { method: "GET", path: "/api/resolve?q=&request=", desc: "参照・タイトルから対象を特定" },
    { method: "GET", path: "/api/chatgpt", desc: "ChatGPT プランの接続の状態（トークンは返さない）。このマシンからだけ" },
    { method: "POST", path: "/api/chatgpt/login|cancel|paste|logout", desc: "サインインの開始・取消・コールバックの URL の貼り付け・解除。このマシンのローカルの画面（Origin）からだけ" },
    { method: "GET|PUT", path: "/api/user-theme", desc: "画面のテーマ {theme: system|light|dark}（個人設定の ui.theme。このマシンのすべてのプロジェクトで共通。ほかの個人設定は返さない）。PUT はこのマシンのローカルの画面（Origin）からだけ" },
    { method: "GET", path: "/api/events", desc: "変更通知 (SSE)。リリースノートは changed/release-note {milestone}、生成は release-generation {id, milestone, status}" },
  ],
};
