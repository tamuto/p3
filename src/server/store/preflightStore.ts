import { readdir, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PreflightRun, ProposedTask } from "../../shared/types.ts";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import { writeFileAtomic } from "./fsutil.ts";
import { normalizeRelations } from "./normalize.ts";

/**
 * requests/<要望ID>/preflight/<RUN-ID>/
 *   run.json          評価結果・ログ・文脈（機械向け）
 *   drafts/D1.md ...  細分化されたタスク案（1案 = 1ファイル。人や AI が直接編集できる）
 */
export class PreflightStore {
  /** requestsDir: .pcube/requests */
  constructor(readonly requestsDir: string) {}

  runDir(requestId: string, runId: string) {
    return join(this.requestsDir, requestId, "preflight", runId);
  }

  async save(run: PreflightRun): Promise<void> {
    const { drafts, ...meta } = run;
    await writeFileAtomic(join(this.runDir(run.requestId, run.id), "run.json"), JSON.stringify(meta, null, 2) + "\n");
  }

  async saveDrafts(requestId: string, runId: string, drafts: ProposedTask[]): Promise<void> {
    const dir = join(this.runDir(requestId, runId), "drafts");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const d of drafts) await this.saveDraft(requestId, runId, d);
  }

  async saveDraft(requestId: string, runId: string, d: ProposedTask): Promise<void> {
    const { description, ...meta } = d;
    await writeFileAtomic(
      join(this.runDir(requestId, runId), "drafts", `${d.key}.md`),
      stringifyFrontmatter({ ...meta, include: d.include }, description),
    );
  }

  async loadDrafts(requestId: string, runId: string): Promise<ProposedTask[]> {
    const dir = join(this.runDir(requestId, runId), "drafts");
    const files = await readdir(dir).catch(() => [] as string[]);
    const drafts: ProposedTask[] = [];
    for (const f of files.filter((f) => f.endsWith(".md"))) {
      const { data, body } = parseFrontmatter(await readFile(join(dir, f), "utf8"));
      drafts.push({
        key: String(data.key ?? f.replace(/\.md$/, "")),
        title: String(data.title ?? ""),
        description: body.trim(),
        estimateDays: Number(data.estimateDays ?? 1),
        areas: Array.isArray(data.areas) ? data.areas.map(String) : [],
        dependsOn: Array.isArray(data.dependsOn) ? data.dependsOn.map(String) : [],
        relations: normalizeRelations(data.relations),
        include: data.include !== false,
      });
    }
    return drafts.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  }

  async get(requestId: string, runId: string): Promise<PreflightRun | undefined> {
    try {
      const meta = JSON.parse(await readFile(join(this.runDir(requestId, runId), "run.json"), "utf8"));
      return { ...meta, drafts: await this.loadDrafts(requestId, runId) };
    } catch {
      return undefined;
    }
  }

  async list(requestId: string): Promise<PreflightRun[]> {
    const ids = await readdir(join(this.requestsDir, requestId, "preflight")).catch(() => [] as string[]);
    const runs = await Promise.all(ids.filter((i) => i.startsWith("PF-")).map((i) => this.get(requestId, i)));
    return runs.filter((r): r is PreflightRun => !!r).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
