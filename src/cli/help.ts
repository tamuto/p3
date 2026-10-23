import { RELATION_TYPES, REQUEST_STATUSES, relationTypes } from "../shared/types.ts";

/** p3 help */

export const HELP = `p3（infodb p3）— 要望ごとにフォルダを分けて管理するファイルベースのタスク管理

使い方: p3 <コマンド> [引数] [オプション]

プロジェクト
  init                         新しくプロジェクトを作る。管理したいリポジトリの中で実行し、データのフォルダを作って個人設定に登録する。
                               このリポジトリを本体の参照先として登録する。データの既定はリポジトリのルートの .p3（既にあれば作らずに断る → join）
                               --project 名前 --dir フォルダ（外に置くとき。相対は今いる場所から）--repo-name 参照先の名前（既定はフォルダ名）--description
                               --instructions 観点 --yes
                               --agents claude|codex|both  AI 向けの使い方（スキルと AGENTS.md / CLAUDE.md の節）を置く先（値を省くと both。付けなければ置かない）
  agents claude|codex|both [--force]  AI 向けの使い方を、今いるリポジトリに後から置く・最新にする（選んだ先だけ。データ・個人設定は変えない）
                               違うものは上書きせず知らせる。--force で選んだ先のスキルと p3 の節だけを同梱の版にする（ほかの文は残す）
  join                         既にあるプロジェクト（共有されたデータのフォルダ）に参加する。個人設定に登録するだけで、データ・リポジトリのファイルは変えない
                               --project 名前 --dir フォルダ（既定はリポジトリのルートの .p3）--repo-name 参照先の名前（共有の定義にあるもの）--yes
  project [ls | add <名前> <フォルダ> | rm <名前>]  個人設定のプロジェクト
  config [set キー=値 ...]      設定の表示・変更（name description branchPattern instructions）
  repo [ls | add | set | path | rm]   Preflight が読む参照先（リポジトリ・フォルダ。数と名前は自由）
                               add <名前> [<パス>] [role=… readFirst=true writable=true]  共有の定義を足す
                               set <名前> キー=値 …  共有の定義を変える / path <名前> <パス>  このマシンのパスだけ登録
                               rm <名前>  共有の定義ごと消す（--local はこのマシンのパスだけ）
  user-config [set キー=値 ...]  個人設定（このマシン・この人。全プロジェクト共通）の値と出どころ（環境変数 / 個人設定 / 既定）
                               set ui.theme=system|light|dark / codex.auth / codex.authVolume / codex.authFile / codex.model
                                   codex.effort / codex.ensureImage / preflight.engine / serve.host / serve.port（キー= で消す）
                               set codex.pathMap+=<このマシンのパス>=<Docker デーモンから見たパス>  パスの対応を足す
                               set codex.pathMap-=<このマシンのパス>  外す（codex.pathMap= で全部外す）
  progress                     要望ごとの進捗（マイルストーンごと。--all で完了・見送りも。既定でも対応済を出す）
  milestone [ls | add <id> | set <id> | rm <id>]  マイルストーン（リリース）  --title 名前 --due YYYY-MM-DD --done
  release-notes [ls]           マイルストーンごとのリリースノートの有無と要望の数
  release-notes show <id>       保存したノート（本文・版）と、対象の要望（収録 / 対象外）・警告（未完了・記録なし など）
  release-notes generate <id>   変更の記録から機能の要約を Codex で生成し、本文の案を stdout に出す（保存しない。進み具合と出典は stderr。
                               Ctrl-C で取り消す。材料が無ければ Codex を呼ばずに断る）--engine codex|mock（mock は要約しない試し用）
  release-notes save <id>       本文を保存する  --body 本文|- / --file 本文.md  --based-on <材料の hash>（生成の案を元にしたとき）
                               既にあるノートの更新は --version <版>（show で見る。違えば競合で終了コード 3）
  release-notes export <id>     保存した本文だけを stdout に出す（出典・frontmatter は出さない）
  release-notes complete-requests <id> --based-on <hash>
                               対応済の要望を一括で完了済にする（見送り以外の全要望が全タスク完了のときだけ。タスクの済みは変えない）。
                               できるか・対象・hash は show で見る。材料が変わっていれば何も変えずに終了コード 3、途中で止まったら非ゼロ
                               例: p3 release-notes generate v0.2 > draft.md → 直す → p3 release-notes save v0.2 --file draft.md
                                   p3 release-notes export v0.2 > RELEASE.md
  whoami                       操作するプロジェクト・変更者・今の要望
  serve [--port] [--host]      ブラウザ用のビューアを起動（既定は個人設定の serve.port / serve.host か $P3_PORT / $P3_HOST）
                               --all-projects  個人設定に登録したプロジェクトを跨いで扱う（画面で選ぶ。--project / --dir とは一緒に使えない）
  chatgpt login | status | logout   Preflight に使う ChatGPT プランの接続（このマシン。プロジェクトに属さない）
                               login: --paste（コールバックに届かないとき URL を貼る）--no-browser --port 1455
                               logout: --forget（このマシンの登録ごと消す）
  codex update                 Codex のイメージを今すぐ作り直し、入った Codex の版を表示（Docker が要る。認証は要らない）
                               Preflight の前は、作ってから1日より古いときだけ作り直す
  render <原稿.html>             自己完結した HTML / CSS を PNG にする（画面イメージと同じ描画。Docker が要る）
                               --out 画像.png --width 1280。render update で描画のイメージを作り直す

要望
  request new <タイトル>         --body 本文|- --area パス --due YYYY-MM-DD --milestone id --tag 値（外部 ID・分類。繰り返し可）
                               --attach ファイル（PNG / JPEG / xlsx。繰り返し可。作る前に全部確かめ、だめなら要望を作らない）
                               --parent <要望>  子の要望にする（省いた期限・マイルストーン・タグは親から写す）
  request ls                   一覧（--status draft,active ... --milestone id --tag 値。繰り返すとどれか。--parent <要望> で直下の子を表示順に）
  request show [<要望>]         --brief 作業に要る項目だけ（本文・状態・ブランチ・タスクの一覧・親子）
  request set [<要望>] キー=値   title status due milestone tags areas parent（status: ${REQUEST_STATUSES.join(" ")}。parent= で親を外す）
                               --body 本文|-  本文を書き換える（- は標準入力。どの状態でも書き換えられる。--rev で楽観ロック）
                               例: p3 request show <要望> --brief --json で rev を見て
                                   p3 request set <要望> --body - --rev 3 < body.md
                               評価のあとでタイトル・本文を変えると、その評価からはタスク化できない（もう一度 preflight）
                               --tag 値 ...  タグをこの値の並びに置き換える（カンマで分けない。tags=a,b はカンマで分ける）
  request order <親> [<子>...]   直下の子の表示順を保存する（子を全部、上から順に。--rev で楽観ロック）。子を省くと今の並びを出す
                               表示の順だけで、実行の順・着手できるかは表さない（前提は子の本文で確かめる）
  request archive <要望>        子のある要望・親のある要望はできない（先に親を外す）

タスク（今の要望の中。--req <要望> で指定、要望の作業ツリーの中なら省略可）
  ls                           一覧  --status s1,s2  --area パス  -q 語句  --repo <参照先>|none（作業先）  --all（全要望）
  show <T003|要望|語句>          詳細と関係（依存・置き換え）
                               --brief 作業に要る項目だけ（本文・状態・依存とその状態・置き換えの注意・成果物・rev）
  new <タイトル>                 --body 本文|- --area a --label l --status --output 成果物（繰り返し可）
                               --repo <参照先>|none 作業先（作業先にできる参照先だけ。足りないブランチは割り当てる）
  set <T003> キー=値 ...         title status labels areas outputs repo（空で消す。outputs= はカンマ区切りで置き換える。repo=none は作業先なし）
                               --repo-output <参照先>=<成果物>  リポジトリごとの成果物を足す（repoOutputs= で全部外す）
  move <T003> <ステータス>        --output URL・文章・パス（成果物を足す。繰り返し可。カンマで分けない）
                               --repo-output <参照先>=<URL>  リポジトリごとの成果物（最後のタスクに全リポジトリの PR を残す）
                               --record 本文|-  変更の記録（何を変えたか・なぜ・入れた決まり・やめたもの。AI が完了にするときは必須。set でも直せる）
  check <T003> [--off]         完了したタスクを人が確認して「済み」にする（--off で外す）
  archive <T003>               .archive/ へ移す
  find <語句>                    参照・タイトルで探す

Preflight
  preflight [<要望>]            評価・細分化を実行し、完了まで待つ  --engine codex|mock
                               前回の結果とまだ渡していないメモを引き継ぐ
                               --note 本文|-  メモ（確認事項への回答・方針の変更）を書き足してから実行  --note-only 書くだけ
  notes [<要望>]                メモの一覧（次の Preflight に渡すもの・渡し済み）
  attach [ls]                  要望の添付（PNG / JPEG / xlsx）の一覧。要望は --req（要望の作業ツリーの中なら省略可）
  attach add <ファイル>           添付を足す  --description 説明 --source 出典。次の Preflight を始めるときに run に固定して渡す
  attach get <A-ID> / rm <A-ID>  原本を書き出す（--out ファイル、--run PF-... でその run に固定した原本）/ 外す
  drafts [<要望>]               最新の評価とタスク案  --run PF-...（評価対象が今の要望と同じか: inputMatch）
  accept [<要望>]               タスク案をタスク化  --run PF-...  --only D1,D2  --skip D3
                               評価のあとでタイトル・本文が変わった run からはしない（code: stale_input。再評価する）
                               置き換えられる既存タスクを表示して残す。--archive-superseded でアーカイブ
                               分割の run（子の要望の案 C1, C2 ...）は、選んだ案から下書きの子の要望を作る（親は残す。子の Preflight はまだ）。
                               途中で失敗したら同じ accept で続ける（作った子は作り直さない）

共通オプション
  --project 名前 操作するプロジェクト（既定: 今いるリポジトリに登録したもの → 登録が1つならそれ。
                 登録が1つだけで決まったときは読むだけ。変える操作は --project か、リポジトリの中で）
  --dir パス     データのフォルダを直接指す
  --req 要望     今の要望（既定: $P3_REQUEST → 要望の作業ツリー）。ID の一部（k7m3x）でもよい
  --json        JSON で出力（AI 向け）
  --actor 名前   変更者（既定: $P3_ACTOR → human:<git の user.name>）
  --rev 番号     楽観ロック。指定した rev でなければ更新しない（set / move）

タスクの関係（同じ要望の中だけ。Preflight のタスク化が張り、手では張らない。A → B のとき A には「相手の役割 B」、B には「相手の役割 A」と出る）:
${relationTypes.map((t) => `  ${t.padEnd(13)} ${RELATION_TYPES[t].verb}  →「${RELATION_TYPES[t].label}」/ 逆「${RELATION_TYPES[t].inverse}」`).join("\n")}
`;

