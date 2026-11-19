import type { Request } from "./types.ts";

/** 品質の改善要望の診断の形（CLI・API・画面で共有する。規則は core/qualityImprovement.ts） */

export type ImprovementSource = { type: "project" } | { type: "task-review"; request: string; task: string; run: string } | { type: "milestone-review"; milestone: string; run: string };

export type FindingKind = "unset" | "invalid" | "violated" | "undetermined" | "exempt";

export interface ImprovementFinding {
  /** 不足を識別する鍵（品質 ID・対象・不足の種類） */
  key: string;
  kind: FindingKind;
  quality?: string;
  qualityText?: string;
  check?: string;
  /** 品質基準の版 */
  version: string;
  /** 対象（project / task:<要望>/<T> / milestone:<ID>） */
  target: string;
  reason: string;
  evidence: string[];
  /** 既定で選ぶか（除外は選ばない） */
  suggested: boolean;
}

export interface ImprovementDiagnosis {
  source: ImprovementSource;
  findings: ImprovementFinding[];
  /** 診断の版（登録の直前に照らす） */
  hash: string;
  /** 不足ごとの今の登録先（開いている・閉じた要望） */
  registered: Record<string, { request: string; title?: string; status?: Request["status"] }>;
  notes: string[];
}

