import { normalizeTaskId } from "../shared/refs.ts";
import { REQUEST_STATUSES, type RequestProgress, type RequestStatus, type Task, TASK_STATUSES, type TaskStatus } from "../shared/types.ts";
import type { P3Context } from "./context.ts";
import { hierarchyNow } from "./requestStatus.ts";

/**
 * API と CLI で共通の読み取り（一覧・参照の解き方・進捗）。変更の手順は requestOps.ts。
 */

export interface TaskFilter {
  /** 要望（無ければ全要望） */
  request?: string;
  status?: string[];
  area?: string;
  q?: string;
  /** 作業先（参照先の名前。none は作業先なし） */
  repo?: string;
}

export function listTasks({ ws }: P3Context, f: TaskFilter = {}): Task[] {
  let tasks = f.request ? ws.tasksOf(f.request).list() : ws.allTasks();
  if (f.status?.length) tasks = tasks.filter((t) => f.status!.includes(t.status));
  if (f.area) tasks = tasks.filter((t) => t.areas.some((a) => a.startsWith(f.area!)));
  // 作業先で絞る（none は作業先なし）
  if (f.repo !== undefined) tasks = tasks.filter((t) => (t.repo ?? null) === (f.repo === "none" ? null : f.repo));
  if (f.q) {
    const q = f.q.toLowerCase();
    tasks = tasks.filter((t) => `${t.ref} ${t.title} ${t.body}`.toLowerCase().includes(q));
  }
  return tasks;
}

/**
 * 要望の ID を短い書き方からも解く: 完全な ID、乱数部分（k7m3x）、ID の先頭・末尾の一部（一意なときだけ）。
 */
export function resolveRequestId({ ws }: P3Context, raw: string): string | undefined {
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
export function resolveRef(ctx: P3Context, raw: string, current?: string): string | undefined {
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
export function resolve(ctx: P3Context, q: string, current?: string): ResolveResult {
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
  const candidates = byTitle.slice(0, 8);
  return { match: candidates.length === 1 ? candidates[0].ref : null, candidates };
}

export function titleOf({ ws }: P3Context, ref: string): string {
  return ws.task(ref)?.title ?? ws.requests.get(ref)?.title ?? "?";
}

/**
 * 要望ごとの進捗。進捗の画面と `p3 progress` で使う。
 * 並び: 最終更新（要望自身と、アーカイブしていないタスクの updatedAt の最大）の新しい順。同じ日時なら要望 ID の順。
 */
export function progress(ctx: P3Context): RequestProgress[] {
  const h = hierarchyNow(ctx.ws);
  const zero = () => Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  return ctx.ws.requests
    .list()
    .map((request) => {
      const tasks = ctx.ws.tasksOf(request.id).list();
      const counts = zero();
      for (const t of tasks) counts[t.status]++;
      const done = tasks.filter((t) => t.status === "done");
      // 配下: 自分と子孫（循環しても1回ずつ）
      const below = h.descendants(request.id);
      const sub = { counts: zero(), total: 0, done: 0, requests: Object.fromEntries(REQUEST_STATUSES.map((s) => [s, 0])) as Record<RequestStatus, number> };
      const stamps = [request.updatedAt, ...tasks.map((t) => t.updatedAt)];
      for (const r of [request, ...below]) {
        if (r !== request) {
          sub.requests[r.status]++;
          stamps.push(r.updatedAt);
        }
        for (const t of ctx.ws.tasksOf(r.id).list()) {
          sub.counts[t.status]++;
          sub.total++;
          if (t.status === "done") sub.done++;
          if (r !== request) stamps.push(t.updatedAt);
        }
      }
      return {
        request,
        tasks: tasks.map(({ id, ref, title, status, createdAt, startedAt, doneAt, checkedAt }) => ({ id, ref, title, status, createdAt, startedAt, doneAt, checkedAt })),
        counts,
        total: tasks.length,
        done: done.length,
        updatedAt: stamps.sort().at(-1)!,
        children: h.children(request.id).map((c) => c.id),
        subtree: sub,
        hierarchyIssues: h.issuesAround(request.id),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || byId(a.request.id, b.request.id));
}

/** ID の順（数を含む部分は数として比べる: T2 < T10） */
const byId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
