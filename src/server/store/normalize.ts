import {
  DEFAULT_STATUSES,
  RELATION_TYPES,
  type ProjectConfig,
  type Relation,
  type Request,
  type RequestStatus,
  type Task,
} from "../../shared/types.ts";

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
/** YAML は日付を Date にしてしまうので YYYY-MM-DD に戻す */
const date = (v: unknown): string | undefined =>
  v instanceof Date ? v.toISOString().slice(0, 10) : str(v);
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

export function normalizeTask(d: Record<string, unknown>, body: string, id: string): Task {
  return {
    id,
    title: str(d.title) ?? id,
    status: str(d.status) ?? "backlog",
    request: str(d.request),
    assignee: str(d.assignee),
    labels: strs(d.labels),
    areas: strs(d.areas),
    estimate: num(d.estimate),
    start: date(d.start),
    due: date(d.due),
    progress: num(d.progress),
    relations: normalizeRelations(d.relations),
    rev: num(d.rev) ?? 1,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    updatedBy: str(d.updatedBy),
    body,
  };
}

export const TASK_KEY_ORDER: (keyof Task)[] = [
  "id", "title", "status", "request", "assignee", "labels", "areas",
  "estimate", "start", "due", "progress", "relations", "rev", "createdAt", "updatedAt", "updatedBy",
];

const REQUEST_STATUSES: RequestStatus[] = ["draft", "preflight", "reviewed", "accepted", "rejected"];

export function normalizeRequest(d: Record<string, unknown>, body: string, id: string): Request {
  const ws = d.workstream as Record<string, unknown> | undefined;
  const status = str(d.status) as RequestStatus;
  return {
    id,
    title: str(d.title) ?? id,
    status: REQUEST_STATUSES.includes(status) ? status : "draft",
    areas: strs(d.areas),
    relations: normalizeRelations(d.relations),
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
  "id", "title", "status", "areas", "workstream", "relations", "lastPreflight",
  "rev", "createdAt", "updatedAt", "updatedBy",
];

export function normalizeProject(d: Record<string, unknown>): ProjectConfig {
  const statuses = Array.isArray(d.statuses)
    ? (d.statuses as Record<string, unknown>[]).map((s) => ({
        id: String(s.id),
        label: String(s.label ?? s.id),
        done: Boolean(s.done),
      }))
    : DEFAULT_STATUSES;
  return {
    name: str(d.name) ?? "pcube project",
    description: str(d.description) ?? "",
    repo: str(d.repo) ?? ".",
    statuses,
    branchPattern: str(d.branchPattern) ?? "req/{id}-{slug}",
    worktreeDir: str(d.worktreeDir) ?? ".worktrees",
  };
}
