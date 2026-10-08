import type {
  Neighborhood,
  PreflightRun,
  ProjectConfig,
  ProposedTask,
  Relation,
  Request,
  RequestProgress,
  Task,
} from "../../shared/types.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json", "x-pcube-actor": "human:web" } : { "x-pcube-actor": "human:web" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText, data);
  return data as T;
}

export interface ProjectInfo {
  project: ProjectConfig;
  dataDir: string;
  engines: ("codex" | "mock")[];
  defaultEngine: "codex" | "mock";
  errors: Record<string, string>;
}

/** 参照（<要望ID>/T003）をパスに */
const taskPath = (ref: string) => {
  const [rid, tid] = ref.split("/");
  return `/requests/${rid}/tasks/${tid}`;
};
/** 関係の操作先（要望かタスク） */
const relPath = (ref: string) => (ref.includes("/") ? `${taskPath(ref)}/relations` : `/requests/${ref}/relations`);

export interface RequestDetail {
  request: Request;
  tasks: Task[];
  runs: PreflightRun[];
  graph: Neighborhood;
}

export interface EngineStatus {
  name: "codex" | "mock";
  ok: boolean;
  detail: string;
}

export const api = {
  project: () => call<ProjectInfo>("GET", "/project"),
  engine: () => call<EngineStatus>("GET", "/engine"),
  saveProject: (patch: Partial<ProjectConfig>) => call<ProjectConfig>("PUT", "/project", patch),

  /** 要望の一覧と進捗 */
  requests: () => call<RequestProgress[]>("GET", "/requests"),
  request: (rid: string) => call<RequestDetail>("GET", `/requests/${rid}`),
  createRequest: (r: { title: string; body: string; areas: string[] }) => call<Request>("POST", "/requests", r),
  patchRequest: (rid: string, patch: Partial<Record<keyof Request, unknown>> & { rev?: number }) => call<Request>("PATCH", `/requests/${rid}`, patch),

  task: (ref: string) => call<{ task: Task; graph: Neighborhood }>("GET", taskPath(ref)),
  createTask: (rid: string, t: Partial<Task>) => call<Task>("POST", `/requests/${rid}/tasks`, t),
  patchTask: (ref: string, patch: Partial<Record<keyof Task, unknown>> & { rev?: number }) => call<Task>("PATCH", taskPath(ref), patch),
  addRelation: (ref: string, r: Relation) => call<Task>("POST", relPath(ref), r),
  removeRelation: (ref: string, r: Pick<Relation, "type" | "target">) =>
    call<Task>("DELETE", `${relPath(ref)}?type=${r.type}&target=${encodeURIComponent(r.target)}`),

  startPreflight: (rid: string, engine?: string) => call<PreflightRun>("POST", `/requests/${rid}/preflight`, { engine }),
  run: (rid: string, runId: string) => call<PreflightRun>("GET", `/requests/${rid}/preflight/${runId}`),
  cancelRun: (rid: string, runId: string) => call("POST", `/requests/${rid}/preflight/${runId}/cancel`, {}),
  patchDraft: (rid: string, runId: string, key: string, patch: Partial<ProposedTask>) =>
    call<ProposedTask>("PATCH", `/requests/${rid}/preflight/${runId}/drafts/${key}`, patch),
  materialize: (rid: string, runId: string) => call<Task[]>("POST", `/requests/${rid}/preflight/${runId}/materialize`, {}),
};
