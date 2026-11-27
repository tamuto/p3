import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportError } from "../packages/tasks/src/cli/tasksCli.ts";
import { UsageError } from "../packages/shared/src/node/usage.ts";
import { ConflictError, NotFoundError } from "../packages/tasks/src/core/store/collection.ts";
import { UserConfigError } from "../packages/tasks/src/core/userConfig.ts";
import { SettingsError } from "../packages/tasks/src/core/machineSettings.ts";
import { DataDirError, ProjectNotResolvedError } from "../packages/tasks/src/core/store/locate.ts";
import { ReleaseNoteError } from "../packages/tasks/src/features/releaseNotes/core/store.ts";
import { RetrospectiveError } from "../packages/tasks/src/features/retro/shared/retrospective.ts";
import { GenerationRejected } from "../packages/tasks/src/features/releaseNotes/core/generate.ts";
import { HierarchyError } from "../packages/tasks/src/core/hierarchy.ts";
import { ReviewRejected } from "../packages/tasks/src/features/milestoneReview/core/service.ts";
import { ReviewCancelRefused, ReviewStoreError } from "../packages/tasks/src/core/reviewRuns.ts";
import { TaskReviewRejected } from "../packages/tasks/src/features/taskReview/core/material.ts";
import { ImprovementError } from "../packages/tasks/src/features/quality/core/qualityImprovement.ts";
import { QualityInputError } from "../packages/tasks/src/features/quality/shared/quality.ts";
import { MilestonesConflictError, ProjectInputError, ReloadError } from "../packages/tasks/src/core/store/workspace.ts";
import { OpRuleError } from "../packages/tasks/src/core/requestOps.ts";
import { AcceptanceInputError } from "../packages/tasks/src/features/requirements/shared/acceptance.ts";
import { RequirementInputError } from "../packages/tasks/src/features/requirements/shared/requirementSource.ts";
import { PremiseInputError } from "../packages/tasks/src/features/records/shared/reviewCandidate.ts";
import { BlockInputError } from "../packages/tasks/src/shared/taskBlock.ts";
import { ArchivedTaskReadError } from "../packages/tasks/src/core/store/archivedTasks.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { taskReviewRoutes } from "../packages/tasks/src/features/taskReview/server/taskReviewRoutes.ts";
import { milestoneReviewRoutes } from "../packages/tasks/src/features/milestoneReview/server/milestoneReviewRoutes.ts";
import { releaseNoteRoutes } from "../packages/tasks/src/features/releaseNotes/server/releaseNoteRoutes.ts";
import { makeProject } from "./helpers.ts";

/**
 * エラーから CLI の終了コードと標準エラー、API の HTTP の状態と code への対応（今の契約）。CLI と API の入口の処理をまとめる
 * リファクタリング（261119-vwgf8）の前後で変わらないことを確かめる。0 = 成功・1 = 規則に合わない / 使い方の誤り・2 = 見つからない・
 * 3 = 競合（読み直してやり直す）。API は 400 / 404 / 409 / 422 / 500 / 503 と code
 */

afterEach(() => vi.restoreAllMocks());

/** reportError の終了コードと標準エラーに出した文 */
function cli(e: unknown): { code: number; err: string } {
  let err = "";
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    err += String(s);
    return true;
  });
  const code = reportError(e);
  vi.restoreAllMocks();
  return { code, err };
}

