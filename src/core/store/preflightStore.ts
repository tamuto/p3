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
  /** requestsDir: .p3/requests */
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
        areas: Array.isArray(data.areas) ? data.areas.map(String) : [],
        dependsOn: Array.isArray(data.dependsOn) ? data.dependsOn.map(String) : [],
        relations: normalizeRelations(data.relations),
        include: data.include !== false,
        ...("repo" in data ? { repo: data.repo === null || data.repo === "" || data.repo === "none" ? null : String(data.repo) } : {}),
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
    return newestFirst(runs.filter((r): r is PreflightRun => !!r));
  }
}

/**
 * run を新しい順に並べる。基本は開始時刻だが、時計は戻ることがある（WSL2 の時刻の補正など）ので、
 * 前回を引き継いだ run（previous）は、引き継いだ相手より必ず新しいとする。
 */
export function newestFirst<T extends Pick<PreflightRun, "id" | "startedAt" | "previous">>(runs: T[]): T[] {
  const byTime = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  // previous の鎖の長さ（引き継いだ回数）。鎖でつながる run どうしは、長い方が新しい
  const ids = new Map(runs.map((r) => [r.id, r]));
  const depth = new Map<string, number>();
  const chain = (r: T, seen = new Set<string>()): number => {
    if (depth.has(r.id)) return depth.get(r.id)!;
    const prev = r.previous && !seen.has(r.id) ? ids.get(r.previous) : undefined;
    const d = prev ? chain(prev, seen.add(r.id)) + 1 : 0;
    depth.set(r.id, d);
    return d;
  };
  const root = (r: T): string => {
    let cur = r;
    for (const seen = new Set<string>(); cur.previous && ids.has(cur.previous) && !seen.has(cur.id); ) {
      seen.add(cur.id);
      cur = ids.get(cur.previous)!;
    }
    return cur.id;
  };
  // 時刻順の並びで各鎖が占める位置はそのままにし、その位置に鎖の run を引き継いだ順（新しい方から）で入れ直す
  const groups = new Map<string, T[]>();
  for (const r of byTime) (groups.get(root(r)) ?? groups.set(root(r), []).get(root(r))!).push(r);
  for (const g of groups.values()) g.sort((a, b) => chain(b) - chain(a));
  const next = new Map([...groups].map(([k]) => [k, 0]));
  return byTime.map((r) => {
    const k = root(r);
    const i = next.get(k)!;
    next.set(k, i + 1);
    return groups.get(k)![i];
  });
}
