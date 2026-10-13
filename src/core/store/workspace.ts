import { readdir, readFile, watch } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { parseRef, REQUEST_ID, TASK_ID, taskId } from "../../shared/refs.ts";
import type { ProjectConfig, Request, ServerEvent, Task } from "../../shared/types.ts";
import { fileLayout, folderLayout, MarkdownCollection, NotFoundError, type PreparedLoad } from "./collection.ts";
import { newRequestId } from "./fsutil.ts";
import { normalizeProject, normalizeRequest, normalizeTaskIn, REQUEST_KEY_ORDER, TASK_KEY_ORDER } from "./normalize.ts";
import { AttachmentStore } from "./attachments.ts";
import { NoteStore } from "./noteStore.ts";
import { PreflightStore } from "./preflightStore.ts";
import { writeProjectFile } from "./projectFile.ts";
import { resolveRefs, type ResolvedRef } from "../repoRefs.ts";
import { RELEASE_NOTES_DIR, ReleaseNoteStore } from "../releaseNotes/store.ts";

type Listener = (e: ServerEvent) => void;

/** 全件の読み直しの結果 */
export interface ReloadResult {
  requests: number;
  tasks: number;
  /** 読めなかったファイルの数（中身は GET /api/project の errors） */
  errors: number;
  loadedAt: string;
}

/** 全件の読み直しができなかった（project.yaml やデータのフォルダが読めない）。メモリ上の状態は変えていない */
export class ReloadError extends Error {}

/**
 * ステータスを変えた日時を記録する（予定ではなく事実）。
 *   未着手以外にした → startedAt（未着手に戻したら消す）
 *   完了にした       → doneAt（完了から戻したら消す）
 *   完了から戻した              → 人の「済み」（checkedAt）も消す
 */
export function stampStatus(prev: Task | undefined, next: Task): Task {
  if (prev && prev.status === next.status) return next;
  const now = next.updatedAt;
  const done = next.status === "done";
  return {
    ...next,
    startedAt: next.status === "todo" ? undefined : (prev?.startedAt ?? next.startedAt ?? now),
    doneAt: done ? now : undefined,
    checkedAt: done ? next.checkedAt : undefined,
  };
}

/**
 * 1リポジトリ = 1プロジェクト。データディレクトリ配下がすべての状態で、要望ごとにフォルダを分ける。
 *
 *   <data>/project.yaml
 *   <data>/requests/<要望ID>/request.md
 *   <data>/requests/<要望ID>/tasks/T001.md
 *   <data>/requests/<要望ID>/preflight/PF-.../{run.json, assessment.json, carryover.md, drafts/D1.md}
 *   <data>/requests/<要望ID>/notes/N-....md   Preflight へのメモ
 *   <data>/requests/<要望ID>/attachments/A-.../{meta.json, file.*}   添付（画像・xlsx）
 *   <data>/release-notes/<マイルストーンID>.md   リリースノート（マイルストーンごとに1件。releaseNotes/store.ts）
 *
 * 共有（git / ファイル共有）も要望のフォルダ単位で行える。
 */
export class Workspace {
  project!: ProjectConfig;
  readonly requests: MarkdownCollection<Request>;
  readonly preflight: PreflightStore;
  readonly notes: NoteStore;
  readonly attachments: AttachmentStore;
  readonly releaseNotes: ReleaseNoteStore;
  private taskCollections = new Map<string, MarkdownCollection<Task>>();
  private listeners = new Set<Listener>();
  private abort = new AbortController();

  /** localRepos: 個人設定の参照先の名前 → このマシンのパス（repoRefs.ts） */
  constructor(
    readonly dataDir: string,
    private localRepos: Record<string, string> = {},
  ) {
    this.requests = new MarkdownCollection<Request>({
      layout: folderLayout(this.requestsDir, "request.md", REQUEST_ID, () => newRequestId()),
      normalize: normalizeRequest,
      keyOrder: REQUEST_KEY_ORDER,
    });
    this.preflight = new PreflightStore(this.requestsDir);
    this.notes = new NoteStore(this.requestsDir);
    this.attachments = new AttachmentStore(this.requestsDir);
    this.releaseNotes = new ReleaseNoteStore(dataDir);
  }

  get requestsDir() {
    return join(this.dataDir, "requests");
  }

  /** このマシンのパスを変えた（個人設定に書いた後に呼ぶ） */
  setLocalRepo(name: string, path: string | null) {
    const next = { ...this.localRepos };
    if (path === null) delete next[name];
    else next[name] = path;
    this.localRepos = next;
    this.emit({ type: "changed", kind: "project" });
  }

  /** project.yaml を読み直して知らせる（参照先を書いた後） */
  async refreshProject() {
    await this.loadProject();
    this.emit({ type: "changed", kind: "project" });
  }

  /** Preflight が読む参照先（共有の定義と、このマシンのパス）。呼ぶたびにパスがあるかを確かめる */
  refs(): ResolvedRef[] {
    return resolveRefs(this.project, { localRepos: this.localRepos });
  }

