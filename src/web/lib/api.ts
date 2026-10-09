import type {
  Neighborhood,
  PreflightNote,
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

/** メモの一覧と、次の Preflight が引き継ぐもの */
export interface NotesInfo {
  /** pending: まだ渡していない（次の Preflight に渡す） */
  notes: (PreflightNote & { pending: boolean })[];
  invalid: { file: string; error: string }[];
  /** 次の Preflight が引き継ぐ前回の run */
  previous: string | null;
  /** 前回を引き継がない理由 */
  previousSkipped: string | null;
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
  createRequest: (r: { title: string; body: string; areas: string[]; due?: string; milestone?: string; tags?: string[] }) => call<Request>("POST", "/requests", r),
  patchRequest: (rid: string, patch: Partial<Record<keyof Request, unknown>> & { rev?: number }) => call<Request>("PATCH", `/requests/${rid}`, patch),

  task: (ref: string) => call<{ task: Task; graph: Neighborhood }>("GET", taskPath(ref)),
  createTask: (rid: string, t: Partial<Task>) => call<Task>("POST", `/requests/${rid}/tasks`, t),
  /** checked: 完了したタスクに人が「済み」を付ける / 外す */
  patchTask: (ref: string, patch: Partial<Record<keyof Task, unknown>> & { rev?: number; checked?: boolean }) => call<Task>("PATCH", taskPath(ref), patch),
  addRelation: (ref: string, r: Relation) => call<Task>("POST", relPath(ref), r),
  removeRelation: (ref: string, r: Pick<Relation, "type" | "target">) =>
    call<Task>("DELETE", `${relPath(ref)}?type=${r.type}&target=${encodeURIComponent(r.target)}`),

  /** note: メモを書き足してから実行する。始められなければ ApiError の body.note に保存したメモが入る */
  startPreflight: (rid: string, opts: { engine?: string; note?: string } = {}) => call<PreflightRun>("POST", `/requests/${rid}/preflight`, opts),
  notes: (rid: string) => call<NotesInfo>("GET", `/requests/${rid}/notes`),
  addNote: (rid: string, body: string) => call<PreflightNote>("POST", `/requests/${rid}/notes`, { body }),
  run: (rid: string, runId: string) => call<PreflightRun>("GET", `/requests/${rid}/preflight/${runId}`),
  cancelRun: (rid: string, runId: string) => call("POST", `/requests/${rid}/preflight/${runId}/cancel`, {}),
  patchDraft: (rid: string, runId: string, key: string, patch: Partial<ProposedTask>) =>
    call<ProposedTask>("PATCH", `/requests/${rid}/preflight/${runId}/drafts/${key}`, patch),
  materialize: (rid: string, runId: string) => call<Task[]>("POST", `/requests/${rid}/preflight/${runId}/materialize`, {}),
};