describe("CLI: エラー → 終了コードと標準エラー", () => {
  const cases: [string, unknown, number, RegExp][] = [
    ["版の競合", new ConflictError("R1", 1, 2), 3, /^競合: R1: rev conflict（?.*最新を取得してやり直してください\n$/],
    ["見つからない", new NotFoundError("T9"), 2, /^見つかりません: T9\n$/],
    ["個人設定が読めない", new UserConfigError("個人設定が壊れています"), 1, /^個人設定が壊れています\n$/],
    ["マシンごとの設定が読めない", new SettingsError("P3_X が読めません"), 1, /^設定: P3_X が読めません\n$/],
    ["プロジェクトが決まらない", new ProjectNotResolvedError("決まりません"), 1, /^決まりません\n$/],
    ["データのフォルダが無い", new DataDirError("ありません"), 1, /^ありません\n$/],
    ["リリースノートが無い", new ReleaseNoteError("not_found", "v1", "無い"), 2, /^無い\n$/],
    ["リリースノートの版の競合", new ReleaseNoteError("conflict", "v1", "変わった"), 3, /^競合: 変わった\n$/],
    ["リリースノートが既にある", new ReleaseNoteError("exists", "v1", "ある"), 3, /^ある\n$/],
    ["リリースノートが読めない", new ReleaseNoteError("invalid", "v1", "読めない"), 1, /^読めない\n$/],
    ["振り返りの版の競合", new RetrospectiveError("retro_conflict", "変わった"), 3, /^競合: 変わった\n$/],
    ["振り返りの規則", new RetrospectiveError("retro_invalid", "理由が無い"), 1, /^理由が無い\n$/],
    ["要約を始められない", new GenerationRejected("running", "実行中"), 1, /^実行中\n$/],
    ["親子のロックを取れない", new HierarchyError("hierarchy_busy", "使用中"), 3, /^使用中\n$/],
    ["子の集合が変わった", new HierarchyError("child_order_invalid", "子でない", { reason: "not_child" }), 3, /^子でない\n$/],
    ["子の並びの規則", new HierarchyError("child_order_invalid", "重複", { reason: "duplicate" }), 1, /^重複\n$/],
    ["子のある要望", new HierarchyError("has_children", "子がある"), 1, /^子がある\n$/],
    ["マイルストーンが無い（レビュー）", new ReviewRejected("unknown_milestone", "無い"), 2, /^無い\n$/],
    ["レビューが実行中", new ReviewRejected("running", "実行中", "R1"), 3, /^実行中\n$/],
    ["目的が無い（レビュー）", new ReviewRejected("no_goals", "目的なし"), 1, /^目的なし\n$/],
    ["レビューの run が無い", new ReviewStoreError("not_found", "無い"), 2, /^無い\n$/],
    ["レビューの run が終わっている", new ReviewStoreError("finished", "終わった"), 3, /^終わった\n$/],
    ["レビューの run が読めない", new ReviewStoreError("broken", "壊れた"), 1, /^壊れた\n$/],
    ["取り消せない（所有者が動いている）", new ReviewCancelRefused("owner_alive", "動いている"), 3, /^動いている\n$/],
    ["タスクのレビューが実行中", new TaskReviewRejected("running", "実行中"), 3, /^実行中\n$/],
    ["タスクのレビューの材料が変わった", new TaskReviewRejected("material_changed", "変わった"), 3, /^変わった\n$/],
    ["タスクが未完了（レビュー）", new TaskReviewRejected("not_done", "未完了"), 1, /^未完了\n$/],
    ["改善要望が無い", new ImprovementError("not_found", "無い"), 2, /^無い\n$/],
    ["改善要望の診断が変わった", new ImprovementError("diagnosis_changed", "変わった"), 3, /^変わった\n$/],
    ["改善要望の登録先がある", new ImprovementError("existing", "ある"), 3, /^ある\n$/],
    ["改善要望の規則", new ImprovementError("invalid", "不正"), 1, /^不正\n$/],
    ["品質基準の版の競合", new QualityInputError("quality_conflict", "変わった"), 3, /^変わった\n$/],
    ["品質基準の規則", new QualityInputError("quality_invalid", "不正"), 1, /^不正\n$/],
    ["マイルストーンの版の競合", new MilestonesConflictError("a", "b"), 3, /^競合: マイルストーンが他で変わりました/],
    ["使い方の誤り（前置きなし）", new UsageError("使い方"), 1, /^使い方\n$/],
    ["操作の規則（前置きなし）", new OpRuleError("できない"), 1, /^できない\n$/],
    ["プロジェクトの入力（前置きなし）", new ProjectInputError("不正"), 1, /^不正\n$/],
    ["受け入れ基準の入力（前置きなし）", new AcceptanceInputError("不正"), 1, /^不正\n$/],
    ["要求の根拠の入力（前置きなし）", new RequirementInputError("不正"), 1, /^不正\n$/],
    ["前提の入力（前置きなし）", new PremiseInputError("不正"), 1, /^不正\n$/],
    ["停止の入力（前置きなし）", new BlockInputError("block_invalid", "不正"), 1, /^不正\n$/],
    ["そのほかの失敗（エラー: を付ける）", new Error("想定外"), 1, /^エラー: 想定外\n$/],
  ];
  it.each(cases)("%s", (_name, e, code, err) => {
    const r = cli(e);
    expect(r.code).toBe(code);
    expect(r.err).toMatch(err);
  });
});

