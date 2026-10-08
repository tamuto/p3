import { RELATION_TYPES, type Relation, type RelationType, type Request, type Task } from "../shared/types.ts";
import type { PcubeContext } from "./context.ts";
import { NotFoundError } from "./store/collection.ts";

/**
 * API と CLI で共通の操作。どちらもファイルを直接読み書きするので、ここに置いた規則
 * （循環の禁止、由来の記録など）はどの経路から変更しても同じように効く。
 */

export interface TaskFilter {
  status?: string[];
  request?: string;
  area?: string;
  q?: string;
}

export function listTasks({ ws }: PcubeContext, f: TaskFilter = {}): Task[] {
  let tasks = ws.tasks.list();
  if (f.status?.length) tasks = tasks.filter((t) => f.status!.includes(t.status));
  if (f.request) tasks = tasks.filter((t) => t.request === f.request);
  if (f.area) tasks = tasks.filter((t) => t.areas.some((a) => a.startsWith(f.area!)));
  if (f.q) {
    const q = f.q.toLowerCase();
    tasks = tasks.filter((t) => `${t.id} ${t.title} ${t.body}`.toLowerCase().includes(q));
  }
  return tasks;
}

/**
 * "12" / "task-12" / "TASK-0012" / "req-3" を正式な ID に。見つからなければ undefined。
 * 数字だけのときは prefer の種類として扱う。
 */
export function normalizeId({ ws }: PcubeContext, raw: string, prefer: "TASK" | "REQ" = "TASK"): string | undefined {
  const s = raw.trim().toUpperCase();
  const m = /^(?:(TASK|REQ|T|R)-?)?0*(\d+)$/.exec(s);
  if (!m) return ws.tasks.get(s) || ws.requests.get(s) ? s : undefined;
  const n = m[2].padStart(4, "0");
  const prefix = m[1] ? (m[1].startsWith("R") ? "REQ" : "TASK") : prefer;
  const id = `${prefix}-${n}`;
  return ws.tasks.get(id) || ws.requests.get(id) ? id : undefined;
}

export interface ResolveResult {
  match: string | null;
  candidates: { id: string; title: string; score: number; reasons: string[] }[];
}

/** ID・タイトル・自然文から対象を特定する。ID 一致 → タイトル部分一致 → 内容類似 */
export function resolve(ctx: PcubeContext, q: string): ResolveResult {
  const query = q.trim();
  const exact = normalizeId(ctx, query);
  if (exact) {
    const item = ctx.ws.tasks.get(exact) ?? ctx.ws.requests.get(exact)!;
    return { match: exact, candidates: [{ id: exact, title: item.title, score: 1, reasons: ["ID 一致"] }] };
  }
  const byTitle = [...ctx.ws.tasks.list(), ...ctx.ws.requests.list()]
    .filter((t) => query && t.title.toLowerCase().includes(query.toLowerCase()))
    .map((t) => ({ id: t.id, title: t.title, score: 0.9, reasons: ["タイトルに含む"] }));
  const similar = ctx.index
    .related({ text: query, limit: 5, minScore: 0.15 })
    .filter((r) => !byTitle.some((b) => b.id === r.id));
  const candidates = [...byTitle, ...similar].slice(0, 8);
  return { match: candidates.length === 1 ? candidates[0].id : null, candidates };
}

function collectionOf({ ws }: PcubeContext, id: string) {
  if (ws.tasks.get(id)) return ws.tasks;
  if (ws.requests.get(id)) return ws.requests;
  throw new NotFoundError(id);
}

export async function addRelation(ctx: PcubeContext, id: string, rel: Relation, actor: string): Promise<Task | Request> {
  if (!(rel.type in RELATION_TYPES)) throw new Error(`関係の種類が不正です: ${rel.type}`);
  if (rel.target === id) throw new Error("自分自身には関係を張れません");
  if (!ctx.ws.tasks.get(rel.target) && !ctx.ws.requests.get(rel.target)) throw new NotFoundError(rel.target);
  if (rel.type === "depends_on" && ctx.index.wouldCycle(id, rel.target)) {
    throw new Error(`${id} → ${rel.target} は依存の循環になります`);
  }
  const col = collectionOf(ctx, id);
  const cur = col.require(id);
  const relations = [
    ...cur.relations.filter((r) => !(r.type === rel.type && r.target === rel.target)),
    { ...rel, origin: rel.origin ?? (actor.startsWith("ai") ? "ai" : "human") },
  ];
  const next = await col.update(id, { relations } as never, { actor });
  ctx.index.invalidate();
  return next;
}

export async function removeRelation(
  ctx: PcubeContext,
  id: string,
  r: { type: RelationType | string; target: string },
  actor: string,
): Promise<Task | Request> {
  const col = collectionOf(ctx, id);
  const cur = col.require(id);
  const relations = cur.relations.filter((x) => !(x.type === r.type && x.target === r.target));
  if (relations.length === cur.relations.length) throw new NotFoundError(`${id} の ${r.type} ${r.target}`);
  const next = await col.update(id, { relations } as never, { actor });
  ctx.index.invalidate();
  return next;
}
