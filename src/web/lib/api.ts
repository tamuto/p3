import type { RepoRef } from "../../shared/repos.ts";
import type {
  Neighborhood,
  MaterializeResult,
  PreflightNote,
  PreflightRun,
  ProjectConfig,
  ProposedTask,
  Relation,
  Request,
  RequestProgress,
  SupersedeCandidate,
  SupersededMark,
  Task,
  Theme,
  Attachment,
} from "../../shared/types.ts";

export interface AttachmentList {
  items: Attachment[];
  invalid: { id: string; error: string }[];
  limits: { count: number; imageBytes: number; xlsxBytes: number; totalBytes: number };
}

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
  /** 置き換えられたタスクの印（T001 → 置き換えた側） */
  superseded: Record<string, SupersededMark[]>;
  /** 対応済なのに未完了のタスクがある（外部の直接編集など）ときの知らせ */
  issue: string | null;
}

/** 着手などで添えられる警告（操作は行われている） */
export type WithWarnings<T> = T & { warnings?: { code: string; target: string; from: string[]; message: string }[] };

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
  /** Codex の認証（chatgpt / legacy / none） */
  auth?: "chatgpt" | "legacy" | "none";
  account?: string;
}

/** ChatGPT プランの接続（トークンは含まない） */
export interface ChatGptState {
  connected: boolean;
  planAllowed: boolean;
  email?: string;
  expiresAt?: string;
  registered: boolean;
  pending?: { url: string; redirectUri: string; startedAt: string; expiresAt: string };
  lastError?: string;
  engine: EngineStatus;
}

/** 参照先（設定画面）。local と reason は、このマシンのローカルの画面にだけ返る */
export interface RepoInfo extends RepoRef {
  mount: string;
  status: "ok" | "unregistered" | "missing" | "notdir";
  local?: string | null;
  reason?: string | null;
}

export type RepoInput = Partial<Pick<RepoRef, "role" | "readFirst" | "writable" | "map">>;

