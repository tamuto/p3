import { UsageError } from "@infodb/p3-kit/usage.ts";
import { AcceptanceInputError } from "../shared/acceptance.ts";
import { MetricsError } from "../shared/metrics.ts";
import { QualityInputError } from "../shared/quality.ts";
import { RequirementInputError } from "../shared/requirementSource.ts";
import { RetrospectiveError } from "../shared/retrospective.ts";
import { PremiseInputError } from "../shared/reviewCandidate.ts";
import { BlockInputError } from "../shared/taskBlock.ts";
import { HierarchyError } from "./hierarchy.ts";
import { SettingsError } from "./machineSettings.ts";
import { ReviewRejected } from "./milestoneReview/service.ts";
import { StaleInputError } from "./preflight/input.ts";
import { ChildConflictError, ChildDraftsChangedError, DraftConflictError } from "./preflight/service.ts";
import { ImprovementError } from "./qualityImprovement.ts";
import { CompletionRejected } from "./releaseNotes/completeRequests.ts";
import { GenerationRejected } from "./releaseNotes/generate.ts";
import { ReleaseNoteError } from "./releaseNotes/store.ts";
import { OpRuleError } from "./requestOps.ts";
import { ReviewCancelRefused, ReviewStoreError } from "./reviewRuns.ts";
import { ArchivedTaskReadError } from "./store/archivedTasks.ts";
import { ConflictError, NotFoundError } from "./store/collection.ts";
import { DataDirError, ProjectNotResolvedError } from "./store/locate.ts";
import { MilestonesConflictError, ProjectInputError, ReloadError } from "./store/workspace.ts";
import { TaskReviewRejected } from "./taskReview/material.ts";
import { UserConfigError } from "./userConfig.ts";

/**
 * エラーから CLI の終了コード・標準エラーと、API の HTTP の状態・応答への対応（1 か所の表）。CLI（cli/tasksCli.ts の reportError）と
 * API（server/api の各 onError）はこれを写すだけにする。終了コードは 1 = 規則に合わない / 使い方の誤り・2 = 見つからない・3 = 競合
 * （読み直してやり直す）。表に無い・その入口の値が無いエラーは、CLI は「エラー: 」を付けて 1、API は 400（と console.error）。
 * 競合の今の値（要望・タスク・リリースノート）は、その場で読む必要があるので API の各アプリが先に扱う。契約は test/errorContract.test.ts
 */
export interface ErrorOutcome {
  /** CLI の終了コード（無ければ「エラー: 」を付けて 1） */
  exit?: 1 | 2 | 3;
  /** CLI の標準エラーの文（無ければ message）。前置きの無い文にするときも書く */
  cli?: string;
  /** API の状態（無ければ 400 と console.error） */
  status?: 400 | 404 | 409 | 422 | 500 | 503;
  /** API の応答に添える項目（error は message、code があれば code） */
  body?: Record<string, unknown>;
}

const conflict = (e: Error) => `競合: ${e.message}`;

