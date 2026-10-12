import type { RefScope, RepoRef } from "./repos.ts";
/**
 * p3 のドメイン型。サーバ・CLI・Web で共有する。
 *
 * 作業の単位は「要望」。要望ごとにフォルダを作り、そこから生まれたタスクや Preflight の記録は
 * すべてその下に置く。タスクは要望をまたいで移動しないので、要望の中で素直な連番（T001, T002, ...）にする。
 *
 *   .p3/requests/<要望ID>/request.md
 *   .p3/requests/<要望ID>/tasks/T001.md
 *   .p3/requests/<要望ID>/preflight/<run>/...
 */

// ---------------------------------------------------------------------------
// 関係: 多元的なので、型付きの有向エッジとして持つ。
// エッジは張った側のファイルに書き、逆向きはインデックスで導く。
// 相手の書き方（参照）は shared/refs.ts を参照。
// ---------------------------------------------------------------------------

/**
 * 関係の種類。A →(種類)→ B と張ったとき、画面と CLI は「役割 + 相手」で見せる:
 *   label   A から見た B の役割（A の詳細に「依存先 B」）
 *   inverse B から見た A の役割（B の詳細に「依存元 A」）
 *   verb    種類そのものの説明（関係を張るときの選択肢・CLI のヘルプ）
 * 例: T002 depends_on T001 → T002 に「依存先 T001」、T001 に「依存元 T002」
 */
/**
 * タスクの関係は2つだけ（どちらも同じ要望の中のタスクを指す。target は "T003"）。
 *   depends_on: 順序（相手が先に終わっている必要がある）。Preflight の案の dependsOn から張る
 *   supersedes: 再評価で古いタスクを置き換える（相手は古い案）。Preflight の案の supersedes から張る
 * 手で張る機能は持たない
 */
export const RELATION_TYPES = {
  depends_on: { label: "依存先", inverse: "依存元", verb: "依存する（相手が先に終わっている必要がある）" },
  supersedes: { label: "旧案", inverse: "新案", verb: "置き換える（相手は古い案）" },
} as const;

/** 関係の向きに応じた相手の役割。out: 張った側から見た相手、in: 張られた側から見た相手（張った側） */
export function relationRole(type: string, direction: "out" | "in"): string {
  const t = RELATION_TYPES[type as keyof typeof RELATION_TYPES];
  if (!t) return type;
  return direction === "out" ? t.label : t.inverse;
}

export type RelationType = keyof typeof RELATION_TYPES;
export const relationTypes = Object.keys(RELATION_TYPES) as RelationType[];

/** 誰が張ったか（今は Preflight のタスク化だけが張る） */
export type RelationOrigin = "human" | "ai" | "preflight";

export interface Relation {
  type: RelationType;
  /** 同じ要望のタスク（"T003"） */
  target: string;
  note?: string;
  origin?: RelationOrigin;
}

// ---------------------------------------------------------------------------
// タスク
// ---------------------------------------------------------------------------

/**
 * タスクの状態は3つで固定（設定では変えない）。タスクは AI か人が実施し、人から見て必要なのは
 * 「まだ動いていない / 処理中 / 処理が終わった（PR・MR・ドキュメントが出た）」だけ。成果物のレビューは成果物の側で行う。
 * 保留や取りやめの状態は持たない: AI が進めた作業は、マージしないなら完了のまま（成果物の側で閉じる）、
 * 手を付けないなら未着手のままでよい。
 */
export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { todo: "未着手", doing: "作業中", done: "完了" };
export const isTaskStatus = (s: unknown): s is TaskStatus => (TASK_STATUSES as readonly unknown[]).includes(s);