/** API のアプリ（毎回作り直す。Hono は最初の要求の後に道を足せない）に、渡したエラーを投げるだけの道を足して、そのアプリの onError の応答を見る */
async function api(make: () => Hono, e: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const app = make();
  const path = "/__contract";
  app.get(path, () => {
    throw e;
  });
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("API: エラー → HTTP の状態と code", () => {
  it("要望・タスク・Preflight・設定の API（routes.ts）", async () => {
    const { ctx } = await makeProject();
    const app = () => apiRoutes(ctx);
    const cases: [unknown, number, string | undefined][] = [
      [new NotFoundError("T9"), 404, undefined],
      [new ConflictError("R9", 1, 2), 409, "rev_conflict"],
      [new HierarchyError("has_children", "子がある"), 409, "has_children"],
      [new MilestonesConflictError("a", "b"), 409, "milestones_conflict"],
      [new AcceptanceInputError("不正"), 400, "acceptance_invalid"],
      [new RequirementInputError("不正"), 400, "requirement_invalid"],
      [new PremiseInputError("不正"), 400, "premise_invalid"],
      [new RetrospectiveError("retro_invalid", "不正"), 400, "retro_invalid"],
      [new RetrospectiveError("retro_conflict", "変わった"), 409, "retro_conflict"],
      [new BlockInputError("blocked", "止まっている"), 409, "blocked"],
      [new BlockInputError("block_invalid", "不正"), 400, "block_invalid"],
      [new QualityInputError("quality_conflict", "変わった"), 409, "quality_conflict"],
      [new QualityInputError("quality_invalid", "不正"), 400, "quality_invalid"],
      [new ImprovementError("not_found", "無い"), 404, "not_found"],
      [new ImprovementError("existing", "ある", { request: "R1", keys: ["k"] }), 409, "existing"],
      [new ImprovementError("invalid", "不正"), 400, "invalid"],
      [new UserConfigError("壊れた"), 500, undefined],
      [new ReloadError("読めない"), 503, undefined],
      [new ArchivedTaskReadError("読めない"), 500, "archive_unreadable"],
      [new Error("想定外"), 400, undefined],
    ];
    for (const [e, status, code] of cases) {
      const r = await api(app, e);
      expect([r.status, r.body.code], (e as Error).constructor.name).toEqual([status, code]);
      expect(typeof r.body.error).toBe("string");
    }
    // 改善要望の登録先・競合のときの今の値は応答に添える
    expect((await api(app, new ImprovementError("existing", "ある", { request: "R1", keys: ["k"] }))).body.existing).toEqual({ request: "R1", keys: ["k"] });
  });

  it("タスクの AI レビュー・マイルストーンレビュー・リリースノートの API", async () => {
    const { ctx } = await makeProject();
    const task = () => taskReviewRoutes(ctx);
    for (const [e, status, code] of [
      [new NotFoundError("T9"), 404, "not_found"],
      [new ReviewStoreError("not_found", "無い"), 404, "not_found"],
      [new ReviewStoreError("bad_id", "不正"), 400, "bad_id"],
      [new ReviewStoreError("broken", "壊れた"), 422, "broken"],
      [new ReviewStoreError("exists", "ある"), 409, "exists"],
      [new TaskReviewRejected("running", "実行中", "R1"), 409, "running"],
      [new TaskReviewRejected("not_done", "未完了"), 400, "not_done"],
      [new ReviewCancelRefused("owner_alive", "動いている"), 409, "owner_alive"],
    ] as [unknown, number, string][]) {
      const r = await api(task, e);
      expect([r.status, r.body.code], (e as Error).message).toEqual([status, code]);
    }
    expect((await api(task, new TaskReviewRejected("running", "実行中", "R1"))).body.run).toBe("R1");
    const milestone = () => milestoneReviewRoutes(ctx);
    for (const [e, status, code] of [
      [new ReviewRejected("unknown_milestone", "無い"), 404, "unknown_milestone"],
      [new ReviewRejected("running", "実行中", "R1"), 409, "running"],
      [new ReviewRejected("material_changed", "変わった"), 409, "material_changed"],
      [new ReviewRejected("no_goals", "目的なし"), 400, "no_goals"],
      [new ReviewStoreError("broken", "壊れた"), 422, "broken"],
    ] as [unknown, number, string][]) {
      const r = await api(milestone, e);
      expect([r.status, r.body.code], (e as Error).message).toEqual([status, code]);
    }
    const notes = () => releaseNoteRoutes(ctx);
    for (const [e, status, code] of [
      [new ReleaseNoteError("not_found", "v1", "無い"), 404, "not_found"],
      [new ReleaseNoteError("bad_id", "v1", "不正"), 400, "bad_id"],
      [new ReleaseNoteError("invalid", "v1", "読めない"), 422, "invalid"],
      [new ReleaseNoteError("conflict", "v1", "変わった"), 409, "rev_conflict"],
      [new GenerationRejected("running", "実行中"), 409, "running"],
      [new GenerationRejected("no_material", "材料なし"), 400, "no_material"],
    ] as [unknown, number, string][]) {
      const r = await api(notes, e);
      expect([r.status, r.body.code], (e as Error).message).toEqual([status, code]);
    }
    expect((await api(notes, new ReleaseNoteError("exists", "v1", "ある"))).body).toMatchObject({ code: "rev_conflict", reason: "exists", current: null });
  });
});
