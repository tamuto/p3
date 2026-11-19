import { MetricsError, type MetricNotice, type MetricScope, type MetricScopeOption, type MetricsReport } from "../shared/metrics.ts";
import type { P3Context } from "../../../core/context.ts";
import { METRIC_DEFINITIONS, selectTaskReview, type MetricsInput, type ReviewObservation } from "./definitions.ts";
import { readManual } from "./manual.ts";

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

/** 1回のレポートで同時に読む完了タスクのレビューの数の上限（要望をまたいでレポート全体で数える） */
export const REVIEW_READ_CONCURRENCY = 8;

/** 同時に動かす数を n までにする（待っているものは来た順に始める。終わったものの枠をそのまま次に渡す） */
function limiter(n: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running < n) running += 1;
    else await new Promise<void>((go) => waiting.push(go));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/**
 * 今完了しているタスクのレビューを、selectTaskReview の規則で1件選んで読む（読むだけ）。タスクごとに一覧・選択・結果の取得を
 * limit の中で並行に行い、結果はタスク ID に結ぶ（読み終わった順に関係なく、集計は要望・タスクの順で読む）
 */
async function reviewsOf(ctx: P3Context, rid: string, tasks: readonly { id: string; status: string }[], limit: ReturnType<typeof limiter>): Promise<Record<string, ReviewObservation>> {
  const one = async (key: string): Promise<ReviewObservation> => {
    try {
      const sel = selectTaskReview(await ctx.ws.taskReviews.list(key));
      if (sel.state !== "ok") return sel;
      const rec = await ctx.ws.taskReviews.get(key, sel.run);
      return rec.result ? { state: "ok", run: sel.run, result: rec.result } : { state: "missing", reason: `${sel.run} の結果がありません` };
    } catch (e) {
      return { state: "missing", reason: `レビューの記録が読めません: ${(e as Error).message}` };
    }
  };
  const done = tasks.filter((t) => t.status === "done");
  const results = await Promise.all(done.map((t) => limit(() => one(`${rid}/${t.id}`))));
  return Object.fromEntries(done.map((t, i) => [t.id, results[i]]));
}

export async function metricsInput(ctx: P3Context, scope: MetricScope, manual?: Awaited<ReturnType<typeof readManual>>): Promise<MetricsInput> {
  const m = manual ?? (await readManual(ctx.ws.dataDir));
  const scopeKey = scope.kind === "project" ? "project" : scope.id;
  const requests = ctx.ws.requests
    .list()
    .filter((r) => r.status !== "rejected" && (scope.kind === "project" || r.milestone === scope.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  // レビューの読み取りの上限は、このレポートの全部の要望で1つ
  const limit = limiter(REVIEW_READ_CONCURRENCY);
  return {
    requests: await Promise.all(
      requests.map(async (request) => {
        const col = ctx.ws.tasksOf(request.id);
        const tasks = col.list();
        return { request, tasks, brokenTasks: [...col.errors.keys()].sort(), reviews: await reviewsOf(ctx, request.id, tasks, limit) };
      }),
    ),
    manual: { records: m.records.filter((r) => r.scope === scopeKey), ...(m.problem ? { problem: m.problem } : {}) },
  };
}

export async function metricsReport(ctx: P3Context, scope: MetricScope = { kind: "project" }): Promise<MetricsReport> {
  const manual = await readManual(ctx.ws.dataDir);
  const input = await metricsInput(ctx, scope, manual);
  const notices: MetricNotice[] = [...ctx.ws.requests.errors.entries()].map(([id, e]) => ({
    code: "broken_request",
    target: `requests/${id}/request.md`,
    message: `要望のファイルが読めないため、範囲に入るか分からず数えていません: ${e}`,
  }));
  if (manual.problem) notices.push({ code: "manual_unreadable", target: "metrics/manual.json", message: manual.problem });
  const known = new Set(ctx.ws.project.milestones.map((x) => x.id));
  for (const r of manual.records.filter((x) => x.scope !== "project" && !known.has(x.scope))) {
    notices.push({ code: "manual_orphan", target: r.id, message: `${r.id}（${r.metric}・${r.from}〜${r.to}）のマイルストーン ${r.scope} が登録にありません（project.yaml を直接直して消えた？ マイルストーンを戻すか p3 metrics rm ${r.id}）` });
  }
  const m = scope.kind === "milestone" ? ctx.ws.project.milestones.find((x) => x.id === scope.id) : undefined;
  return {
    scope,
    scopeLabel: scope.kind === "project" ? "プロジェクト全体" : `${scope.id} ${m?.title ?? ""}`.trim(),
    scopeRule:
      scope.kind === "project"
        ? "すべての要望（マイルストーンなしを含む）。見送り・アーカイブは除く"
        : `マイルストーン ${scope.id} に今直接属する要望。見送り・アーカイブは除く（親子が別のマイルストーンならそれぞれの所属で数える）`,
    generatedAt: new Date().toISOString(),
    metrics: METRIC_DEFINITIONS.map(({ compute, manual: _manual, ...def }) => ({ ...def, ...compute(input) })),
    notices,
    scopes: metricScopes(ctx),
  };
}
