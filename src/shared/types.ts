/**
 * pcube のドメイン型。サーバ・Web・AI API で共有する。
 * 永続化はすべてファイル（1エンティティ = 1ファイル）で行う。
 */

// ---------------------------------------------------------------------------
// Relations: タスク間の関係は「多元的」なので、型付きの有向エッジとして持つ。
// エッジは source 側ファイルの frontmatter に保存し、逆方向はインデックスで導出する。
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

/** 誰がそのエッジを張ったか。AI 由来のものは confidence を持ち、人がレビューできる。 */
export type RelationOrigin = "human" | "ai" | "preflight";

export interface Relation {
  type: RelationType;
  /** TASK-xxxx / REQ-xxxx */
  target: string;
  note?: string;
  origin?: RelationOrigin;
  /** 0..1 (AI 推定の場合) */
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export interface StatusDef {
  id: string;
  label: string;
  /** 完了扱いの列 */
  done?: boolean;
}

export const DEFAULT_STATUSES: StatusDef[] = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done", done: true },
];

export interface Task {
  id: string;
  title: string;
  status: string;
  /** 由来する要望（= 作業ツリー単位） */
  request?: string;
  assignee?: string;
  labels: string[];
  /** 影響するコード領域・コンポーネント（例: "src/server/store", "auth"）。暗黙的関連の根拠になる */
  areas: string[];
  /** 見積り（人日） */
  estimate?: number;
  /** YYYY-MM-DD */
  start?: string;
  /** YYYY-MM-DD */
  due?: string;
  /** 0..100 */
  progress?: number;
  relations: Relation[];
  /** 楽観ロック用リビジョン。AI と人の同時編集を検出する */
  rev: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  /** Markdown 本文 */
  body: string;
}

// ---------------------------------------------------------------------------
// Request (要望) — preflight の入力。1要望 = 1作業ツリー(ブランチ)
// ---------------------------------------------------------------------------

export type RequestStatus = "draft" | "preflight" | "reviewed" | "accepted" | "rejected";

export interface Workstream {
  branch: string;
  /** リポジトリルートからの相対パス */
  worktree: string;
}

export interface Request {
  id: string;
  title: string;
  status: RequestStatus;
  areas: string[];
  relations: Relation[];
  workstream?: Workstream;
  /** 最新 preflight run */
  lastPreflight?: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export type Verdict = "go" | "clarify" | "no_go";

export interface ProposedTask {
  /** run 内のローカルキー (T1, T2, ...) */
  key: string;
  title: string;
  description: string;
  estimateDays: number;
  areas: string[];
  /** 同じ run 内の他の key */
  dependsOn: string[];
  /** 既存タスク/要望への関係 */
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
  /** 既存の要望/タスクへの影響 */
  impacts: { target: string; type: RelationType; reason: string; confidence: number }[];
}

export interface RelatedItem {
  id: string;
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
}

export interface PreflightLogEntry {
  at: string;
  kind: "info" | "command" | "message" | "error";
  text: string;
}

// ---------------------------------------------------------------------------
// Project / graph
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  name: string;
  description: string;
  /** 管理対象リポジトリのルート（data dir からの相対 or 絶対）。Codex の cwd になる */
  repo: string;
  statuses: StatusDef[];
  /** ブランチ命名規則。{id} {slug} を置換 */
  branchPattern: string;
  worktreeDir: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: RelationType | "implicit";
  origin: RelationOrigin | "index";
  weight?: number;
  note?: string;
}

export interface Neighborhood {
  id: string;
  outgoing: GraphEdge[];
  incoming: GraphEdge[];
  /** 明示エッジは無いが、領域・内容の類似から推定された関連 */
  implicit: RelatedItem[];
  /** depends_on / impacts / part_of を逆にたどった影響範囲 */
  impactScope: string[];
}

export type ServerEvent =
  | { type: "changed"; kind: "task" | "request" | "preflight" | "project"; id?: string }
  | { type: "preflight-log"; runId: string; entry: PreflightLogEntry }
  | { type: "preflight-status"; runId: string; status: PreflightStatus };
