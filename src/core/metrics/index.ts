import { MetricsError, type MetricNotice, type MetricScope, type MetricScopeOption, type MetricsReport } from "../../shared/metrics.ts";
import type { P3Context } from "../context.ts";
import { METRIC_DEFINITIONS, selectTaskReview, type MetricsInput, type ReviewObservation } from "./definitions.ts";

/**
 * 開発の指標の集計（定義は definitions.ts）。CLI の p3 metrics と API の GET /api/metrics が同じこれを使う。
 *
 *   - 範囲: プロジェクト全体はマイルストーンなし・登録に無いマイルストーンの要望も含む。マイルストーンは project.yaml に登録済みのものだけで、
 *     要望の今の milestone が一致する要望（直接の所属）。どちらも見送り・アーカイブの要望は除く
 *   - 読めない要望のファイルは所属が分からないので、全体の知らせ（notices）にする
 *   - 読むだけで何も書かない
 */

export function metricScopes(ctx: P3Context): MetricScopeOption[] {
  return [{ scope: { kind: "project" }, label: "プロジェクト全体" }, ...ctx.ws.project.milestones.map((m) => ({ scope: { kind: "milestone" as const, id: m.id }, label: `${m.id} ${m.title}`.trim() }))];
}

/** CLI・API の入力（マイルストーン ID。省けばプロジェクト全体）から範囲を決める */
export function metricScopeOf(ctx: P3Context, milestone: string | undefined): MetricScope {
  if (milestone === undefined || milestone === "") return { kind: "project" };
  if (!ctx.ws.project.milestones.some((m) => m.id === milestone)) {
    throw new MetricsError(`マイルストーン ${milestone} は登録されていません（p3 milestone ls で確かめてください）`);
  }
  return { kind: "milestone", id: milestone };
}

/** 今完了しているタスクのレビューを、selectTaskReview の規則で1件選んで読む（読むだけ） */
async function reviewsOf(ctx: P3Context, rid: string, tasks: readonly { id: string; status: string }[]): Promise<Record<string, ReviewObservation>> {
  const out: Record<string, ReviewObservation> = {};
  for (const t of tasks) {
    if (t.status !== "done") continue;
    const key = `${rid}/${t.id}`;
    try {
      const sel = selectTaskReview(await ctx.ws.taskReviews.list(key));
      if (sel.state !== "ok") out[t.id] = sel;
      else {
        const rec = await ctx.ws.taskReviews.get(key, sel.run);
        out[t.id] = rec.result ? { state: "ok", run: sel.run, result: rec.result } : { state: "missing", reason: `${sel.run} の結果がありません` };
      }
    } catch (e) {
      out[t.id] = { state: "missing", reason: `レビューの記録が読めません: ${(e as Error).message}` };
    }
  }
  return out;
}

export async function metricsInput(ctx: P3Context, scope: MetricScope): Promise<MetricsInput> {
  const requests = ctx.ws.requests
    .list()
    .filter((r) => r.status !== "rejected" && (scope.kind === "project" || r.milestone === scope.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    requests: await Promise.all(
      requests.map(async (request) => {
        const col = ctx.ws.tasksOf(request.id);
        const tasks = col.list();
        return { request, tasks, brokenTasks: [...col.errors.keys()].sort(), reviews: await reviewsOf(ctx, request.id, tasks) };
      }),
    ),
  };
}

export async function metricsReport(ctx: P3Context, scope: MetricScope = { kind: "project" }): Promise<MetricsReport> {
  const input = await metricsInput(ctx, scope);
  const notices: MetricNotice[] = [...ctx.ws.requests.errors.entries()].map(([id, e]) => ({
    code: "broken_request",
    target: `requests/${id}/request.md`,
    message: `要望のファイルが読めないため、範囲に入るか分からず数えていません: ${e}`,
  }));
  const m = scope.kind === "milestone" ? ctx.ws.project.milestones.find((x) => x.id === scope.id) : undefined;
  return {
    scope,
    scopeLabel: scope.kind === "project" ? "プロジェクト全体" : `${scope.id} ${m?.title ?? ""}`.trim(),
    scopeRule:
      scope.kind === "project"
        ? "すべての要望（マイルストーンなしを含む）。見送り・アーカイブは除く"
        : `マイルストーン ${scope.id} に今直接属する要望。見送り・アーカイブは除く（親子が別のマイルストーンならそれぞれの所属で数える）`,
    generatedAt: new Date().toISOString(),
    metrics: METRIC_DEFINITIONS.map(({ compute, ...def }) => ({ ...def, ...compute(input) })),
    notices,
    scopes: metricScopes(ctx),
  };
}