export const api = {
  project: () => call<ProjectInfo>("GET", "/project"),
  /** データのフォルダを全部読み直させる（応答は読み直しを終えた後） */
  reloadAll: () => call<{ requests: number; tasks: number; errors: number; loadedAt: string }>("POST", "/reload", {}),
  engine: () => call<EngineStatus>("GET", "/engine"),
  /** 画面のテーマ（個人設定の ui.theme。全プロジェクト共通） */
  userTheme: () => call<{ theme: Theme }>("GET", "/user-theme"),
  saveUserTheme: (theme: Theme) => call<{ theme: Theme }>("PUT", "/user-theme", { theme }),
  chatgpt: () => call<ChatGptState>("GET", "/chatgpt"),
  chatgptLogin: () => call<{ url: string; redirectUri: string; expiresAt: string }>("POST", "/chatgpt/login", {}),
  chatgptCancel: () => call("POST", "/chatgpt/cancel", {}),
  chatgptPaste: (url: string) => call<ChatGptState>("POST", "/chatgpt/paste", { url }),
  chatgptLogout: (forget = false) => call<{ revoked: boolean; message: string }>("POST", "/chatgpt/logout", { forget }),
  saveProject: (patch: Partial<ProjectConfig>) => call<ProjectConfig>("PUT", "/project", patch),
  repos: () => call<{ local: boolean; registered: boolean; repos: RepoInfo[] }>("GET", "/repos"),
  addRepo: (b: RepoInput & { name: string; path?: string }) => call<RepoRef>("POST", "/repos", b),
  updateRepo: (name: string, b: RepoInput) => call<RepoRef>("PATCH", `/repos/${encodeURIComponent(name)}`, b),
  removeRepo: (name: string) => call<{ ok: true }>("DELETE", `/repos/${encodeURIComponent(name)}`),
  setRepoPath: (name: string, path: string | null) =>
    path === null ? call<{ ok: true }>("DELETE", `/repos/${encodeURIComponent(name)}/path`) : call<{ ok: true }>("PUT", `/repos/${encodeURIComponent(name)}/path`, { path }),

  /** 要望の一覧と進捗 */
  requests: () => call<RequestProgress[]>("GET", "/requests"),
  request: (rid: string) => call<RequestDetail>("GET", `/requests/${rid}`),
  createRequest: (r: { title: string; body: string; areas: string[]; due?: string; milestone?: string; tags?: string[] }) => call<Request>("POST", "/requests", r),
  patchRequest: (rid: string, patch: Partial<Record<keyof Request, unknown>> & { rev?: number }) => call<Request>("PATCH", `/requests/${rid}`, patch),

  task: (ref: string) => call<{ task: Task; graph: Neighborhood; superseded: SupersededMark[] }>("GET", taskPath(ref)),
  createTask: (rid: string, t: Partial<Task>) => call<Task>("POST", `/requests/${rid}/tasks`, t),
  /** checked: 完了したタスクに人が「済み」を付ける / 外す */
  patchTask: (ref: string, patch: Partial<Record<keyof Task, unknown>> & { rev?: number; checked?: boolean }) =>
    call<WithWarnings<Task>>("PATCH", taskPath(ref), patch),
  addRelation: (ref: string, r: Relation) => call<Task>("POST", relPath(ref), r),
  removeRelation: (ref: string, r: Pick<Relation, "type" | "target">) =>
    call<Task>("DELETE", `${relPath(ref)}?type=${r.type}&target=${encodeURIComponent(r.target)}`),

  /** note: メモを書き足してから実行する。始められなければ ApiError の body.note に保存したメモが入る */
  startPreflight: (rid: string, opts: { engine?: string; note?: string } = {}) => call<PreflightRun>("POST", `/requests/${rid}/preflight`, opts),
  notes: (rid: string) => call<NotesInfo>("GET", `/requests/${rid}/notes`),
  addNote: (rid: string, body: string) => call<PreflightNote>("POST", `/requests/${rid}/notes`, { body }),
  run: (rid: string, runId: string) => call<PreflightRun>("GET", `/requests/${rid}/preflight/${runId}`),
  cancelRun: (rid: string, runId: string) => call("POST", `/requests/${rid}/preflight/${runId}/cancel`, {}),
  attachments: (rid: string) => call<AttachmentList>("GET", `/requests/${rid}/attachments`),
  /** 添付を足す（multipart。説明・出典は空なら送らない） */
  addAttachment: async (rid: string, input: { file: File; description?: string; source?: string }): Promise<Attachment> => {
    const form = new FormData();
    form.append("file", input.file);
    if (input.description?.trim()) form.append("description", input.description.trim());
    if (input.source?.trim()) form.append("source", input.source.trim());
    const res = await fetch(`/api/requests/${rid}/attachments`, { method: "POST", body: form, headers: { "x-pcube-actor": "human:web" } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText, data);
    return data as Attachment;
  },
  removeAttachment: (rid: string, id: string) => call("DELETE", `/requests/${rid}/attachments/${id}`),
  patchDraft: (rid: string, runId: string, key: string, patch: Partial<ProposedTask>) =>
    call<ProposedTask>("PATCH", `/requests/${rid}/preflight/${runId}/drafts/${key}`, patch),
  /** タスク化の確認（採用する案と置き換えられるタスクの候補）。何も変えない */
  previewMaterialize: (rid: string, runId: string) =>
    call<{ include: string[]; candidates: SupersedeCandidate[]; materialized: string[] }>("GET", `/requests/${rid}/preflight/${runId}/materialize`),
  /** archive: アーカイブする置き換えられるタスク（候補として見た rev つき） */
  materialize: (rid: string, runId: string, archive: { id: string; rev: number }[] = []) =>
    call<MaterializeResult>("POST", `/requests/${rid}/preflight/${runId}/materialize`, { archive }),
};