export interface Task {
  /** 要望の中での ID（T001） */
  id: string;
  /** 所属する要望の ID（フォルダから決まる。ファイルには書かない） */
  request: string;
  /** プロジェクト全体で一意な参照（<要望ID>/T001。ファイルには書かない） */
  ref: string;
  title: string;
  status: TaskStatus;
  labels: string[];
  /** 触るコード領域（例: "src/core/store"）。表示と絞り込みに使う */
  areas: string[];
  /** 成果物。1項目ずつ URL（PR / MR）・文章・ドキュメントのパスのどれでもよい。項目全体が http(s) の URL なら画面でリンクにする */
  outputs: string[];
  /** 作業先（作業先にできる参照先の名前）。null は作業先なし（調査・人の判断など）。shared/workTarget.ts */
  repo: string | null;
  /** リポジトリごとの成果物（PR など）。最後のタスクに、関係するリポジトリの PR を全部残せる。outputs とは別に持つ */
  repoOutputs?: RepoOutput[];
  /**
   * 作業中にした日時（着手を指示した目安）と、完了にした日時。
   * 予定ではなく、ステータスを変えたときに p3 が記録する（AI や人が書くものではない）
   */
  startedAt?: string;
  doneAt?: string;
  /** 完了したタスクを人が確認して「済み」にした日時（完了から戻すと消える） */
  checkedAt?: string;
  relations: Relation[];
  /** 楽観ロック用リビジョン。同じマシンでの AI と人の同時編集を検出する */
  rev: number;
  createdAt: string;
  updatedAt: string;
  /** 変更者（ai:claude / human:<git の user.name>） */
  updatedBy?: string;
  /** Markdown 本文 */
  body: string;
}

// ---------------------------------------------------------------------------
// 要望 — 作業の単位。1要望 = 1フォルダ = 1作業ツリー（ブランチ）
// ---------------------------------------------------------------------------

/**
 * 要望のステータス。resolved（対応済）は AI など作業する側が「全タスクを終えた」と示すもので、人の確認待ち。
 * done（完了済）・rejected（見送り）は人が決める。
 */
export type RequestStatus = "draft" | "preflight" | "reviewed" | "active" | "resolved" | "done" | "rejected";
export const REQUEST_STATUSES: RequestStatus[] = ["draft", "preflight", "reviewed", "active", "resolved", "done", "rejected"];

/** 要望の、作業先のリポジトリでのブランチ（名前だけ。git のブランチや作業ツリーは作業する人・AI が作る） */
export interface Workstream {
  branch: string;
}

/** リポジトリ（参照先の名前）ごとの成果物 */
export interface RepoOutput {
  repo: string;
  output: string;
}

export interface Request {
  /** フォルダ名（作成日 + 乱数。例: 261009-k7m3x） */
  id: string;
  title: string;
  status: RequestStatus;
  areas: string[];
  /** 期限（YYYY-MM-DD） */
  due?: string;
  /** まとめてリリースする単位（project.yaml の milestones の id） */
  milestone?: string;
  /** タグ: 外部 ID・分類の自由な文字列（例: jira:PROJ-123、group:顧客A、feature）。shared/tags.ts */
  tags: string[];
  /** 作業先のリポジトリごとのブランチ（参照先の名前 → ブランチ）。タスク化・作業先を足したときに要る分だけ割り当てる */
  workstreams?: Record<string, Workstream>;
  /** 最新 preflight run */
  lastPreflight?: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  body: string;
}

/** 進捗の画面・CLI 用の集計 */
/** 進捗のスケジュールに描くためのタスクの要約 */
export type TaskMark = Pick<Task, "id" | "ref" | "title" | "status" | "createdAt" | "startedAt" | "doneAt" | "checkedAt">;

