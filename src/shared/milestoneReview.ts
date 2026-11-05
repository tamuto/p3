import type { MilestoneGoal, PreflightLogEntry, RequestStatus, RunOwner, TaskStatus } from "./types.ts";

/**
 * マイルストーンレビューの形（CLI・API・画面で共有する）。保存の規則は core/milestoneReview/。
 *
 * レビューは、保存してあるマイルストーンの目的・予定機能と、所属する要望・タスクの記録（本文・状態・変更の記録・成果物の参照）を
 * 比べて、目的がどこまで果たせているかを読む参考の記録。ソースコードの妥当性・実際の動作・公開されたかは確かめない。
 * 要望の状態・リリースノート・リリース済みは変えず、完了やリリースの条件にもしない。
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
  "保存してあるマイルストーンの目的・予定機能と、このマイルストーンに直接属する要望・タスクの記録（本文・状態・変更の記録・成果物の参照の文字列）を比べた結果です。" +
  "ソースコードの妥当性・実際の動作・公開されたかは確かめていません。成果物の URL や添付の中身は読んでいません。アーカイブした要望は含みません。";

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
  | "no_goals";

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

/** 固定した比較材料（input.json） */
export interface ReviewInput {
  milestone: { id: string; title: string; due?: string; done?: boolean; known: boolean; purpose?: string; goals?: MilestoneGoal[] };
  /** 比較単位（予定機能。無ければ目的） */
  units: ReviewUnit[];
  requests: ReviewInputRequest[];
  context: ReviewContextRequest[];
  warnings: ReviewWarning[];
  scope: string;
  /** 抽出の始めと終わり（複数のファイルを同じ時点で読んだとは保証しない） */
  extractedAt: string;
  extractedUntil: string;
  /** 材料の識別子（抽出の日時は含めない） */
  hash: string;
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
  log: PreflightLogEntry[];
}

/** 比較単位ごとの所見 */
export interface ReviewUnitResult {
  unit: string;
  verdict: ReviewVerdict;
  reason: string;
  /** 根拠（要望 ID・<要望ID>/T001。input にあるものだけ） */
  evidence: string[];
  /** 不足していること・次に検討すること */
  gaps: string[];
}

/** 結果（review.json） */
export interface ReviewResult {
  /** 目的との整合の全体の所見 */
  overall: string;
  units: ReviewUnitResult[];
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
