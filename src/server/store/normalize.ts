import { isTaskStatus, RELATION_TYPES, REQUEST_STATUSES, type ProjectConfig, type Relation, type Request, type RequestStatus, type Task } from "../../shared/types.ts";

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
/** YAML は日付を Date にしてしまうので YYYY-MM-DD に戻す */
const date = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString().slice(0, 10) : str(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : (str(v) ?? new Date(0).toISOString()));

export function normalizeRelations(v: unknown): Relation[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .filter((r) => typeof r.type === "string" && r.type in RELATION_TYPES && typeof r.target === "string")
    .map((r) => ({
      type: r.type as Relation["type"],
      target: String(r.target),
      note: str(r.note),
      origin: str(r.origin) as Relation["origin"],
      confidence: num(r.confidence),
    }));
}

/** 要望 requestId のタスクとして読む（request / ref は場所から決まる） */
export const normalizeTaskIn =
  (requestId: string) =>
  (d: Record<string, unknown>, body: string, id: string): Task => ({
    id,
    request: requestId,
    ref: `${requestId}/${id}`,
    title: str(d.title) ?? id,
    // 3つ以外（古い設定の列など）は未着手として読む
    status: isTaskStatus(d.status) ? d.status : "todo",
    labels: strs(d.labels),
    areas: strs(d.areas),
    outputs: strs(d.outputs),
    startedAt: d.startedAt ? iso(d.startedAt) : undefined,
    doneAt: d.doneAt ? iso(d.doneAt) : undefined,
    checkedAt: d.checkedAt ? iso(d.checkedAt) : undefined,
    relations: normalizeRelations(d.relations),
    rev: num(d.rev) ?? 1,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    updatedBy: str(d.updatedBy),
    body,
  });

export const TASK_KEY_ORDER: (keyof Task)[] = [
  "id", "title", "status", "labels", "areas", "outputs",
  "relations", "rev", "createdAt", "startedAt", "doneAt", "checkedAt", "updatedAt", "updatedBy",
];

export function normalizeRequest(d: Record<string, unknown>, body: string, id: string): Request {
  const ws = d.workstream as Record<string, unknown> | undefined;
  const status = str(d.status) as RequestStatus;
  return {
    id,
    title: str(d.title) ?? id,
    status: REQUEST_STATUSES.includes(status) ? status : "draft",
    areas: strs(d.areas),
    relations: normalizeRelations(d.relations),
    due: date(d.due),
    milestone: str(d.milestone),
    tags: strs(d.tags),
    workstream: ws && ws.branch ? { branch: String(ws.branch), worktree: String(ws.worktree ?? "") } : undefined,
    lastPreflight: str(d.lastPreflight),
    rev: num(d.rev) ?? 1,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    updatedBy: str(d.updatedBy),
    body,
  };
}

export const REQUEST_KEY_ORDER: (keyof Request)[] = [
  "id", "title", "status", "due", "milestone", "tags", "areas", "workstream", "relations", "lastPreflight",
  "rev", "createdAt", "updatedAt", "updatedBy",
];

export function normalizeProject(d: Record<string, unknown>): ProjectConfig {
  const preflight = (d.preflight ?? {}) as Record<string, unknown>;
  return {
    name: str(d.name) ?? "pcube project",
    description: str(d.description) ?? "",
    repo: str(d.repo) ?? ".",
    docs: strs(d.docs),
    milestones: Array.isArray(d.milestones)
      ? (d.milestones as unknown[])
          .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && !!(m as Record<string, unknown>).id)
          .map((m) => ({ id: String(m.id), title: str(m.title) ?? String(m.id), due: date(m.due), done: m.done === true ? true : undefined }))
      : [],
    branchPattern: str(d.branchPattern) ?? "req/{id}-{slug}",
    worktreeDir: str(d.worktreeDir) ?? ".worktrees",
    preflight: { instructions: str(preflight.instructions) ?? "" },
  };
}
