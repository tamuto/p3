import type { PreflightRun } from "../../shared/types.ts";

/**
 * Preflight の工程の表示（文脈選定 → 評価・細分化 → レビュー → タスク化）。
 *   done: 済んだ工程（緑） / current: 今の工程（青。失敗なら failed で赤） / todo: まだ（灰）
 * current は今いる工程（名前を太字にし、狭い画面でも名前を出す）。タスク化まで済めば最後の工程が done かつ current。
 */
export const PREFLIGHT_STEPS = ["文脈選定", "評価・細分化", "レビュー", "タスク化"] as const;

export interface StepView {
  label: (typeof PREFLIGHT_STEPS)[number];
  state: "done" | "current" | "failed" | "todo";
  current: boolean;
}

export function preflightSteps(run: Pick<PreflightRun, "status" | "log" | "materialized">): StepView[] {
  const step = run.status === "running" ? (run.log.length > 1 ? 2 : 1) : run.materialized?.length ? 4 : run.status === "completed" ? 3 : 2;
  return PREFLIGHT_STEPS.map((label, i) => {
    const n = i + 1;
    const state: StepView["state"] = n < step || (n === step && step === 4) ? "done" : n === step ? (run.status === "failed" ? "failed" : "current") : "todo";
    return { label, state, current: n === step };
  });
}
