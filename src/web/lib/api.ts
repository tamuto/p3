import type { RepoRef } from "../../shared/repos.ts";
import type { HierarchyIssue, RequestLink } from "../../shared/hierarchy.ts";
import { apiBase, currentScope, scopeHeaders } from "./scope.ts";
import { trackSave } from "./unsaved.ts";
import type {
  AdoptionResult,
  MaterializeResult,
  ProposedChild,
  PreflightNote,
  PreflightPulse,
  PreflightRun,
  ProjectConfig,
  ProposedTask,
  Request,
  RequestProgress,
  SupersedeCandidate,
  SupersededMark,
  Task,
  Theme,
  Attachment,
  InputMatch,
  ReleaseGeneration,
  ReleaseMaterial,
  ReleaseNote,
  ReleaseNoteSummary,
  ReleaseWarning,
  RequestCompletionPlan,
  RequestCompletionResult,
} from "../../shared/types.ts";

/** API の run（評価対象と今の要望が同じか inputMatch を添える。run.json には無い） */
export type RunInfo = PreflightRun & { inputMatch?: InputMatch };

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

/** 保存の失敗の文言。入力の検証の誤り（issues）は「項目: 理由」を並べ、ほかは API のメッセージ */
export function saveErrorText(e: unknown): string {
  const issues = e instanceof ApiError ? (e.body as { issues?: { message: string; path: (string | number)[] }[] } | null)?.issues : undefined;
  return issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ") : (e as Error).message;
}

/**
 * API の失敗の種類。画面はこれで文言と次の操作を決める（status や code を個別に見ない）。
 *   rev_conflict: 編集を始めた後に他で更新された（読み直してやり直す。入力は残す）
 *   stale_input:  評価のあとで要望のタイトル・本文が変わった（タスク化しない。再評価する）
 *   not_found:    対象が無い（消された）
 * 409 は API の code で分け、code の無い 409 は rev の競合とする
 */
export type ApiFailure = "rev_conflict" | "stale_input" | "not_found" | "other";

export function failureOf(e: unknown): ApiFailure {
  if (!(e instanceof ApiError)) return "other";
  if (e.status === 404) return "not_found";
  if (e.status !== 409) return "other";
  return (e.body as { code?: string } | null)?.code === "stale_input" ? "stale_input" : "rev_conflict";
}

/** 登録が変わった（プロジェクトを跨ぐ serve で、外した・付け直した・データのフォルダを変えた）。画面は選び直しを案内する */
export const PROJECT_CHANGED_EVENT = "p3:project-changed";

