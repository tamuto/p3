import { readdir, readFile, rename, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import { createExclusive, nowIso, writeFileAtomic } from "./fsutil.ts";

export interface Entity {
  id: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  body: string;
}

export class ConflictError extends Error {
  constructor(
    public id: string,
    public expected: number,
    public actual: number,
  ) {
    super(`${id}: rev conflict (expected ${expected}, actual ${actual})`);
  }
}

export class NotFoundError extends Error {
  constructor(public id: string) {
    super(`${id} not found`);
  }
}

/**
 * 1エンティティ = 1 Markdown ファイル（YAML frontmatter + 本文）のコレクション。
 * メモリ上にキャッシュし、ファイル変更（人手・AI・Codex による直接編集）は reload() で取り込む。
 */
export class MarkdownCollection<T extends Entity> {
  private items = new Map<string, T>();
  /** ファイル名(ID) -> 読み込みエラー。壊れたファイルで全体が落ちないようにする */
  readonly errors = new Map<string, string>();

  constructor(
    readonly dir: string,
    readonly prefix: string,
    private normalize: (data: Record<string, unknown>, body: string, id: string) => T,
    /** frontmatter に書くキー順 */
    private keyOrder: (keyof T)[],
  ) {}

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.items.clear();
    this.errors.clear();
    for (const f of await readdir(this.dir)) {
      if (f.endsWith(".md")) await this.reloadFile(f);
    }
  }

  /** 単一ファイルを再読込。削除されていれば除去。戻り値は ID */
  async reloadFile(file: string): Promise<string | undefined> {
    const id = basename(file, ".md");
    if (!id.startsWith(`${this.prefix}-`)) return;
    try {
      const text = await readFile(join(this.dir, `${id}.md`), "utf8");
      const { data, body } = parseFrontmatter(text);
      this.items.set(id, this.normalize(data, body, id));
      this.errors.delete(id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") this.items.delete(id);
      else this.errors.set(id, String(e));
    }
    return id;
  }

  list(): T[] {
    return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  require(id: string): T {
    const v = this.items.get(id);
    if (!v) throw new NotFoundError(id);
    return v;
  }

  path(id: string) {
    return join(this.dir, `${id}.md`);
  }

  private serialize(item: T): string {
    const { body, ...rest } = item;
    const ordered: Record<string, unknown> = {};
    for (const k of this.keyOrder) if (k !== "body") ordered[k as string] = (rest as Record<string, unknown>)[k as string];
    for (const [k, v] of Object.entries(rest)) if (!(k in ordered)) ordered[k] = v;
    return stringifyFrontmatter(ordered, body);
  }

  private async nextId(): Promise<number> {
    const nums = [...this.items.keys(), ...(await readdir(this.dir).catch(() => [] as string[]))]
      .map((s) => /-(\d+)/.exec(s)?.[1])
      .filter(Boolean)
      .map(Number);
    return (nums.length ? Math.max(...nums) : 0) + 1;
  }

  async create(input: Omit<T, "id" | "rev" | "createdAt" | "updatedAt">, actor?: string): Promise<T> {
    let n = await this.nextId();
    // 別プロセス（AI など）と採番が衝突したら次の番号へ
    for (;;) {
      const id = `${this.prefix}-${String(n).padStart(4, "0")}`;
      const now = nowIso();
      const item = { ...input, id, rev: 1, createdAt: now, updatedAt: now, updatedBy: actor } as T;
      if (await createExclusive(this.path(id), this.serialize(item))) {
        this.items.set(id, item);
        return item;
      }
      n++;
    }
  }

  /**
   * 部分更新。expectedRev を渡すと楽観ロック（AI が古い状態を元に上書きするのを防ぐ）。
   */
  async update(id: string, patch: Partial<T>, opts: { expectedRev?: number; actor?: string } = {}): Promise<T> {
    // 外部編集を取りこぼさないよう、更新直前にディスクから読み直す
    await this.reloadFile(`${id}.md`);
    const cur = this.require(id);
    if (opts.expectedRev !== undefined && opts.expectedRev !== cur.rev) {
      throw new ConflictError(id, opts.expectedRev, cur.rev);
    }
    const next = {
      ...cur,
      ...patch,
      id,
      rev: cur.rev + 1,
      createdAt: cur.createdAt,
      updatedAt: nowIso(),
      updatedBy: opts.actor ?? cur.updatedBy,
    } as T;
    await writeFileAtomic(this.path(id), this.serialize(next));
    this.items.set(id, next);
    return next;
  }

  /** 物理削除はせず .archive/ へ移動 */
  async archive(id: string): Promise<void> {
    this.require(id);
    const dest = join(this.dir, ".archive");
    await mkdir(dest, { recursive: true });
    await rename(this.path(id), join(dest, `${id}.md`));
    this.items.delete(id);
  }
}
