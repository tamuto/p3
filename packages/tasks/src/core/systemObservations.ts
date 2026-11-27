import { MetricStore } from "@infodb/p3-observer/core/metricStore.ts";
import type { SystemKey } from "@infodb/p3-observer/shared/metric.ts";
import { acceptanceStatus } from "../features/requirements/shared/acceptance.ts";
import type { Request, Task } from "../shared/types.ts";
import type { P3Context } from "./context.ts";

/**
 * 観測のシステムの項目（docs/architecture.md「p3-observer」）。要望・タスクの状態が変わったその場で、tasks が観測に値を書く
 * （CLI は serve を通さずファイルに直接書くので、取りこぼさずに記録できるのは操作のその場だけ）。比べるのは書く直前に読み直した値と書いた後の値。
 *   要望が初めて対応済・完了済になった → 作成からの時間（それぞれの項目に、要望ごとに1回だけ）
 *   タスクが完了になった（完了で作った・未完了から完了にした）→ 満たした（met）でない受け入れ基準の数（基準の無いタスクは記録しない）
 *   タスクを完了から戻した → 手戻り 1
 * 記録に失敗しても操作は止めず、記録できなかったこと（項目・対象・理由）を返す（CLI は標準エラーと --json の結果、API は結果の observationSkipped）
 */
type Pending = { key: SystemKey; target: string; milestone?: string; once?: boolean; value: () => number | undefined };

export async function observeTask(ctx: P3Context, before: Task | undefined, after: Task, actor?: string): Promise<string[]> {
  const was = before?.status === "done";
  const now = after.status === "done";
  if (was === now) return [];
  const milestone = ctx.ws.requests.get(after.request)?.milestone;
  if (!now) return record(ctx, [{ key: "p3.task.rework", target: after.ref, milestone, value: () => 1 }], actor);
  return record(ctx, [{ key: "p3.task.criteria_unmet", target: after.ref, milestone, value: () => unmetCriteria(after) }], actor);
}

export async function observeRequest(ctx: P3Context, before: Request, after: Request, actor?: string): Promise<string[]> {
  if (before.status === after.status) return [];
  const lead = (key: SystemKey): Pending => ({ key, target: after.id, milestone: after.milestone, once: true, value: () => hoursSince(after.createdAt) });
  return record(ctx, [...(after.status === "resolved" ? [lead("p3.request.lead_time_resolved")] : []), ...(after.status === "done" ? [lead("p3.request.lead_time_done")] : [])], actor);
}

/** 満たした（met）でない基準の数（未達・未検証・証拠なし・古い証拠）。基準が無ければ undefined（記録しない）。読めなければ失敗 */
function unmetCriteria(t: Task): number | undefined {
  if (t.acceptanceProblems?.length) throw new Error(`受け入れ基準・証拠が読めません（${t.acceptanceProblems.join(" / ")}）`);
  const s = acceptanceStatus(t);
  if (!s?.total) return undefined;
  return s.items.filter((i) => i.state !== "met").length;
}

function hoursSince(createdAt: string): number {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) throw new Error(`作成日時が読めません（${createdAt}）`);
  return Math.round(((Date.now() - t) / 3_600_000) * 100) / 100;
}

async function record(ctx: P3Context, list: Pending[], actor?: string): Promise<string[]> {
  if (!list.length) return [];
  const store = new MetricStore(ctx.ws.dataDir);
  const skipped: string[] = [];
  for (const p of list) {
    try {
      const value = p.value();
      if (value === undefined) continue;
      await store.recordSystem(p.key, { value, target: p.target, ...(p.milestone ? { milestone: p.milestone } : {}), ...(actor ? { by: actor } : {}) }, { once: p.once });
    } catch (e) {
      skipped.push(`観測の ${p.key}（${p.target}）に記録できませんでした（操作はしました）: ${(e as Error).message}`);
    }
  }
  return skipped;
}