export interface RequestProgress {
  request: Request;
  tasks: TaskMark[];
  /** ステータスごとのタスク数 */
  counts: Record<TaskStatus, number>;
  total: number;
  done: number;
  /** 最後に変更された日時（要望かタスク） */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export type Verdict = "go" | "clarify" | "no_go";

export interface ProposedTask {
  /** run 内のキー (D1, D2, ...)。タスク化すると要望の連番（T00x）が振られる */
  key: string;
  title: string;
  description: string;
  areas: string[];
  /** 同じ run 内の他の key */
  dependsOn: string[];
  /** 置き換える同じ要望の既存タスク（"T003"。再評価で古いタスクを置き換えるとき） */
  supersedes: string[];
  /** 取り込み対象か（UI で切り替え） */
  include: boolean;
  /** 作業先（writable な参照先の名前。null / 無い → 作業先なし）。人がレビューで直せる */
  repo?: string | null;
}

export interface PreflightAssessment {
  summary: string;
  verdict: Verdict;
  validity: { score: number; reasons: string[] };
  feasibility: { score: number; reasons: string[] };
  risks: string[];
  questions: string[];
  areas: string[];
  /** 判断の根拠（調べた箇所と、推測の明示）。無ければ記録なし（以前の結果） */
  evidence?: Evidence[];
}

/**
 * 判断の根拠1つ。verified: 参照先のファイルを読んで確かめた / assumed: 確かめていない推測（消さずに推測と明示する）。
 * P3 は、見ていない参照先・参照先の外・無いファイルを指す verified を assumed に直し、note に理由を書く
 */
export interface Evidence {
  /** 支える判断（例: 「実現可能性: 既存の X で足りる」「D2 の範囲」） */
  claim: string;
  kind: "verified" | "assumed";
  /** 参照先の名前 */
  repo?: string;
  /** 参照先の中の相対パス */
  file?: string;
  /** 行・関数名など */
  location?: string;
  /** 経緯を確かめたコミット（git の履歴を根拠にしたとき） */
  commit?: string;
  /** P3 が付けた注記（確かめた根拠として扱えなかった理由） */
  note?: string;
}

export type PreflightStatus = "running" | "completed" | "failed";

/**
 * Preflight の画面資料の種類。proposal: エンジンが作った画面イメージ（提案。現状の証拠ではない）/
 * current: 人が添付した現状の画像 / spec: 仕様書（xlsx など）から取り出した画像
 */
export const UI_MATERIAL_KINDS = { proposal: "提案", current: "現状（添付）", spec: "仕様書から" } as const;
export type UiMaterialKind = keyof typeof UI_MATERIAL_KINDS;

/** 画面資料1つ（画像は PNG / JPEG。パスは run の ui/ からの相対なので、データのフォルダを動かしても辿れる） */
export interface UiMaterial {
  /** run の中で一意（U1, U2 ...）。画像の取得は 要望 / run / この ID で行う */
  id: string;
  kind: UiMaterialKind;
  /** 画像（run の ui/ からの相対パス） */
  file: string;
  format: "png" | "jpeg";
  /** 画像の実際の大きさ（P3 が画像から読む） */
  width: number;
  height: number;
  bytes: number;
  /** 説明 */
  title: string;
  /** 出典（提案なら原稿、添付なら添付の ID など） */
  source?: string;
  /** 原稿（HTML。run の ui/ からの相対パス。画面には配信しない） */
  html?: string;
  /** 対象のタスク案（D キー。1枚に複数をまとめてもよい） */
  drafts: string[];
  /** 想定した画面の幅（px） */
  viewport?: number;
  /** 前提（仮のデータ・省いたものなど） */
  assumptions: string[];
  /** 資料を作った run */
  run: string;
  /** P3 が原稿から描いた（エンジンは画像を見ていない。利用者が確かめる）。clipped: 縦に長すぎて切った・blocked: 止めた読み込みの数 */
  rendered?: { by: "p3"; clipped: boolean; blocked: number };
}

/**
 * 画面資料の状態。generating: 評価中 / ready: そろった / not_needed: UI を伴わない（理由つき）/ missing: 足りない（理由つき）。
 * run に記録が無ければ以前の run（記録なし）
 */
export type UiMaterialsStatus = "generating" | "ready" | "not_needed" | "missing";

export interface UiMaterials {
  status: UiMaterialsStatus;
  /** UI を伴う案か（エンジンの判定。分からなければ無し） */
  needed?: boolean;
  /** 不要・不足の理由 */
  reason?: string;
  /** 画面イメージが要るタスク案（D キー） */
  targets: string[];
  items: UiMaterial[];
  /** 取り込めなかった資料とその理由 */
  problems: string[];
  /** 必要な画面イメージが足りないので、判定を go から clarify にした */
  verdictAdjusted?: { from: "go"; to: "clarify" };
}

export interface PreflightRun {
  id: string;
  requestId: string;
  engine: "codex" | "mock";
  status: PreflightStatus;
  startedAt: string;
  finishedAt?: string;
  log: PreflightLogEntry[];
  assessment?: PreflightAssessment;
  /** drafts/ 配下のファイルから読み込まれる */
  drafts: ProposedTask[];
  error?: string;
  threadId?: string;
  /** タスク化済みなら作成されたタスク ID */
  materialized?: string[];
  /**
   * タスク化の途中経過。途中で失敗しても、再試行で同じ案を二度作らず、同じタスクを二度アーカイブしないための記録。
   *   created: 作った案とタスク（D1 → T004）、archive: アーカイブに選んだ置き換えられるタスク、archived: アーカイブ済み
   */
  materialization?: {
    created: Record<string, string>;
    archive: string[];
    archived: string[];
    done: boolean;
    /** 割り当てるブランチ（始めたときに決めたもの。やり直しでも同じ） */
    workstreams?: { add: Record<string, Workstream>; noGit: string[] };
  };
  /** 実行した人 */
  startedBy?: string;
  /** 結果を引き継いだ前回の run（無ければ最初から評価した） */
  previous?: string;
  /** 渡したメモの ID。内容は run ディレクトリの carryover.md に固定して残す */
  notes?: string[];
  /**
   * 調べた範囲: 参照先ごとに読めたか（始めるときに P3 が決める。モデルの申告では変えない）。このマシンのパスは入れない。
   * 無ければ以前の run（記録なし）
   */
  scope?: RefScope[];
  /** 画面資料（ui/）。無ければ以前の run（記録なし） */
  ui?: UiMaterials;
  /** 始めるときに固定した添付（run の attachments/ と ui/current/）。無ければ添付なし */
  attachments?: FixedAttachment[];
  /**
   * 評価対象: 始めるときにディスクから読み直して固定した要望のタイトルと本文（正規化済み。エンジンに渡したものと同じ）。
   * 無ければ以前の run（run の request.md から読む）
   */
  input?: PreflightInput;
}

/** Preflight の評価対象（要望のタイトルと本文）。比べるのはこの2つだけ（タグ・期限・ステータスは比べない） */
export interface PreflightInput {
  title: string;
  body: string;
}

/**
 * run の評価対象と今の要望が同じか。
 *   same: 同じ（タスク化できる） / changed: タイトルか本文が変わった / unknown: run の評価対象が読めない（以前の run の欠損など）
 * changed と unknown の run からはタスク化しない（再評価する）
 */
export interface InputMatch {
  status: "same" | "changed" | "unknown";
  /** changed のとき、変わった項目 */
  changed?: ("title" | "body")[];
  /** unknown の理由 */
  reason?: string;
}

/** タスクが置き換えられていることの印。from は置き換えた側のタスク（<要望ID>/T004） */
export interface SupersededMark {
  from: string;
  note?: string;
}

/** タスク化のときに知らせる、置き換えられる既存タスク（同じ要望の未完了のもの） */
export interface SupersedeCandidate {
  /** T001 */
  id: string;
  /** <要望ID>/T001 */
  ref: string;
  title: string;
  status: TaskStatus;
  rev: number;
  /** 置き換えを書いた採用したタスク案 */
  reasons: { draft: string }[];
}

/** タスク化の結果 */
export interface MaterializeResult {
  tasks: Task[];
  /** アーカイブした置き換えられたタスク（T001） */
  archived: string[];
  /** 置き換えられるが残したタスク */
  kept: SupersedeCandidate[];
}

/**
 * Preflight へのメモ: 確認事項への回答や方針の変更。要望のフォルダの notes/<ID>.md に1件1ファイルで書き足す。
 * まだ渡していないメモは、次の Preflight に前回の結果と一緒に渡す。
 */
export interface PreflightNote {
  /** N-20261009-123456-ab12 */
  id: string;
  requestId: string;
  createdAt: string;
  createdBy?: string;
  body: string;
}

/** 添付の形式（初期は画像と Excel だけ） */
export const ATTACHMENT_FORMATS = { png: "PNG 画像", jpeg: "JPEG 画像", xlsx: "Excel（xlsx）" } as const;
export type AttachmentFormat = keyof typeof ATTACHMENT_FORMATS;
/** 添付の上限（1つの要望あたり）。サーバで確かめ、画面でも作成の前に同じ値で知らせる */
export const ATTACHMENT_FILE_LIMITS = {
  count: 20,
  /** 画面資料の画像と同じ上限（run の中で同じ確かめ方をするため） */
  imageBytes: 5 * 1024 * 1024,
  xlsxBytes: 20 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
} as const;

/**
 * 要望の添付（requests/<要望ID>/attachments/<ID>/）。原本は内部の名前で保存し、元の名前・説明・出典を残す。
 * Preflight を始めるときに run の中へコピーして固定する（後で足し・消ししても、過去の run の資料は変わらない）
 */
export interface Attachment {
  /** A-20261012-123456-ab12 */
  id: string;
  requestId: string;
  /** 元のファイル名（表示とダウンロードの名前にだけ使う） */
  name: string;
  format: AttachmentFormat;
  bytes: number;
  sha256: string;
  description?: string;
  /** 出典（どこから持ってきたか） */
  source?: string;
  /** 画像の大きさ */
  width?: number;
  height?: number;
  createdAt: string;
  createdBy?: string;
}

/** run に固定した添付（path は run のフォルダからの相対） */
export interface FixedAttachment extends Omit<Attachment, "requestId"> {
  path: string;
  /** xlsx から取り出したもの（無ければまだ取り出していない） */
  extract?: XlsxExtractRecord;
}

/** xlsx から取り出した範囲と、取り出せなかったもの */
export interface XlsxExtractRecord {
  /** 取り出した内容（Markdown。run のフォルダからの相対） */
  text?: string;
  sheets: number;
  cells: number;
  /** 値が保存されていない数式など（未確認） */
  unknownCells: number;
  /** 埋め込みの画像（画面資料の「仕様書から」。file は run の ui/ からの相対） */
  images: { id: string; file: string; sheet: string; anchor: string; format: "png" | "jpeg"; width: number; height: number; bytes: number }[];
  truncated: string[];
  unsupported: string[];
  /** ブックとして読めなかった理由（このときは中身は未読） */
  error?: string;
}

export interface PreflightLogEntry {
  at: string;
  kind: "info" | "command" | "message" | "error";
  text: string;
}

// ---------------------------------------------------------------------------
// プロジェクト / グラフ
// ---------------------------------------------------------------------------

export interface Milestone {
  /** 要望の milestone に書く短い名前（例: v0.2） */
  id: string;
  title: string;
  /** 予定日（YYYY-MM-DD） */
  due?: string;
  /** リリース済み */
  done?: boolean;
}

export interface ProjectConfig {
  name: string;
  /** 何を作っているプロジェクトか。Preflight の前提になる */
  description: string;
  /**
   * 参照先（リポジトリ・フォルダ。名前・役割・最初に読むか・作業先になりうるか・主なフォルダ）。
   * Preflight が読み、作業先にできるものはタスクの作業先になる。このマシンのパスは個人設定に置く。shared/repos.ts
   */
  repos: RepoRef[];
  /** マイルストーン（リリース）。複数の要望をまとめる */
  milestones: Milestone[];
  /** ブランチ命名規則。{id} {slug} を置換 */
  branchPattern: string;
  preflight: {
    /** プロジェクト固有の評価の観点・制約（例: 「外部 API の追加は要相談」） */
    instructions: string;
  };
}

/** changed の kind "reload": データのフォルダを全部読み直した（画面の「再読み込み」）。画面はすべて取り直す */
export type ServerEvent =
  | { type: "changed"; kind: "task" | "request" | "preflight" | "note" | "attachment" | "project" | "chatgpt" | "user" | "reload"; request?: string; ref?: string }
  | { type: "preflight-log"; runId: string; entry: PreflightLogEntry }
  | { type: "preflight-status"; runId: string; status: PreflightStatus };

// ---------------------------------------------------------------------------
// 画面のテーマ（個人設定の ui.theme。このマシンのすべてのプロジェクトで共通）
// ---------------------------------------------------------------------------

/** system: OS（ブラウザ）の表示設定に合わせる（既定）/ light: 常にライト / dark: 常にダーク */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const isTheme = (v: unknown): v is Theme => typeof v === "string" && (THEMES as readonly string[]).includes(v);
