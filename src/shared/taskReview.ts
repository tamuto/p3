import type { AcceptanceCriterion, AcceptanceEvidence, CriterionState } from "./acceptance.ts";
import type { PreflightLogEntry, RequestStatus, RunOwner, TaskStatus } from "./types.ts";

/**
 * タスクの AI レビューの形（CLI・API・画面で共有する）。規則は core/taskReview/。
 *
 * レビューは、完了したタスクの本文・受け入れ基準に対して、比較対象（固定したコミットの差分と、その前後のコード）が基準を
 * 満たしているかを、作業したのとは別の Codex のスレッドが読むだけで確かめる参考の記録。作業した AI の能力・成績の評価ではない。
 * 作業した側の証拠（acceptanceEvidence）は申告として材料に入れるが、判定には変えない。結果はタスクの状態・済み・基準・証拠・
 * 要望の状態を変えず、済みの条件にもしない（済みは人が決める）。
 */

/** 比較項目ごとの判定 */
export const TASK_REVIEW_VERDICTS = ["satisfied", "missing", "undetermined"] as const;
export type TaskReviewVerdict = (typeof TASK_REVIEW_VERDICTS)[number];
export const TASK_REVIEW_VERDICT_LABELS: Record<TaskReviewVerdict, string> = {
  satisfied: "満たしている",
  missing: "不足",
  undetermined: "判断できない",
};

/** 比較項目: 受け入れ基準（A1 ...）。基準が無ければ本文から取り出した項目（B1 ...）と元の段落 */
export interface TaskReviewItem {
  id: string;
  kind: "criterion" | "body";
  text: string;
  /** 本文から取り出した項目の元の段落 */
  source?: string;
}

/** 比較対象の変更1件（固定した2つの tree の差分） */
export interface TaskReviewChange {
  /** git の変更の種類（A 追加 / M 変更 / D 削除 / R 名前の変更 / C 複製 / T 種類の変更） */
  status: "A" | "M" | "D" | "R" | "C" | "T";
  path: string;
  oldPath?: string;
  binary?: boolean;
  /** submodule（中は追わない） */
  submodule?: boolean;
  /** シンボリックリンク（指す先は追わない） */
  symlink?: boolean;
  /** 材料に取り出した前後のファイル（材料のフォルダの中の相対パス）。無ければ取り出していない（omitted に理由） */
  baseFile?: string;
  headFile?: string;
}

/** 比較対象の1組（差分の両側） */
export interface TaskReviewDiff {
  /** 差分の前（親・merge-base・ルートなら空の tree） */
  base: string;
  head: string;
  /** 差分の本文（材料のフォルダの中の相対パス） */
  patchFile: string;
  changes: TaskReviewChange[];
}

/** 比較対象のコミット */
export interface TaskReviewCommit {
  sha: string;
  parents: string[];
  subject: string;
  /** メッセージにある、このタスク以外のタスクの参照（他のタスクの作業が混ざっている手がかり） */
  otherTasks: string[];
}

/** 参照先ごとの比較対象（正規化したもの） */
export interface TaskReviewTarget {
  repo: string;
  /** commits: 指定したコミットの集合（それぞれ親との差分）/ range: base..head（merge-base からの差分） */
  kind: "commits" | "range";
  /** どこから決めたか（指定の文字列・成果物） */
  sources: string[];
  commits: TaskReviewCommit[];
  /** range のとき */
  range?: { base: string; head: string; mergeBase: string; baseSpec: string; headSpec: string };
  diffs: TaskReviewDiff[];
}

/** 観点の出典。builtin: 既定だけ / file: 参照先の固定した SHA のファイル / project: プロジェクトの設定（project.yaml の taskReview.viewpoints） */
export interface TaskReviewViewpoint {
  source: "builtin" | "file" | "project";
  text: string;
  repo?: string;
  sha?: string;
  path?: string;
  hash: string;
}

export type TaskReviewNoteCode =
  | "no_criteria"
  | "broken_acceptance"
  | "stale_evidence"
  | "orphan_evidence"
  | "no_evidence"
  | "no_record"
  | "no_outputs"
  | "pr_unresolved"
  | "other_tasks"
  | "omitted"
  | "shallow";

/** 材料の注意（黙って満たしているにしないため、無いもの・読めないもの・取り出していないものを残す） */
export interface TaskReviewNote {
  code: TaskReviewNoteCode;
  target: string;
  message: string;
}

