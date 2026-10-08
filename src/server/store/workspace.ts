import { readFile, watch } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import type { ProjectConfig, Request, ServerEvent, Task } from "../../shared/types.ts";
import { MarkdownCollection } from "./collection.ts";
import { normalizeProject, normalizeRequest, normalizeTask, REQUEST_KEY_ORDER, TASK_KEY_ORDER } from "./normalize.ts";
import { PreflightStore } from "./preflightStore.ts";

type Listener = (e: ServerEvent) => void;

/**
 * 1サーバ = 1プロジェクト。データディレクトリ配下がすべての状態。
 *
 *   <data>/project.yaml
 *   <data>/requests/REQ-0001.md
 *   <data>/tasks/TASK-0001.md
 *   <data>/preflight/REQ-0001/PF-.../{run.json,drafts/*.md}
 */
export class Workspace {
  project!: ProjectConfig;
  readonly tasks: MarkdownCollection<Task>;
  readonly requests: MarkdownCollection<Request>;
  readonly preflight: PreflightStore;
  private listeners = new Set<Listener>();
  private abort = new AbortController();

  constructor(readonly dataDir: string) {
    this.tasks = new MarkdownCollection(join(dataDir, "tasks"), "TASK", normalizeTask, TASK_KEY_ORDER);
    this.requests = new MarkdownCollection(join(dataDir, "requests"), "REQ", normalizeRequest, REQUEST_KEY_ORDER);
    this.preflight = new PreflightStore(join(dataDir, "preflight"));
  }

  /** 管理対象リポジトリの絶対パス（Codex の cwd） */
  get repoRoot(): string {
    return isAbsolute(this.project.repo) ? this.project.repo : resolve(this.dataDir, this.project.repo);
  }

  async load(): Promise<void> {
    await this.loadProject();
    await Promise.all([this.tasks.load(), this.requests.load()]);
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
   * データディレクトリを監視し、外部からのファイル編集（エディタ・AI エージェント・Codex）を取り込む。
   * これによりファイルが唯一の真実（source of truth）であり続ける。
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
    const [top, ...rest] = rel.split(/[\\/]/);
    if (top === "tasks" && rest.length === 1) {
      const id = await this.tasks.reloadFile(rest[0]);
      if (id) this.emit({ type: "changed", kind: "task", id });
    } else if (top === "requests" && rest.length === 1) {
      const id = await this.requests.reloadFile(rest[0]);
      if (id) this.emit({ type: "changed", kind: "request", id });
    } else if (top === "preflight") {
      this.emit({ type: "changed", kind: "preflight", id: rest[1] });
    } else if (top === "project.yaml") {
      await this.loadProject();
      this.emit({ type: "changed", kind: "project" });
    }
  }

  close() {
    this.abort.abort();
  }
}
