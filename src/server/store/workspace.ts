import { readFile, watch } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { parseRef, REQUEST_ID, TASK_ID, taskId } from "../../shared/refs.ts";
import type { ProjectConfig, Request, ServerEvent, StatusDef, Task } from "../../shared/types.ts";
import { fileLayout, folderLayout, MarkdownCollection, NotFoundError } from "./collection.ts";
import { newRequestId } from "./fsutil.ts";
import { normalizeProject, normalizeRequest, normalizeTaskIn, REQUEST_KEY_ORDER, TASK_KEY_ORDER } from "./normalize.ts";
import { PreflightStore } from "./preflightStore.ts";
import { writeProjectFile } from "./projectFile.ts";

type Listener = (e: ServerEvent) => void;

/**
 * ステータスを変えた日時を記録する（予定ではなく事実）。
 *   最初の列（未着手）以外にした → startedAt（未着手に戻したら消す）
 *   完了扱いの列にした          → doneAt（完了から戻したら消す）
 */
export function stampStatus(prev: Task | undefined, next: Task, statuses: StatusDef[]): Task {
  if (prev && prev.status === next.status) return next;
  const now = next.updatedAt;
  const done = statuses.some((s) => s.done && s.id === next.status);
  const first = statuses[0]?.id;
  return {
    ...next,
    startedAt: next.status === first ? undefined : (prev?.startedAt ?? next.startedAt ?? now),
    doneAt: done ? now : undefined,
  };
}

/**
 * 1リポジトリ = 1プロジェクト。データディレクトリ配下がすべての状態で、要望ごとにフォルダを分ける。
 *
 *   <data>/project.yaml
 *   <data>/requests/<要望ID>/request.md
 *   <data>/requests/<要望ID>/tasks/T001.md
 *   <data>/requests/<要望ID>/preflight/PF-.../{run.json, assessment.json, drafts/D1.md}
 *
 * 共有（git / ファイル共有）も要望のフォルダ単位で行える。
 */
export class Workspace {
  project!: ProjectConfig;
  readonly requests: MarkdownCollection<Request>;
  readonly preflight: PreflightStore;
  private taskCollections = new Map<string, MarkdownCollection<Task>>();
  private listeners = new Set<Listener>();
  private abort = new AbortController();

  constructor(readonly dataDir: string) {
    this.requests = new MarkdownCollection<Request>({
      layout: folderLayout(this.requestsDir, "request.md", REQUEST_ID, () => newRequestId()),
      normalize: normalizeRequest,
      keyOrder: REQUEST_KEY_ORDER,
    });
    this.preflight = new PreflightStore(this.requestsDir);
  }

  get requestsDir() {
    return join(this.dataDir, "requests");
  }

  /** 管理対象リポジトリの絶対パス（Codex の cwd） */
  get repoRoot(): string {
    return isAbsolute(this.project.repo) ? this.project.repo : resolve(this.dataDir, this.project.repo);
  }

  async load(): Promise<void> {
    await this.loadProject();
    await this.requests.load();
    this.taskCollections.clear();
    await Promise.all(this.requests.list().map((r) => this.tasksOf(r.id).load()));
  }

  /** 要望のタスク（要望の中で T001, T002, ... と連番） */
  tasksOf(requestId: string): MarkdownCollection<Task> {
    let col = this.taskCollections.get(requestId);
    if (!col) {
      col = new MarkdownCollection<Task>({
        layout: fileLayout(join(this.requestsDir, requestId, "tasks"), TASK_ID, taskId),
        normalize: normalizeTaskIn(requestId),
        keyOrder: TASK_KEY_ORDER,
        derived: ["request", "ref"],
        beforeWrite: (prev, next) => stampStatus(prev, next, this.project.statuses),
      });
      this.taskCollections.set(requestId, col);
    }
    return col;
  }

  /** 全要望のタスク */
  allTasks(): Task[] {
    return this.requests.list().flatMap((r) => this.tasksOf(r.id).list());
  }

  /** 絶対参照（<要望ID>/T003）でタスクを引く */
  task(ref: string): Task | undefined {
    const r = parseRef(ref);
    return r?.task ? this.taskCollections.get(r.request)?.get(r.task) : undefined;
  }

  requireTask(ref: string): Task {
    const t = this.task(ref);
    if (!t) throw new NotFoundError(ref);
    return t;
  }

  /** 参照先が存在するか（要望かタスク） */
  exists(ref: string): boolean {
    const r = parseRef(ref);
    if (!r) return false;
    return r.task ? !!this.task(ref) : !!this.requests.get(r.request);
  }

  /** 読めなかったファイル（データディレクトリからの相対パス → エラー） */
  errors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, e] of this.requests.errors) out[`requests/${id}/request.md`] = e;
    for (const [rid, col] of this.taskCollections) for (const [id, e] of col.errors) out[`requests/${rid}/tasks/${id}.md`] = e;
    return out;
  }

  /** プロジェクト設定を更新して project.yaml に書く（コメントは残す） */
  async saveProject(patch: Partial<ProjectConfig>): Promise<ProjectConfig> {
    await this.loadProject();
    const next = { ...this.project, ...patch };
    await writeProjectFile(join(this.dataDir, "project.yaml"), next);
    await this.loadProject();
    this.emit({ type: "changed", kind: "project" });
    return this.project;
  }

  private async loadProject() {
    const text = await readFile(join(this.dataDir, "project.yaml"), "utf8").catch(() => "");
    this.project = normalizeProject((YAML.parse(text) ?? {}) as Record<string, unknown>);
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(e: ServerEvent) {
    for (const l of this.listeners) l(e);
  }

  /**
   * データディレクトリを監視し、外部からのファイル編集（エディタ・AI・Codex・git pull）を取り込む。
   * これによりファイルが唯一の正（source of truth）であり続ける。
   */
  async watch(): Promise<void> {
    const pending = new Map<string, NodeJS.Timeout>();
    try {
      for await (const ev of watch(this.dataDir, { recursive: true, signal: this.abort.signal })) {
        const f = ev.filename;
        if (!f || f.endsWith(".tmp") || f.includes(".archive")) continue;
        clearTimeout(pending.get(f));
        pending.set(
          f,
          setTimeout(() => {
            pending.delete(f);
            void this.onFileChanged(f);
          }, 80),
        );
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error("[watch]", e);
    }
  }

  private async onFileChanged(rel: string) {
    const [top, rid, kind, file] = rel.split(/[\\/]/);
    if (top === "project.yaml") {
      await this.loadProject();
      this.emit({ type: "changed", kind: "project" });
      return;
    }
    if (top !== "requests" || !rid || !REQUEST_ID.test(rid)) return;
    if (kind === undefined || kind === "request.md") {
      // 要望の作成・削除（git pull でフォルダごと増減することもある）
      const known = !!this.requests.get(rid);
      await this.requests.reload(rid);
      if (!known && this.requests.get(rid)) await this.tasksOf(rid).load();
      this.emit({ type: "changed", kind: "request", request: rid });
    } else if (kind === "tasks" && file?.endsWith(".md")) {
      const id = file.slice(0, -3);
      if (!TASK_ID.test(id)) return;
      await this.tasksOf(rid).reload(id);
      this.emit({ type: "changed", kind: "task", request: rid, ref: `${rid}/${id}` });
    } else if (kind === "preflight") {
      this.emit({ type: "changed", kind: "preflight", request: rid });
    }
  }

  close() {
    this.abort.abort();
  }
}
