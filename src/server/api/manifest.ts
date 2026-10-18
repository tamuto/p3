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
  relationTypes: RELATION_TYPES, // タスクの関係は depends_on と supersedes だけ（Preflight のタスク化が張る。手で張る API は無い）
  endpoints: [
    { method: "GET", path: "/api/project", desc: "プロジェクト設定" },
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
    { method: "GET", path: "/api/requests", desc: "要望の一覧と進捗" },
    { method: "POST", path: "/api/requests", desc: "要望の作成" },
    { method: "GET", path: "/api/requests/:rid", desc: "要望・タスク・Preflight・置き換えられたタスクの印（superseded）・対応済なのに未完了のタスクがあるときの知らせ（issue）" },
    {
      method: "PATCH",
      path: "/api/requests/:rid",
      desc:
        "要望の更新（rev で楽観ロック。競合は 409 code: rev_conflict）。タイトル・本文はどの状態でも変えられる（評価のあとで変えるとその評価からはタスク化できない）。" +
        "status=resolved（対応済）は全タスクが完了のときだけ。done / rejected は人が決める",
    },
    { method: "GET|POST", path: "/api/requests/:rid/tasks", desc: "要望のタスク（対応済の要望に未完了のタスクを足すと進行中に戻し reopened を返す）" },
    { method: "GET|PATCH|DELETE", path: "/api/requests/:rid/tasks/:tid", desc: "タスク（GET は置き換えの印 superseded も返す。PATCH は rev で楽観ロック、null で項目を消す。置き換えられたタスクを作業中にすると warnings を添える）" },
    { method: "POST", path: "/api/requests/:rid/preflight", desc: "Preflight の実行 {engine?: codex|mock, note?: メモ}。前回の結果とまだ渡していないメモを引き継ぐ" },
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
      desc: "Preflight の run。各 run に inputMatch {status: same|changed|unknown, changed?: [title|body], reason?}（評価対象と今の要望が同じか。タグ・期限・ステータスは比べない）",
    },
    {
      method: "PATCH",
      path: "/api/requests/:rid/preflight/:run/drafts/:key",
      desc:
        "タスク案を直す {title?, description?, include?, repo?, expectedTitle?}。expectedTitle（編集を始めたときの題。制御用で案には書かない）を渡すと、" +
        "案のファイルを読み直した今の題と比べ、違えば 409 code: rev_conflict（current に今の案）で書かない。画面から題を変えるときは必ず渡す",
    },
    { method: "GET", path: "/api/requests/:rid/preflight/:run/materialize", desc: "タスク化の確認（採用する案と、置き換えられる既存タスクの候補、inputMatch。何も変えない）" },
    {
      method: "POST",
      path: "/api/requests/:rid/preflight/:run/materialize",
      desc:
        "採用したタスク案をタスク化 {archive?: [{id, rev}]}（選んだ候補だけアーカイブ）。結果は {tasks, archived, kept}。" +
        "評価のあとで要望のタイトル・本文が変わった（か確かめられない）run は 409 code: stale_input {inputMatch} で何も書かない（再評価する）。候補の rev の競合は 409 code: rev_conflict",
    },
    { method: "GET", path: "/api/release-notes", desc: "マイルストーンごとのリリースノートの有無（ok / invalid / none）・要望の数。project.yaml に無いノートは known: false と警告" },
    {
      method: "GET",
      path: "/api/release-notes/:mid",
      desc: "保存したノート {note（本文・出典・版 version）, noteError（読めない理由）, material（対象の要望・収録の可否・警告・材料の hash）, materialChanged（保存のあとで材料が変わった）}",
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
    { method: "GET", path: "/api/resolve?q=&request=", desc: "参照・タイトルから対象を特定" },
    { method: "GET", path: "/api/chatgpt", desc: "ChatGPT プランの接続の状態（トークンは返さない）。このマシンからだけ" },
    { method: "POST", path: "/api/chatgpt/login|cancel|paste|logout", desc: "サインインの開始・取消・コールバックの URL の貼り付け・解除。このマシンのローカルの画面（Origin）からだけ" },
    { method: "GET|PUT", path: "/api/user-theme", desc: "画面のテーマ {theme: system|light|dark}（個人設定の ui.theme。このマシンのすべてのプロジェクトで共通。ほかの個人設定は返さない）。PUT はこのマシンのローカルの画面（Origin）からだけ" },
    { method: "GET", path: "/api/events", desc: "変更通知 (SSE)。リリースノートは changed/release-note {milestone}、生成は release-generation {id, milestone, status}" },
  ],
};
