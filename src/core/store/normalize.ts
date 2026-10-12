import { repoNameProblem, type CodeMapEntry, type RepoRef } from "../../shared/repos.ts";
import { isTaskStatus, RELATION_TYPES, REQUEST_STATUSES, type ProjectConfig, type Relation, type RepoOutput, type Request, type RequestStatus, type Task, type Workstream } from "../../shared/types.ts";

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
    // 作業先（null / "" / 無いは作業先なし）
    repo: str(d.repo) ?? null,
    ...(Array.isArray(d.repoOutputs) ? { repoOutputs: normalizeRepoOutputs(d.repoOutputs) } : {}),
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
  "id", "title", "status", "repo", "labels", "areas", "outputs", "repoOutputs",
  "relations", "rev", "createdAt", "startedAt", "doneAt", "checkedAt", "updatedAt", "updatedBy",
];

export function normalizeRequest(d: Record<string, unknown>, body: string, id: string): Request {
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
    ...(d.workstreams && typeof d.workstreams === "object" ? { workstreams: normalizeWorkstreams(d.workstreams) } : {}),
    lastPreflight: str(d.lastPreflight),
    rev: num(d.rev) ?? 1,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    updatedBy: str(d.updatedBy),
    body,
  };
}

export const REQUEST_KEY_ORDER: (keyof Request)[] = [
  "id", "title", "status", "due", "milestone", "tags", "areas", "workstreams", "relations", "lastPreflight",
  "rev", "createdAt", "updatedAt", "updatedBy",
];

export function normalizeProject(d: Record<string, unknown>): ProjectConfig {
  const preflight = (d.preflight ?? {}) as Record<string, unknown>;
  return {
    name: str(d.name) ?? "p3 project",
    description: str(d.description) ?? "",
    repos: normalizeRepos(d.repos),
    milestones: Array.isArray(d.milestones)
      ? (d.milestones as unknown[])
          .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && !!(m as Record<string, unknown>).id)
          .map((m) => ({ id: String(m.id), title: str(m.title) ?? String(m.id), due: date(m.due), done: m.done === true ? true : undefined }))
      : [],
    branchPattern: str(d.branchPattern) ?? "req/{id}-{slug}",
    preflight: { instructions: str(preflight.instructions) ?? "" },
  };
}

/**
 * project.yaml の repos。名前をキーにした対応（推奨）か、name を持つ項目の並び。名前が使えない項目・重複は読まない
 * （書き戻すときも p3 repo で変えた項目のほかは触らないので、ファイルからは消えない）。
 * map は「パス: 役割」か「パス: { role, entry }」の対応、または { path, role, entry } の並び
 */
export function normalizeRepos(v: unknown): RepoRef[] {
  const entries: [string, Record<string, unknown>][] = Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((x) => [String(x.name ?? ""), x])
    : v && typeof v === "object"
      ? Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, x && typeof x === "object" ? (x as Record<string, unknown>) : { role: x }])
      : [];
  const out: RepoRef[] = [];
  for (const [name, x] of entries) {
    if (repoNameProblem(name) || out.some((r) => r.name === name)) continue;
    out.push({
      name,
      role: str(x.role) ?? "",
      readFirst: x.readFirst === true,
      writable: x.writable === true,
      map: normalizeCodeMap(x.map),
    });
  }
  return out;
}

function normalizeCodeMap(v: unknown): CodeMapEntry[] {
  const one = (path: string, x: unknown): CodeMapEntry | undefined => {
    if (!path) return undefined;
    if (typeof x === "string") return { path, role: x };
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return { path, role: str(o.role) ?? "", ...(str(o.entry) ? { entry: str(o.entry) } : {}) };
    }
    return { path, role: "" };
  };
  const list = Array.isArray(v)
    ? v.map((x) => (x && typeof x === "object" ? one(String((x as Record<string, unknown>).path ?? ""), x) : undefined))
    : v && typeof v === "object"
      ? Object.entries(v as Record<string, unknown>).map(([k, x]) => one(k, x))
      : [];
  return list.filter((x): x is CodeMapEntry => !!x);
}

/** リポジトリごとの成果物。repo と output のどちらかが無い項目は読まない */
export function normalizeRepoOutputs(v: unknown): RepoOutput[] {
  return (Array.isArray(v) ? v : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .flatMap((x) => (str(x.repo) && str(x.output) ? [{ repo: str(x.repo)!, output: str(x.output)! }] : []));
}

function normalizeWorkstreams(v: object): Record<string, Workstream> {
  const out: Record<string, Workstream> = {};
  for (const [name, w] of Object.entries(v as Record<string, unknown>)) {
    const o = w && typeof w === "object" ? (w as Record<string, unknown>) : {};
    if (!repoNameProblem(name) && str(o.branch)) out[name] = { branch: str(o.branch)! };
  }
  return out;
}