async function send(path: string, init: RequestInit): Promise<Response> {
  const method = init.method ?? "GET";
  const req = fetch(`${apiBase()}${path}`, { ...init, headers: { "x-p3-actor": "human:web", ...scopeHeaders(), ...(init.headers as Record<string, string>) } });
  // 変える操作は数える（プロジェクトを切り替える前に、結果が決まるまで待つ）
  const res = method === "GET" || method === "HEAD" ? await req : await trackSave(req);
  if (res.status === 409 || res.status === 404 || res.status === 428) {
    const code = ((await res.clone().json().catch(() => ({}))) as { code?: string }).code;
    if (code === "changed" || (code === "unknown" && currentScope().mode === "all-projects") || code === "generation_required") {
      window.dispatchEvent(new CustomEvent(PROJECT_CHANGED_EVENT));
    }
  }
  return res;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
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

export interface RequestDetail {
  request: Request;
  tasks: Task[];
  runs: RunInfo[];
  /** 置き換えられたタスクの印（T001 → 置き換えた側） */
  superseded: Record<string, SupersededMark[]>;
  /** 対応済なのに未完了のタスクがある（外部の直接編集など）ときの知らせ */
  issue: string | null;
  /** 親子（無い以前のサーバでも動くように省略可）。ancestors は根から順、children は直下だけ（自分のタスクの数つき） */
  parent?: string | null;
  ancestors?: RequestLink[];
  children?: (RequestLink & { tasks: { total: number; done: number } })[];
  hierarchyIssues?: HierarchyIssue[];
  /** 対応済にできるか（blocker: できない理由、excluded: 見送りで対象外の子） */
  completion?: { blocker?: string; excluded: string[] };
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
  /** 画面が状態を取れなかった（通信の失敗）。使えるとも使えないとも言えない */
  unknown?: boolean;
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
  /** Preflight のエンジンの状態（プロジェクトを跨ぐ serve で、プロジェクトを選んでいない入口では null） */
  engine: EngineStatus | null;
}

/** 参照先（設定画面）。local と reason は、このマシンのローカルの画面にだけ返る */
export interface RepoInfo extends RepoRef {
  mount: string;
  status: "ok" | "unregistered" | "missing" | "notdir";
  local?: string | null;
  reason?: string | null;
}

export type RepoInput = Partial<Pick<RepoRef, "role" | "readFirst" | "writable" | "map">>;

/** マイルストーンのリリースノートの詳細（保存したノートと材料） */
export interface ReleaseNoteDetail {
  note: ReleaseNote | null;
  /** ノートのファイルが読めない理由（null でなければ「無い」ではない） */
  noteError: string | null;
  material: ReleaseMaterial;
  materialChanged: boolean;
  /** 要望を一括で完了済にできるか（サーバの判定） */
  completion: RequestCompletionPlan;
}

/** 保存の競合（409）の応答の今のノート（読めなければ・無ければ null） */
export const conflictNote = (e: unknown): ReleaseNote | null => ((e instanceof ApiError ? (e.body as { current?: ReleaseNote | null }) : null)?.current ?? null);

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
  createRequest: (r: { title: string; body: string; areas: string[]; due?: string; milestone?: string; tags?: string[]; parent?: string }) => call<Request>("POST", "/requests", r),
  /** 要望の更新。配下に未完了ができて祖先を戻したら reopenedAncestors、完了済の祖先は warnings（ancestor_done） */
  patchRequest: (rid: string, patch: Partial<Record<keyof Request, unknown>> & { rev?: number }) =>
    call<Request & { reopenedAncestors?: string[]; warnings?: { code: string; target: string; message: string }[] }>("PATCH", `/requests/${rid}`, patch),

  /** 子の表示順の保存（直下の子を全部、上から順に）。子が変わっていれば 409 code: child_order_invalid（今の並び children）、rev 違いは rev_conflict */
  orderChildren: (rid: string, children: string[], rev?: number) => call<{ request: Request; children: string[] }>("PUT", `/requests/${rid}/child-order`, { children, rev }),

  task: (ref: string) => call<{ task: Task; superseded: SupersededMark[] }>("GET", taskPath(ref)),
  createTask: (rid: string, t: Partial<Task>) => call<Task>("POST", `/requests/${rid}/tasks`, t),
  /** checked: 完了したタスクに人が「済み」を付ける / 外す */
  patchTask: (ref: string, patch: Partial<Record<keyof Task, unknown>> & { rev?: number; checked?: boolean }) =>
    call<WithWarnings<Task>>("PATCH", taskPath(ref), patch),

  /** note: メモを書き足してから実行する。始められなければ ApiError の body.note に保存したメモが入る */
  startPreflight: (rid: string, opts: { engine?: string; note?: string } = {}) => call<PreflightRun>("POST", `/requests/${rid}/preflight`, opts),
  notes: (rid: string) => call<NotesInfo>("GET", `/requests/${rid}/notes`),
  addNote: (rid: string, body: string) => call<PreflightNote>("POST", `/requests/${rid}/notes`, { body }),
  run: (rid: string, runId: string) => call<RunInfo>("GET", `/requests/${rid}/preflight/${runId}`),
  /** 最新の Preflight と見ている run の今の状態だけ（ディスクから。開いている要望の画面が軽く確かめる） */
  preflightStatus: (rid: string, runId?: string) =>
    call<PreflightPulse>("GET", `/requests/${rid}/preflight-status${runId ? `?run=${encodeURIComponent(runId)}` : ""}`),
  cancelRun: (rid: string, runId: string) => call("POST", `/requests/${rid}/preflight/${runId}/cancel`, {}),
  attachments: (rid: string) => call<AttachmentList>("GET", `/requests/${rid}/attachments`),
  /** 添付を足す（multipart。説明・出典は空なら送らない） */
  addAttachment: async (rid: string, input: { file: File; description?: string; source?: string }): Promise<Attachment> => {
    const form = new FormData();
    form.append("file", input.file);
    if (input.description?.trim()) form.append("description", input.description.trim());
    if (input.source?.trim()) form.append("source", input.source.trim());
    const res = await send(`/requests/${rid}/attachments`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText, data);
    return data as Attachment;
  },
  removeAttachment: (rid: string, id: string) => call("DELETE", `/requests/${rid}/attachments/${id}`),

  /** マイルストーンのリリースノート */
  releaseNotes: () => call<{ milestones: ReleaseNoteSummary[]; warnings: ReleaseWarning[] }>("GET", "/release-notes"),
  releaseNote: (mid: string) => call<ReleaseNoteDetail>("GET", `/release-notes/${encodeURIComponent(mid)}`),
  /** マイルストーンの対応済の要望を一括で完了済にする（basedOn は表示したときの completion.basedOn）。途中で止まったら 409 partial */
  completeReleaseRequests: (mid: string, basedOn: string) =>
    call<RequestCompletionResult>("POST", `/release-notes/${encodeURIComponent(mid)}/complete-requests`, { basedOn }),
  /** version: 読んだときの版（更新のときは必須。無ければ新規）。basedOn: 元にした材料の hash */
  saveReleaseNote: (mid: string, b: { body: string; version?: string; basedOn?: string }) =>
    call<{ note: ReleaseNote; warnings: ReleaseWarning[] }>("PUT", `/release-notes/${encodeURIComponent(mid)}`, b),
  /** 保存した本文のダウンロード（URL） */
  releaseNoteExportUrl: (mid: string) => `${apiBase()}/release-notes/${encodeURIComponent(mid)}/export`,
  generateReleaseNote: (mid: string) => call<ReleaseGeneration>("POST", `/release-notes/${encodeURIComponent(mid)}/generate`, {}),
  releaseGenerations: (mid: string) => call<ReleaseGeneration[]>("GET", `/release-notes/${encodeURIComponent(mid)}/generations`),
  releaseGeneration: (id: string) => call<ReleaseGeneration>("GET", `/release-generations/${id}`),
  cancelReleaseGeneration: (id: string) => call<{ cancelled: boolean }>("POST", `/release-generations/${id}/cancel`, {}),
  /** expectedTitle: 編集を始めたときの題（題を変えるときは必ず渡す。今の題と違えば 409 rev_conflict、body.current に今の案） */
  patchDraft: (rid: string, runId: string, key: string, patch: Partial<ProposedTask> & { expectedTitle?: string }) =>
    call<ProposedTask>("PATCH", `/requests/${rid}/preflight/${runId}/drafts/${key}`, patch),
  /** タスク化の確認（採用する案と置き換えられるタスクの候補）。何も変えない。分割の run は mode: children と案の版・問題・途中経過 */
  previewMaterialize: (rid: string, runId: string) =>
    call<{
      mode: "tasks" | "children";
      include: string[];
      candidates: SupersedeCandidate[];
      materialized: string[];
      inputMatch: InputMatch;
      version?: string;
      problems?: string[];
      adoption?: PreflightRun["adoption"] | null;
    }>("GET", `/requests/${rid}/preflight/${runId}/materialize`),
  /** 子の要望の案を直す（expectedTitle: 編集を始めたときの題。違えば 409 で書かない） */
  patchChild: (rid: string, runId: string, key: string, patch: Partial<Pick<ProposedChild, "title" | "description" | "include">> & { expectedTitle?: string }) =>
    call<ProposedChild>("PATCH", `/requests/${rid}/preflight/${runId}/children/${key}`, patch),
  /** 子の案の採用（version: 確認したときの案の版。違えば 409 drafts_changed。失敗があっても結果を返す） */
  adopt: (rid: string, runId: string, version?: string) => call<AdoptionResult>("POST", `/requests/${rid}/preflight/${runId}/materialize`, { version }),
  /** archive: アーカイブする置き換えられるタスク（候補として見た rev つき） */
  materialize: (rid: string, runId: string, archive: { id: string; rev: number }[] = []) =>
    call<MaterializeResult>("POST", `/requests/${rid}/preflight/${runId}/materialize`, { archive }),
};
