import { absRef, normalizeTaskId, parseRef, relRef } from "../shared/refs.ts";
import { RELATION_TYPES, type Relation, type RelationType, type Request, type RequestProgress, type Task, TASK_STATUSES, type TaskStatus } from "../shared/types.ts";
import type { PcubeContext } from "./context.ts";
import { NotFoundError } from "./store/collection.ts";

/**
 * API と CLI で共通の操作。どちらもファイルを直接読み書きするので、ここに置いた規則
 * （参照の解き方、循環の禁止、由来の記録など）はどの経路から変更しても同じように効く。
 */

export interface TaskFilter {
  /** 要望（無ければ全要望） */
  request?: string;
  status?: string[];
  area?: string;
  q?: string;
}

export function listTasks({ ws }: PcubeContext, f: TaskFilter = {}): Task[] {
  let tasks = f.request ? ws.tasksOf(f.request).list() : ws.allTasks();
  if (f.status?.length) tasks = tasks.filter((t) => f.status!.includes(t.status));
  if (f.area) tasks = tasks.filter((t) => t.areas.some((a) => a.startsWith(f.area!)));
  if (f.q) {
    const q = f.q.toLowerCase();
    tasks = tasks.filter((t) => `${t.ref} ${t.title} ${t.body}`.toLowerCase().includes(q));
  }
  return tasks;
}

/**
 * 要望の ID を短い書き方からも解く: 完全な ID、乱数部分（k7m3x）、ID の先頭・末尾の一部（一意なときだけ）。
 */
export function resolveRequestId({ ws }: PcubeContext, raw: string): string | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (ws.requests.get(s)) return s;
  if (s.length < 3) return undefined;
  const hits = ws.requests.list().filter((r) => r.id.startsWith(s) || r.id.endsWith(s));
  return hits.length === 1 ? hits[0].id : undefined;
}

/**
 * 参照を絶対参照に解く。存在しなければ undefined。
 *   "<要望>/T3"  "<要望>"  — 要望は短い書き方でもよい
 *   "T3" / "3"           — current（今の要望）の中のタスク
 */
export function resolveRef(ctx: PcubeContext, raw: string, current?: string): string | undefined {
  const s = raw.trim();
  const [head, tail] = s.split("/", 2);
  if (tail !== undefined) {
    const rid = resolveRequestId(ctx, head);
    const tid = normalizeTaskId(tail);
    return rid && tid && ctx.ws.tasksOf(rid).get(tid) ? `${rid}/${tid}` : undefined;
  }
  const tid = normalizeTaskId(s);
  if (tid && current) return ctx.ws.tasksOf(current).get(tid) ? `${current}/${tid}` : undefined;
  return resolveRequestId(ctx, s);
}

export interface ResolveResult {
  match: string | null;
  candidates: { ref: string; title: string; score: number; reasons: string[] }[];
}

/** 参照・タイトル・自然文から対象を特定する。参照の一致 → タイトル部分一致 → 内容類似 */
export function resolve(ctx: PcubeContext, q: string, current?: string): ResolveResult {
  const query = q.trim();
  const exact = query ? resolveRef(ctx, query, current) : undefined;
  if (exact) return { match: exact, candidates: [{ ref: exact, title: titleOf(ctx, exact), score: 1, reasons: ["参照が一致"] }] };
  const items = [
    ...ctx.ws.requests.list().map((r) => ({ ref: r.id, title: r.title, request: r.id })),
    ...ctx.ws.allTasks().map((t) => ({ ref: t.ref, title: t.title, request: t.request })),
  ];
  const byTitle = items
    .filter((t) => query && t.title.toLowerCase().includes(query.toLowerCase()))
    // 今の要望の中のものを先に
    .sort((a, b) => Number(b.request === current) - Number(a.request === current))
    .map((t) => ({ ref: t.ref, title: t.title, score: 0.9, reasons: ["タイトルに含む"] }));
  const similar = ctx.index
    .related({ text: query, limit: 5, minScore: 0.15 })
    .filter((r) => !byTitle.some((b) => b.ref === r.ref));
  const candidates = [...byTitle, ...similar].slice(0, 8);
  return { match: candidates.length === 1 ? candidates[0].ref : null, candidates };
}

export function titleOf({ ws }: PcubeContext, ref: string): string {
  return ws.task(ref)?.title ?? ws.requests.get(ref)?.title ?? "?";
}

/** 参照の指す要望かタスクのコレクションと ID */
function entityOf({ ws }: PcubeContext, ref: string) {
  const r = parseRef(ref);
  if (!r || !ws.exists(ref)) throw new NotFoundError(ref);
  return r.task ? { col: ws.tasksOf(r.request), id: r.task, request: r.request } : { col: ws.requests, id: r.request, request: r.request };
}

/**
 * 関係を張る。ref と target は絶対参照か相対参照（ref の要望の中）。
 * ファイルには、同じ要望のタスクなら T003、それ以外は <要望ID>/T003 の形で書く。
 */
export async function addRelation(ctx: PcubeContext, ref: string, rel: Relation, actor: string): Promise<Task | Request> {
  if (!(rel.type in RELATION_TYPES)) throw new Error(`関係の種類が不正です: ${rel.type}`);
  const { col, id, request } = entityOf(ctx, ref);
  const from = absRef(ref)!;
  const to = absRef(rel.target, request);
  if (!to || !ctx.ws.exists(to)) throw new NotFoundError(rel.target);
  if (to === from) throw new Error("自分自身には関係を張れません");
  if (rel.type === "depends_on" && ctx.index.wouldCycle(from, to)) throw new Error(`${from} → ${to} は依存の循環になります`);
  const cur = col.require(id);
  const target = relRef(to, request)!;
  const relations = [
    ...cur.relations.filter((r) => !(r.type === rel.type && absRef(r.target, request) === to)),
    { ...rel, target, origin: rel.origin ?? (actor.startsWith("ai") ? "ai" : "human") },
  ];
  const next = await col.update(id, { relations } as never, { actor });
  ctx.index.invalidate();
  return next;
}

export async function removeRelation(
  ctx: PcubeContext,
  ref: string,
  r: { type: RelationType | string; target: string },
  actor: string,
): Promise<Task | Request> {
  const { col, id, request } = entityOf(ctx, ref);
  const to = absRef(r.target, request);
  const cur = col.require(id);
  const relations = cur.relations.filter((x) => !(x.type === r.type && absRef(x.target, request) === to));
  if (relations.length === cur.relations.length) throw new NotFoundError(`${ref} の ${r.type} ${r.target}`);
  const next = await col.update(id, { relations } as never, { actor });
  ctx.index.invalidate();
  return next;
}

/** 要望ごとの進捗。進捗の画面と `pcube progress` で使う */
export function progress(ctx: PcubeContext): RequestProgress[] {
  return ctx.ws.requests
    .list()
    .map((request) => {
      const tasks = ctx.ws.tasksOf(request.id).list();
      const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
      for (const t of tasks) counts[t.status]++;
      const done = tasks.filter((t) => t.status === "done");
      return {
        request,
        tasks: tasks.map(({ id, ref, title, status, createdAt, startedAt, doneAt, checkedAt }) => ({ id, ref, title, status, createdAt, startedAt, doneAt, checkedAt })),
        counts,
        total: tasks.length,
        done: done.length,
        updatedAt: [request.updatedAt, ...tasks.map((t) => t.updatedAt)].sort().at(-1)!,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

