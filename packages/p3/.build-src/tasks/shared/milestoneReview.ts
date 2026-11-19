import type { MilestoneGoal, PreflightLogEntry, RequestStatus, RunOwner, TaskStatus } from "./types.ts";
import type { QualitySnapshot } from "./quality.ts";
import type { QualityVerdict } from "./taskReview.ts";

/**
 * マイルストーンレビューの形（CLI・API・画面で共有する）。保存の規則は core/milestoneReview/。
 *
 * レビューは、保存してあるマイルストーンの目的・予定機能に対して、参照先のリポジトリのコードと git の履歴を Codex が読み、
 * 実装が目的を果たしているか・目的に無い変更（意図しない変更）が無いかを確かめる参考の記録。所属する要望・タスクの記録は
 * 実装した人（AI）の自己申告として、どこを見るかの手がかりにする（それだけを達成の根拠にしない）。
 * テストやアプリを実際に動かしてはいない。要望の状態・リリースノート・リリース済みは変えず、完了やリリースの条件にもしない。
 */

/** 比較単位ごとの判定 */
export const REVIEW_VERDICTS = ["achieved", "partial", "not_achieved", "insufficient"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const REVIEW_VERDICT_LABELS: Record<ReviewVerdict, string> = {
  achieved: "達成",
  partial: "一部達成",
  not_achieved: "未達成",
  insufficient: "判断材料不足",
};

/** 評価の範囲（結果と一緒に保存し、画面・CLI に出す） */
export const REVIEW_SCOPE =
  "保存してあるマイルストーンの目的・予定機能に対して、参照先のリポジトリのコードと git の履歴（抽出のときの作業ツリー・タスクに残したコミット）を読み、" +
  "このマイルストーンに直接属する要望・タスクの記録を手がかりに確かめた結果です。品質基準が設定してあれば、目的の達成とは別に品質基準への適合も確かめています（検査のコマンドは実行していません）。" +
  "テストやアプリを実際に動かしてはいません。公開されたかは確かめていません。" +
  "成果物の URL や添付の中身は読んでいません。アーカイブした要望は含みません。";

/** 読める参照先が無いときの評価の範囲（記録だけの点検で、実装は確かめていない） */
export const REVIEW_SCOPE_RECORDS_ONLY =
  "読める参照先（リポジトリ）が無かったため、保存してあるマイルストーンの目的・予定機能と、直接属する要望・タスクの記録だけを比べた結果です。" +
  "記録は実装した人の自己申告で、実装・実際の動作・公開されたかは確かめていません。成果物の URL や添付の中身は読んでいません。アーカイブした要望は含みません。";

/** 比較単位: 予定機能（G1 ...）。予定機能が無く目的だけなら目的そのもの（id: purpose） */
export interface ReviewUnit {
  id: string;
  text: string;
}

export const PURPOSE_UNIT_ID = "purpose";

/** 材料の警告 */
export type ReviewWarningCode =
  | "unknown_milestone"
  | "broken_request"
  | "broken_task"
  | "no_requests"
  | "missing_record"
  | "no_goals"
  | "no_code"
  | "code_unavailable"
  | "dirty_worktree"
  | "commit_missing"
  | "quality_unset"
  | "quality_invalid";

export interface ReviewWarning {
  code: ReviewWarningCode;
  target: string;
  message: string;
}

export interface ReviewInputTask {
  id: string;
  /** <要望ID>/T001 */
  ref: string;
  title: string;
  status: TaskStatus;
  body: string;
  record?: string;
  /** 成果物（参照の文字列。中身は読まない） */
  outputs: string[];
}

export interface ReviewInputRequest {
  id: string;
  title: string;
  status: RequestStatus;
  body: string;
  /** 親の要望（別のマイルストーンでも文脈として ID だけ） */
  parent?: string;
  /** 直下の子（別のマイルストーンの子は文脈。ここでは数えない） */
  children?: { id: string; milestone?: string; status: RequestStatus }[];
  tasks: ReviewInputTask[];
}

/** 直接は属さないが、親子でつながる要望（文脈。達成の根拠に数えない） */
export interface ReviewContextRequest {
  id: string;
  title: string;
  status: RequestStatus;
  milestone?: string;
  /** 直接属する要望から見た関係 */
  relation: "parent" | "child";
  of: string;
}

/** タスクの成果物に残したコミット（参照先の履歴で見つかるか） */
export interface ReviewCodeCommit {
  sha: string;
  /** 残したタスク（<要望ID>/T001） */
  from: string;
  /** 参照先の履歴にあるか（無ければ Codex は中身を読めない） */
  found: boolean;
}

/**
 * 参照先1つのコードの材料。Codex には /workspace/<mount> に読むだけでマウントする。抽出のときの HEAD・未コミットの変更を固定する
 * （そのとき作業ツリーにあったコードを読んだ、と後から分かるように。中身そのものは保存しない）
 */
export interface ReviewCodeRef {
  name: string;
  mount: string;
  role?: string;
  /** ok: 読める / それ以外: 読めない（理由は reason） */
  status: "ok" | "unregistered" | "missing" | "notdir";
  reason?: string;
  /** git の履歴（ok / shallow: 途中まで / unavailable: 無い） */
  history?: "ok" | "shallow" | "unavailable";
  head?: string;
  branch?: string;
  /** 未コミットの変更があるファイルの数（作業ツリーを読むので、コミットとずれる） */
  dirty?: number;
  /** 未コミットの変更の中身の識別子（差分と追跡していないファイルの中身の hash。中身は保存しない） */
  dirtyDigest?: string;
  commits: ReviewCodeCommit[];
}

/** 固定した比較材料（input.json） */
export interface ReviewInput {
  milestone: { id: string; title: string; due?: string; done?: boolean; known: boolean; purpose?: string; goals?: MilestoneGoal[] };
  /** 比較単位（予定機能。無ければ目的） */
  units: ReviewUnit[];
  requests: ReviewInputRequest[];
  context: ReviewContextRequest[];
  warnings: ReviewWarning[];
  /** 参照先のコードの材料（古い記録には無い） */
  code?: ReviewCodeRef[];
  scope: string;
  /** 抽出の始めと終わり（複数のファイルを同じ時点で読んだとは保証しない） */
  extractedAt: string;
  extractedUntil: string;
  /** 材料の識別子（抽出の日時は含めない） */
  hash: string;
  /** 抽出したときのプロジェクトの品質基準（版つき。古い記録には無い＝品質は評価していない） */
  quality?: QualitySnapshot;
}

export const REVIEW_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = { running: "実行中", completed: "完了", failed: "失敗", cancelled: "取消" };

/** 失敗の種類 */
export type ReviewFailure = "unavailable" | "usage_limit" | "timeout" | "invalid_output" | "crashed" | "error";

/** 実行の記録（run.json） */
export interface ReviewRun {
  id: string;
  milestone: string;
  status: ReviewStatus;
  engine: "codex" | "mock";
  startedAt: string;
  startedBy?: string;
  finishedAt?: string;
  /** 実行しているプロセス（preflight/owner.ts。死んだと確かめられたときだけ回復する） */
  owner?: RunOwner;
  failure?: ReviewFailure;
  error?: string;
  /** 取消の要求（別のプロセスからも書ける。所有者が気づいて止める） */
  cancelRequested?: { at: string; by?: string };
  /** 人が明示して終わりにした（所有者が分からない run。ほかの環境のプロセスを止めたとは限らない） */
  abandoned?: { at: string; by?: string };
  /** input.json の hash */
  inputHash: string;
  /** 終わったときに材料を取り出し直したら、始めたときと違っていた（実行中に要望・タスク・コード・品質基準が変わった） */
  inputChanged?: boolean;
  log: PreflightLogEntry[];
}

/** 比較単位ごとの所見 */
export interface ReviewUnitResult {
  unit: string;
  verdict: ReviewVerdict;
  reason: string;
  /**
   * 根拠。コード: <参照先>:<パス>（行は :12 や :12-30 を付けてよい）・<参照先>@<コミット>。記録: 要望 ID・<要望ID>/T001。
   * どれも材料にあるもの・参照先に実在するものだけ
   */
  evidence: string[];
  /** 不足していること・次に検討すること */
  gaps: string[];
}

/** 目的・予定機能・要望に無い変更（意図しない変更の候補） */
export interface ReviewUnplanned {
  text: string;
  /** 根拠（コードの場所・コミット） */
  evidence: string[];
}

/** 品質の判定（品質基準ごと。目的・予定機能の達成とは別） */
export interface ReviewQualityResult {
  standard: string;
  verdict: QualityVerdict;
  reason: string;
  evidence: string[];
  /** 確かめられなかった範囲 */
  unread?: string;
  /** 品質の低下（過去に満たしていたものを崩した）。履歴（コミット）で裏付けたときだけ */
  regression?: boolean;
}

/** 結果（review.json） */
export interface ReviewResult {
  /** 目的との整合の全体の所見 */
  overall: string;
  units: ReviewUnitResult[];
  /** 品質基準への適合（品質の材料がある run だけ。古い結果には無い＝品質は評価していない） */
  quality?: ReviewQualityResult[];
  /** 意図しない変更の候補（古い記録には無い） */
  unplanned?: ReviewUnplanned[];
  scope: string;
  model?: string;
}

/** 1回分（一覧・取得） */
export interface ReviewRecord {
  run: ReviewRun;
  input?: ReviewInput;
  result?: ReviewResult;
}

/** 一覧の1件（壊れた記録も隠さない） */
export type ReviewListItem =
  | { state: "ok"; run: ReviewRun; units: ReviewUnit[]; purpose?: string; inputHash: string; verdicts?: Partial<Record<ReviewVerdict, number>> }
  | { state: "broken"; id: string; error: string };
