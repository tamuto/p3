import type {
  Neighborhood,
  PreflightRun,
  ProjectConfig,
  ProposedTask,
  Relation,
  Request,
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

export const api = {
  project: () => call<ProjectInfo>("GET", "/project"),
  saveProject: (patch: Partial<ProjectConfig>) => call<ProjectConfig>("PUT", "/project", patch),
  tasks: () => call<Task[]>("GET", "/tasks"),
  task: (id: string) => call<{ task: Task; graph: Neighborhood }>("GET", `/tasks/${id}`),
  createTask: (t: Partial<Task>) => call<Task>("POST", "/tasks", t),
  patchTask: (id: string, patch: Partial<Record<keyof Task, unknown>> & { rev?: number }) =>
    call<Task>("PATCH", `/tasks/${id}`, patch),
  addRelation: (id: string, r: Relation) =>
    call<Task>("POST", `/${id.startsWith("REQ") ? "requests" : "tasks"}/${id}/relations`, r),
  removeRelation: (id: string, r: Pick<Relation, "type" | "target">) =>
    call<Task>("DELETE", `/${id.startsWith("REQ") ? "requests" : "tasks"}/${id}/relations?type=${r.type}&target=${r.target}`),
  requests: () => call<Request[]>("GET", "/requests"),
  request: (id: string) =>
    call<{ request: Request; tasks: Task[]; runs: PreflightRun[]; graph: Neighborhood }>("GET", `/requests/${id}`),
  createRequest: (r: { title: string; body: string; areas: string[] }) => call<Request>("POST", "/requests", r),
  patchRequest: (id: string, patch: Partial<Request>) => call<Request>("PATCH", `/requests/${id}`, patch),
  startPreflight: (id: string, engine?: string) => call<PreflightRun>("POST", `/requests/${id}/preflight`, { engine }),
  run: (reqId: string, runId: string) => call<PreflightRun>("GET", `/requests/${reqId}/preflight/${runId}`),
  cancelRun: (reqId: string, runId: string) => call("POST", `/requests/${reqId}/preflight/${runId}/cancel`, {}),
  patchDraft: (reqId: string, runId: string, key: string, patch: Partial<ProposedTask>) =>
    call<ProposedTask>("PATCH", `/requests/${reqId}/preflight/${runId}/drafts/${key}`, patch),
  materialize: (reqId: string, runId: string) => call<Task[]>("POST", `/requests/${reqId}/preflight/${runId}/materialize`, {}),
};
