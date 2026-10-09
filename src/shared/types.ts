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

export const RELATION_TYPES = {
  depends_on: { label: "依存する", inverse: "依存される", schedule: true },
  part_of: { label: "の一部", inverse: "を含む", schedule: false },
  derived_from: { label: "から派生", inverse: "の派生元", schedule: false },
  impacts: { label: "に影響", inverse: "から影響を受ける", schedule: false },
  relates_to: { label: "関連", inverse: "関連", schedule: false },
  duplicates: { label: "と重複", inverse: "と重複", schedule: false },
  supersedes: { label: "を置き換え", inverse: "に置き換えられた", schedule: false },
} as const;

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
  /** 成果物（PR / MR の URL、ドキュメントのパスなど） */
  outputs: string[];
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

export type RequestStatus = "draft" | "preflight" | "reviewed" | "active" | "done" | "rejected";
export const REQUEST_STATUSES: RequestStatus[] = ["draft", "preflight", "reviewed", "active", "done", "rejected"];

export interface Workstream {
  branch: string;
  /** リポジトリルートからの相対パス */
  worktree: string;
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
  /** カテゴリやタグ（例: feature, bug, ui） */
  tags: string[];
  workstream?: Workstream;
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
  /** 実行した人 */
  startedBy?: string;
  /** 結果を引き継いだ前回の run（無ければ最初から評価した） */
  previous?: string;
  /** 渡したメモの ID。内容は run ディレクトリの carryover.md に固定して残す */
  notes?: string[];
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
  /** 管理対象リポジトリのルート（data dir からの相対 or 絶対）。Codex の cwd になる */
  repo: string;
  /** プロジェクトのドキュメント（リポジトリ相対のファイル/フォルダ）。Preflight で最初に読ませる */
  docs: string[];
  /** マイルストーン（リリース）。複数の要望をまとめる */
  milestones: Milestone[];
  /** ブランチ命名規則。{id} {slug} を置換 */
  branchPattern: string;
  worktreeDir: string;
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

export type ServerEvent =
  | { type: "changed"; kind: "task" | "request" | "preflight" | "note" | "project"; request?: string; ref?: string }
  | { type: "preflight-log"; runId: string; entry: PreflightLogEntry }
  | { type: "preflight-status"; runId: string; status: PreflightStatus };
