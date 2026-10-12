import type { RefScope, RepoRef } from "./repos.ts";
/**
 * pcube のドメイン型。サーバ・CLI・Web で共有する。
 *
 * 作業の単位は「要望」。要望ごとにフォルダを作り、そこから生まれたタスクや Preflight の記録は
 * すべてその下に置く。タスクは要望をまたいで移動しないので、要望の中で素直な連番（T001, T002, ...）にする。
 *
 *   .pcube/requests/<要望ID>/request.md
 *   .pcube/requests/<要望ID>/tasks/T001.md
 *   .pcube/requests/<要望ID>/preflight/<run>/...
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
export const RELATION_TYPES = {
  depends_on: { label: "依存先", inverse: "依存元", verb: "依存する（相手が先に終わっている必要がある）", schedule: true },
  part_of: { label: "親", inverse: "子", verb: "一部である（相手が全体）", schedule: false },
  derived_from: { label: "派生元", inverse: "派生先", verb: "派生した（相手から生まれた）", schedule: false },
  impacts: { label: "影響先", inverse: "影響元", verb: "影響する（相手に影響が及ぶ）", schedule: false },
  relates_to: { label: "関連", inverse: "関連", verb: "関連する", schedule: false },
  duplicates: { label: "重複", inverse: "重複", verb: "重複する（相手と同じ内容）", schedule: false },
  supersedes: { label: "旧案", inverse: "新案", verb: "置き換える（相手は古い案）", schedule: false },
} as const;

/** 関係の向きに応じた相手の役割。out: 張った側から見た相手、in: 張られた側から見た相手（張った側） */
export function relationRole(type: string, direction: "out" | "in"): string {
  const t = RELATION_TYPES[type as keyof typeof RELATION_TYPES];
  if (!t) return type;
  return direction === "out" ? t.label : t.inverse;
}

export type RelationType = keyof typeof RELATION_TYPES;
export const relationTypes = Object.keys(RELATION_TYPES) as RelationType[];

/** 誰がそのエッジを張ったか。AI 由来のものは confidence を持ち、人が見直せる。 */
export type RelationOrigin = "human" | "ai" | "preflight";

export interface Relation {
  type: RelationType;
  /** 同じ要望のタスクは "T003"、別の要望のタスクは "<要望ID>/T003"、要望そのものは "<要望ID>" */
  target: string;
  note?: string;
  origin?: RelationOrigin;
  /** 0..1 (AI 推定の場合) */
  confidence?: number;
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
  /** 影響するコード領域（例: "src/server/store"）。暗黙の関連の根拠になる */
  areas: string[];
  /** 成果物。1項目ずつ URL（PR / MR）・文章・ドキュメントのパスのどれでもよい。項目全体が http(s) の URL なら画面でリンクにする */
  outputs: string[];
  /** 作業先（作業先にできる参照先の名前）。null は作業先なし（調査・人の判断など）。shared/workTarget.ts */
  repo: string | null;
  /** リポジトリごとの成果物（PR など）。最後のタスクに、関係するリポジトリの PR を全部残せる。outputs とは別に持つ */
  repoOutputs?: RepoOutput[];
  /**
   * 作業中にした日時（着手を指示した目安）と、完了にした日時。
   * 予定ではなく、ステータスを変えたときに pcube が記録する（AI や人が書くものではない）
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
  /** 別の要望・タスクとの関係（target は "<要望ID>" か "<要望ID>/T003"） */
  relations: Relation[];
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
  /** 既存の要望/タスクへの関係（target は "<要望ID>" か "<要望ID>/T003"） */
  relations: Relation[];
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
  /** 既存の要望/タスクへの影響（target は "<要望ID>" か "<要望ID>/T003"） */
  impacts: { target: string; type: RelationType; reason: string; confidence: number }[];
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
  /** P3 が付けた注記（確かめた根拠として扱えなかった理由） */
  note?: string;
}

export interface RelatedItem {
  /** "<要望ID>" か "<要望ID>/T003" */
  ref: string;
  title: string;
  kind: "task" | "request";
  score: number;
  reasons: string[];
}

export type PreflightStatus = "running" | "completed" | "failed";

export interface PreflightRun {
  id: string;
  requestId: string;
  engine: "codex" | "mock";
  status: PreflightStatus;
  startedAt: string;
  finishedAt?: string;
  /** インテリジェンス層が選んだ文脈 */
  context: RelatedItem[];
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
}

/** タスクが置き換えられていることの印。from は置き換えた側（<要望ID> なら要望単位の置き換え、<要望ID>/T004 ならタスク） */
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
  /** どこに置き換えが書かれていたか（評価の影響 / 採用したタスク案） */
  reasons: { source: "impact" | "draft"; draft?: string; note?: string }[];
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

/** グラフの辺。from / to は絶対参照（"<要望ID>" か "<要望ID>/T003"） */
export interface GraphEdge {
  from: string;
  to: string;
  type: RelationType;
  origin: RelationOrigin | "index";
  weight?: number;
  note?: string;
}

export interface Neighborhood {
  ref: string;
  outgoing: GraphEdge[];
  incoming: GraphEdge[];
  /** 明示エッジは無いが、領域・内容の類似から推定された関連 */
  implicit: RelatedItem[];
  /** depends_on / impacts / part_of を逆にたどった影響範囲（絶対参照） */
  impactScope: string[];
  /** 上に出てくる参照のタイトル（別の要望のタスクも画面に名前で出すため） */
  titles: Record<string, string>;
}

/** changed の kind "reload": データのフォルダを全部読み直した（画面の「再読み込み」）。画面はすべて取り直す */
export type ServerEvent =
  | { type: "changed"; kind: "task" | "request" | "preflight" | "note" | "project" | "chatgpt" | "user" | "reload"; request?: string; ref?: string }
  | { type: "preflight-log"; runId: string; entry: PreflightLogEntry }
  | { type: "preflight-status"; runId: string; status: PreflightStatus };

// ---------------------------------------------------------------------------
// 画面のテーマ（個人設定の ui.theme。このマシンのすべてのプロジェクトで共通）
// ---------------------------------------------------------------------------

/** system: OS（ブラウザ）の表示設定に合わせる（既定）/ light: 常にライト / dark: 常にダーク */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const isTheme = (v: unknown): v is Theme => typeof v === "string" && (THEMES as readonly string[]).includes(v);
