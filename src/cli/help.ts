import { RELATION_TYPES, REQUEST_STATUSES, relationTypes } from "../shared/types.ts";

/** p3 help */

export const HELP = `p3（infodb p3）— 要望ごとにフォルダを分けて管理するファイルベースのタスク管理

使い方: p3 <コマンド> [引数] [オプション]

プロジェクト
  init                         管理したいリポジトリの中で実行。データのフォルダを作り（既にあれば参加し）、個人設定に登録する。
                               このリポジトリを本体の参照先として登録する
                               --project 名前 --dir フォルダ --repo-name 参照先の名前（既定はフォルダ名）--description
                               --instructions 観点 --agents --yes
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
  whoami                       操作するプロジェクト・変更者・今の要望
  serve [--port] [--host]      ブラウザ用のビューアを起動（既定は個人設定の serve.port / serve.host か $P3_PORT / $P3_HOST）
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
  request ls                   一覧（--status draft,active ... --milestone id --tag 値。繰り返すとどれか）
  request show [<要望>]         --brief 作業に要る項目だけ（本文・状態・ブランチ・タスクの一覧）
  request set [<要望>] キー=値   title status due milestone tags areas（status: ${REQUEST_STATUSES.join(" ")}）
                               --body 本文|-  本文を書き換える（- は標準入力。どの状態でも書き換えられる。--rev で楽観ロック）
                               例: p3 request show <要望> --brief --json で rev を見て
                                   p3 request set <要望> --body - --rev 3 < body.md
                               評価のあとでタイトル・本文を変えると、その評価からはタスク化できない（もう一度 preflight）
                               --tag 値 ...  タグをこの値の並びに置き換える（カンマで分けない。tags=a,b はカンマで分ける）
  request archive <要望>

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

共通オプション
  --project 名前 操作するプロジェクト（既定: 今いるリポジトリに登録したもの → 登録が1つならそれ）
  --dir パス     データのフォルダを直接指す
  --req 要望     今の要望（既定: $P3_REQUEST → 要望の作業ツリー）。ID の一部（k7m3x）でもよい
  --json        JSON で出力（AI 向け）
  --actor 名前   変更者（既定: $P3_ACTOR → human:<git の user.name>）
  --rev 番号     楽観ロック。指定した rev でなければ更新しない（set / move）

タスクの関係（同じ要望の中だけ。Preflight のタスク化が張り、手では張らない。A → B のとき A には「相手の役割 B」、B には「相手の役割 A」と出る）:
${relationTypes.map((t) => `  ${t.padEnd(13)} ${RELATION_TYPES[t].verb}  →「${RELATION_TYPES[t].label}」/ 逆「${RELATION_TYPES[t].inverse}」`).join("\n")}
`;