export function errorOutcome(e: unknown): ErrorOutcome | undefined {
  if (!(e instanceof Error)) return undefined;
  const coded = (status: ErrorOutcome["status"], code: string, extra: Record<string, unknown> = {}) => ({ status, body: { code, ...extra } });
  if (e instanceof ConflictError) return { exit: 3, cli: `競合: ${e.message}。最新を取得してやり直してください`, status: 409, body: { code: "rev_conflict" } };
  if (e instanceof NotFoundError) return { exit: 2, cli: `見つかりません: ${e.id}`, status: 404 };
  if (e instanceof UserConfigError) return { exit: 1, cli: e.message, status: 500 };
  if (e instanceof SettingsError) return { exit: 1, cli: `設定: ${e.message}` };
  if (e instanceof ProjectNotResolvedError || e instanceof DataDirError) return { exit: 1, cli: e.message };
  if (e instanceof ReleaseNoteError) {
    const exit = e.code === "not_found" ? 2 : e.code === "conflict" || e.code === "exists" ? 3 : 1;
    const cli = e.code === "conflict" ? conflict(e) : e.message;
    if (e.code === "not_found") return { exit, cli, ...coded(404, "not_found") };
    if (e.code === "bad_id") return { exit, cli, ...coded(400, "bad_id") };
    if (e.code === "invalid") return { exit, cli, ...coded(422, "invalid") };
    return { exit, cli, ...coded(409, "rev_conflict", { reason: e.code }) };
  }
  if (e instanceof MetricsError) return { exit: e.code === "metrics_conflict" ? 3 : 1, cli: e.code === "metrics_conflict" ? conflict(e) : e.message, ...coded(400, e.code) };
  if (e instanceof RetrospectiveError) return { exit: e.code === "retro_conflict" ? 3 : 1, cli: e.code === "retro_conflict" ? conflict(e) : e.message, ...coded(e.code === "retro_invalid" ? 400 : 409, e.code) };
  if (e instanceof GenerationRejected) return { exit: 1, cli: e.message, ...coded(e.code === "running" ? 409 : 400, e.code) };
  if (e instanceof CompletionRejected) return { ...coded(409, e.code, { plan: e.plan }) };
  if (e instanceof HierarchyError) {
    // 子の表示順を読んだ後に子の集合が変わった・ロックを取れない → 3（読み直してやり直す）
    const changedSet = e.code === "child_order_invalid" && (e.detail.reason === "not_child" || e.detail.reason === "missing");
    return { exit: e.code === "hierarchy_busy" || changedSet ? 3 : 1, cli: e.message, ...coded(409, e.code, { ...e.detail }) };
  }
  if (e instanceof ReviewRejected) {
    const exit = e.code === "unknown_milestone" ? 2 : e.code === "running" ? 3 : 1;
    const status = e.code === "running" || e.code === "material_changed" ? 409 : e.code === "unknown_milestone" ? 404 : 400;
    return { exit, cli: e.message, ...coded(status, e.code, e.running ? { run: e.running } : {}) };
  }
  if (e instanceof ReviewStoreError) {
    const exit = e.code === "not_found" ? 2 : e.code === "finished" || e.code === "exists" ? 3 : 1;
    const status = e.code === "not_found" ? 404 : e.code === "bad_id" ? 400 : e.code === "broken" ? 422 : 409;
    return { exit, cli: e.message, ...coded(status, e.code) };
  }
  if (e instanceof ReviewCancelRefused) return { exit: 3, cli: e.message, ...coded(409, e.code) };
  if (e instanceof TaskReviewRejected) {
    const busy = e.code === "running" || e.code === "material_changed";
    return { exit: busy ? 3 : 1, cli: e.message, ...coded(busy ? 409 : 400, e.code, e.running ? { run: e.running } : {}) };
  }
  if (e instanceof ImprovementError) {
    const busy = e.code === "diagnosis_changed" || e.code === "existing" || e.code === "closed_existing";
    return { exit: e.code === "not_found" ? 2 : busy ? 3 : 1, cli: e.message, ...coded(e.code === "not_found" ? 404 : busy ? 409 : 400, e.code, e.existing ? { existing: e.existing } : {}) };
  }
  if (e instanceof QualityInputError) return { exit: e.code === "quality_conflict" ? 3 : 1, cli: e.message, ...coded(e.code === "quality_conflict" ? 409 : 400, e.code) };
  if (e instanceof MilestonesConflictError) return { exit: 3, cli: conflict(e), ...coded(409, e.code, { milestonesVersion: e.current }) };
  // 規則に合わない入力（何も書いていない）。CLI は前置きなし
  if (e instanceof AcceptanceInputError || e instanceof RequirementInputError || e instanceof PremiseInputError) return { exit: 1, cli: e.message, ...coded(400, e.code) };
  if (e instanceof BlockInputError) return { exit: 1, cli: e.message, ...coded(e.code === "blocked" ? 409 : 400, e.code) };
  if (e instanceof UsageError || e instanceof OpRuleError || e instanceof ProjectInputError) return { exit: 1, cli: e.message };
  // Preflight の案・子の案・評価対象（API だけ。409 は code で分ける: rev_conflict は読み直してやり直す / stale_input は評価のあとで要望が変わった）
  if (e instanceof DraftConflictError || e instanceof ChildConflictError) return { ...coded(409, "rev_conflict", { current: e.current }) };
  if (e instanceof ChildDraftsChangedError) return { ...coded(409, e.code) };
  if (e instanceof StaleInputError) return { ...coded(409, e.code, { inputMatch: e.match }) };
  if (e instanceof ReloadError) return { status: 503 };
  if (e instanceof ArchivedTaskReadError) return { ...coded(500, e.code) };
  return undefined;
}

/** CLI: 標準エラーに出し、終了コードを返す */
export function cliExit(e: unknown, write: (s: string) => void): number {
  const o = errorOutcome(e);
  if (o?.exit) {
    write(`${o.cli ?? (e as Error).message}\n`);
    return o.exit;
  }
  write(`エラー: ${(e as Error).message}\n`);
  return 1;
}

/** API: 応答の状態と本文（表に無ければ undefined。各アプリが 400 と console.error で返す） */
export function apiError(e: unknown): { status: NonNullable<ErrorOutcome["status"]>; body: Record<string, unknown> } | undefined {
  const o = errorOutcome(e);
  if (!o?.status) return undefined;
  return { status: o.status, body: { error: (e as Error).message, ...o.body } };
}