/** 材料のフォルダに取り出したファイル（中身は別に保存する） */
export interface TaskReviewFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** 固定した材料（input.json）。作ったら変えない */
export interface TaskReviewInput {
  version: 1;
  request: { id: string; title: string; status: RequestStatus; body: string };
  task: {
    id: string;
    ref: string;
    title: string;
    status: TaskStatus;
    body: string;
    record?: string;
    outputs: string[];
    criteria?: AcceptanceCriterion[];
    /** 作業した側の申告（判定ではない） */
    evidence?: AcceptanceEvidence[];
    /** 基準ごとの今の状態（missing: 証拠なし / stale: 基準を変えた後の古い証拠） */
    evidenceStates?: { id: string; state: CriterionState }[];
    acceptanceProblems?: string[];
  };
  items: TaskReviewItem[];
  targets: TaskReviewTarget[];
  viewpoint: TaskReviewViewpoint;
  notes: TaskReviewNote[];
  files: TaskReviewFile[];
  extractedAt: string;
  /** 材料の識別子（抽出の日時を含めない。同じ文面・基準・証拠・対象の SHA・観点なら同じ） */
  hash: string;
}

export const TASK_REVIEW_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type TaskReviewStatus = (typeof TASK_REVIEW_STATUSES)[number];
export type TaskReviewFailure = "unavailable" | "usage_limit" | "timeout" | "invalid_output" | "crashed" | "error";

export interface TaskReviewRun {
  id: string;
  request: string;
  task: string;
  status: TaskReviewStatus;
  engine: "codex" | "mock";
  model?: string;
  startedAt: string;
  finishedAt?: string;
  startedBy?: string;
  owner?: RunOwner;
  inputHash: string;
  failure?: TaskReviewFailure;
  error?: string;
  cancelRequested?: { at: string; by?: string };
  abandoned?: { at: string; by?: string };
  log: PreflightLogEntry[];
}

export interface TaskReviewItemResult {
  item: string;
  verdict: TaskReviewVerdict;
  reason: string;
  /** 根拠（"<参照先>@<sha>:<パス>[:行]" / "<参照先>@<sha>" / 材料のファイル / 比較項目・タスクの参照） */
  evidence: string[];
  gaps: string[];
}

export interface TaskReviewResult {
  overall: string;
  items: TaskReviewItemResult[];
  /** 意図しない変更の候補 */
  unplanned: { text: string; evidence: string[] }[];
  /** 人が確かめる点（基準の矛盾・本文の追加の要件など） */
  checks: string[];
  /** 読めた範囲と読めなかった範囲 */
  coverage: { read: string; unread: string };
  model?: string;
}

export interface TaskReviewRecord {
  run: TaskReviewRun;
  input: TaskReviewInput;
  result?: TaskReviewResult;
}

export type TaskReviewListItem =
  | { state: "ok"; run: TaskReviewRun; inputHash: string; items: number; verdicts?: Partial<Record<TaskReviewVerdict, number>> }
  | { state: "broken"; id: string; error: string };

/** 評価の範囲（結果と一緒に出す） */
export const TASK_REVIEW_SCOPE =
  "完了したタスクの本文・受け入れ基準に対して、固定したコミットの差分とその前後のコード（抽出した材料）を読んで確かめた参考の記録です。" +
  "作業した AI の能力や成績の評価ではありません。テストやアプリは動かしていません。作業した側の証拠は申告として読み、判定には変えていません。";

/** プレビューで返す材料の要約（材料のファイルの中身は返さない） */
export function previewOf(input: TaskReviewInput) {
  return {
    task: { ref: input.task.ref, title: input.task.title, status: input.task.status, record: !!input.task.record, outputs: input.task.outputs },
    items: input.items,
    evidenceStates: input.task.evidenceStates ?? [],
    acceptanceProblems: input.task.acceptanceProblems ?? [],
    targets: input.targets.map((t) => ({
      repo: t.repo,
      kind: t.kind,
      sources: t.sources,
      commits: t.commits.map((c) => ({ sha: c.sha, subject: c.subject, otherTasks: c.otherTasks })),
      ...(t.range ? { range: t.range } : {}),
      changes: t.diffs.reduce((n, d) => n + d.changes.length, 0),
    })),
    viewpoint: { source: input.viewpoint.source, ...(input.viewpoint.repo ? { repo: input.viewpoint.repo, sha: input.viewpoint.sha, path: input.viewpoint.path } : {}), hash: input.viewpoint.hash },
    notes: input.notes,
    files: input.files.length,
    hash: input.hash,
    extractedAt: input.extractedAt,
  };
}
