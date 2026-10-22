import { readdir, readFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PreflightRun, ProposedChild, ProposedTask, RunPulse } from "../../shared/types.ts";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import { writeFileAtomic } from "./fsutil.ts";

/**
 * requests/<要望ID>/preflight/<RUN-ID>/
 *   run.json          評価結果・ログ・文脈（機械向け）
 *   drafts/D1.md ...  細分化されたタスク案（1案 = 1ファイル。人や AI が直接編集できる）
 *   children/C1.md ... 子の要望の案（分割の run。タスク案とは一緒に置かない）
 */
export class PreflightStore {
  /** requestsDir: .p3/requests */
  constructor(readonly requestsDir: string) {}

  runDir(requestId: string, runId: string) {
    return join(this.requestsDir, requestId, "preflight", runId);
  }

  async save(run: PreflightRun): Promise<void> {
    const { drafts, children, ...meta } = run;
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
        supersedes: Array.isArray(data.supersedes) ? data.supersedes.map(String) : [],
        include: data.include !== false,
        ...("repo" in data ? { repo: data.repo === null || data.repo === "" || data.repo === "none" ? null : String(data.repo) } : {}),
      });
    }
    return drafts.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  }

  async saveChild(requestId: string, runId: string, c: ProposedChild): Promise<void> {
    const { description, ...meta } = c;
    await writeFileAtomic(join(this.runDir(requestId, runId), "children", `${c.key}.md`), stringifyFrontmatter({ ...meta, include: c.include }, description));
  }

  /** 子の案（children/ が無ければ undefined: タスク案の run） */
  async loadChildren(requestId: string, runId: string): Promise<ProposedChild[] | undefined> {
    const dir = join(this.runDir(requestId, runId), "children");
    const files = await readdir(dir).catch(() => undefined);
    if (!files) return undefined;
    const children: ProposedChild[] = [];
    for (const f of files.filter((f) => f.endsWith(".md"))) {
      const { data, body } = parseFrontmatter(await readFile(join(dir, f), "utf8"));
      const n = Number(data.estimatedTasks);
      children.push({
        key: String(data.key ?? f.replace(/\.md$/, "")),
        title: String(data.title ?? ""),
        description: body.trim(),
        ...(data.estimatedTasks !== undefined && Number.isFinite(n) ? { estimatedTasks: Math.max(0, Math.round(n)) } : {}),
        requires: Array.isArray(data.requires) ? data.requires.map(String) : [],
        overlaps: Array.isArray(data.overlaps) ? data.overlaps.map(String) : [],
        include: data.include !== false,
      });
    }
    return children.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  }

  async get(requestId: string, runId: string): Promise<PreflightRun | undefined> {
    try {
      const meta = JSON.parse(await readFile(join(this.runDir(requestId, runId), "run.json"), "utf8"));
      const children = await this.loadChildren(requestId, runId);
      return { ...meta, drafts: await this.loadDrafts(requestId, runId), ...(children ? { children } : {}) };
    } catch {
      return undefined;
    }
  }

  /** run の今の状態だけ（run.json の状態と日時。案・ログは返さない）。ファイルは変えない */
  async pulse(requestId: string, runId: string): Promise<RunPulse> {
    const file = join(this.runDir(requestId, runId), "run.json");
    const info = await stat(file).catch((e: NodeJS.ErrnoException) => e);
    if (info instanceof Error) {
      if (info.code !== "ENOENT") return { id: runId, state: "broken" };
      const dir = await stat(this.runDir(requestId, runId)).catch(() => undefined);
      return { id: runId, state: dir?.isDirectory() ? "pending" : "missing" };
    }
    try {
      const meta = JSON.parse(await readFile(file, "utf8")) as Partial<PreflightRun>;
      if (!meta || typeof meta !== "object" || typeof meta.status !== "string") return { id: runId, state: "broken" };
      return {
        id: runId,
        state: "ready",
        status: meta.status,
        ...(meta.startedAt ? { startedAt: meta.startedAt } : {}),
        ...(meta.finishedAt ? { finishedAt: meta.finishedAt } : {}),
        version: `${info.mtimeMs}:${info.size}`,
      };
    } catch {
      return { id: runId, state: "broken" };
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