  async load(): Promise<void> {
    await this.loadAll(false);
  }

  /**
   * データのフォルダを全部読み直す（画面の「再読み込み」）。ファイル監視に頼らず、外での変更を取り込む。
   *   - project.yaml・要望・全タスクを読み、読み終えてから入れ替える（途中の状態は見せない）
   *   - 同時には走らせない。読み込み中に呼ばれたら、今のものが終わってからもう1回だけ読む（待っている呼び出しはまとめる）
   *   - project.yaml やデータのフォルダが読めなければ ReloadError（何も変えない）。個々の Markdown が壊れていても続け、errors() に出す
   *   - ファイルは書かない。Preflight の履歴・メモ・リリースノートは問い合わせのたびにディスクを読むので、ここでは扱わない
   * 終えたら変更通知（kind: "reload"）を出す。関係・検索の索引はこれを受けて作り直す
   */
  reloadAll(): Promise<ReloadResult> {
    if (this.reloadNext) return this.reloadNext;
    if (!this.reloadRun) return this.startReload();
    this.reloadNext = this.reloadRun
      .catch(() => undefined)
      .then(() => {
        this.reloadNext = undefined;
        return this.startReload();
      });
    return this.reloadNext;
  }

  private reloadRun?: Promise<ReloadResult>;
  private reloadNext?: Promise<ReloadResult>;

  private startReload(): Promise<ReloadResult> {
    const run = (async () => {
      await this.loadAll(true);
      this.emit({ type: "changed", kind: "reload" });
      return {
        requests: this.requests.list().length,
        tasks: this.allTasks().length,
        errors: Object.keys(this.errors()).length,
        loadedAt: new Date().toISOString(),
      };
    })().finally(() => {
      if (this.reloadRun === run) this.reloadRun = undefined;
    });
    this.reloadRun = run;
    return run;
  }

  /** strict: project.yaml とデータのフォルダが読めなければ失敗にする（起動時は無くても空として続ける） */
  private async loadAll(strict: boolean): Promise<void> {
    const project = strict ? await this.readProjectStrict() : await this.readProject();
    if (strict) {
      await readdir(this.requestsDir).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw new ReloadError(`データのフォルダを読めません: ${this.requestsDir}: ${e.message}`);
      });
    }
    const loads: PreparedLoad[] = [];
    try {
      const requests = await this.requests.prepareLoad();
      loads.push(requests);
      const tasks = await Promise.allSettled(requests.ids.map((id) => this.tasksOf(id).prepareLoad()));
      for (const t of tasks) if (t.status === "fulfilled") loads.push(t.value);
      const failed = tasks.find((t) => t.status === "rejected");
      if (failed) throw failed.reason;
    } catch (e) {
      for (const l of loads) l.abort();
      throw e;
    }
    // 公開: ここから同期でまとめて入れ替える。タスクのコレクションは作り直さない（処理中の操作が持っている参照を生かす）
    this.project = project;
    for (const l of loads) l.commit();
    for (const rid of this.taskCollections.keys()) if (!this.requests.get(rid)) this.taskCollections.delete(rid);
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
        beforeWrite: (prev, next) => stampStatus(prev, next),
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
    this.project = await this.readProject();
  }

  private async readProject(): Promise<ProjectConfig> {
    const text = await readFile(join(this.dataDir, "project.yaml"), "utf8").catch(() => "");
    return normalizeProject((YAML.parse(text) ?? {}) as Record<string, unknown>);
  }

  private async readProjectStrict(): Promise<ProjectConfig> {
    const path = join(this.dataDir, "project.yaml");
    try {
      return normalizeProject((YAML.parse(await readFile(path, "utf8")) ?? {}) as Record<string, unknown>);
    } catch (e) {
      throw new ReloadError(`project.yaml を読めません（${path}）: ${(e as Error).message}`);
    }
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(e: ServerEvent) {
    for (const l of this.listeners) l(e);
  }

  /**
   * データディレクトリを監視し、外部からのファイル編集（エディタ・AI・Codex・git pull）を取り込む（補助）。
   * NFS などでは通知が届かず、Node の再帰的な監視は置き換えて保存したファイルの2回目以降の変更を通知しないことがある。
   * 正しさはこれに頼らず、画面の「再読み込み」（reloadAll）で保証する。
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
    if (top === RELEASE_NOTES_DIR) {
      // リリースノートの作成・更新・削除（ロックのファイル .<ID>.lock は除く）
      if (rid?.endsWith(".md") && !rid.startsWith(".") && kind === undefined) this.emit({ type: "changed", kind: "release-note", milestone: rid.slice(0, -3) });
      return;
    }
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
    } else if (kind === "notes") {
      this.emit({ type: "changed", kind: "note", request: rid });
    } else if (kind === "attachments") {
      this.emit({ type: "changed", kind: "attachment", request: rid });
    }
  }

  close() {
    this.abort.abort();
  }
}
