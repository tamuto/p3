import { access, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** エンティティをどこに置き、どう採番するか */
export interface Layout {
  /** エンティティのファイル */
  path(id: string): string;
  /** ディスク上にある ID */
  scan(): Promise<string[]>;
  /** 採番で使わない ID（アーカイブ済みなど。読み込みの対象ではない） */
  reserved?(): Promise<string[]>;
  /** 新しい ID。attempt は衝突してやり直した回数 */
  nextId(existing: string[], attempt: number): string;
  /** アーカイブ: 移す元と先 */
  archive(id: string): { from: string; to: string };
}

export interface CollectionOptions<T extends Entity> {
  layout: Layout;
  normalize: (data: Record<string, unknown>, body: string, id: string) => T;
  /** frontmatter に書くキー順 */
  keyOrder: (keyof T)[];
  /** ファイルに書かないキー（場所から決まるもの） */
  derived?: (keyof T)[];
  /** 書く直前の加工（ステータスを変えた日時の記録など）。prev は作成時 undefined */
  beforeWrite?: (prev: T | undefined, next: T) => T;
}

/** 全件の読み込みの準備（prepareLoad）。commit で読んだ結果を公開し、abort で捨てる */
export interface PreparedLoad {
  /** 読めた ID（読めなかったものは含まない） */
  ids: string[];
  commit(): void;
  abort(): void;
}

type ReadResult<T> = { item: T } | { error: string } | { missing: true };

/**
 * 1エンティティ = 1 Markdown ファイル（YAML frontmatter + 本文）のコレクション。
 * メモリ上にキャッシュし、ファイル変更（人手・AI・Codex・git pull）は reload() で取り込む。
 *
 * 全件の読み込み（load / prepareLoad）は、読み終えてから入れ替える（読んでいる途中の空や半分の状態を見せない）。
 * 読み込みの間に作成・更新・アーカイブ・1件の読み直しがあった ID は、読んだ結果ではなくその時点の状態を残す
 * （読み込みが先に読んだ古い内容で、後の書き込みを戻さない）。
 */
export class MarkdownCollection<T extends Entity> {
  private items = new Map<string, T>();
  /** 読めないファイル。壊れたファイルで全体が落ちないようにする */
  readonly errors = new Map<string, string>();
  private layout: Layout;
  /** 進行中の全件の読み込みごとの「その間に変わった ID」 */
  private loads = new Set<Set<string>>();

  constructor(private opts: CollectionOptions<T>) {
    this.layout = opts.layout;
  }

  async load(): Promise<void> {
    (await this.prepareLoad()).commit();
  }

  /** ディスクから全件を読む。公開は commit でまとめて（同期で）行う */
  async prepareLoad(): Promise<PreparedLoad> {
    const touched = new Set<string>();
    this.loads.add(touched);
    const items = new Map<string, T>();
    const errors = new Map<string, string>();
    try {
      for (const id of await this.layout.scan()) {
        const r = await this.read(id);
        if ("item" in r) items.set(id, r.item);
        else if ("error" in r) errors.set(id, r.error);
      }
    } catch (e) {
      this.loads.delete(touched);
      throw e;
    }
    return {
      ids: [...items.keys()],
      commit: () => {
        if (!this.loads.delete(touched)) return;
        for (const id of touched) {
          const live = this.items.get(id);
          if (live) items.set(id, live);
          else items.delete(id);
          const err = this.errors.get(id);
          if (err !== undefined) errors.set(id, err);
          else errors.delete(id);
        }
        this.items = items;
        this.errors.clear();
        for (const [id, e] of errors) this.errors.set(id, e);
      },
      abort: () => void this.loads.delete(touched),
    };
  }

  private async read(id: string): Promise<ReadResult<T>> {
    try {
      const { data, body } = parseFrontmatter(await readFile(this.layout.path(id), "utf8"));
      return { item: this.opts.normalize(data, body, id) };
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : { error: String(e) };
    }
  }

  private touch(id: string) {
    for (const t of this.loads) t.add(id);
  }

  private put(id: string, item: T) {
    this.items.set(id, item);
    this.touch(id);
  }

  /** 1件を読み直す。消えていれば除く */
  async reload(id: string): Promise<void> {
    const r = await this.read(id);
    if ("item" in r) {
      this.put(id, r.item);
      this.errors.delete(id);
    } else {
      this.items.delete(id);
      if ("error" in r) this.errors.set(id, r.error);
      else this.errors.delete(id);
      this.touch(id);
    }
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
    return this.layout.path(id);
  }

  private serialize(item: T): string {
    const { body, ...rest } = item;
    const skip = new Set<string>(["body", ...((this.opts.derived ?? []) as string[])]);
    const ordered: Record<string, unknown> = {};
    for (const k of this.opts.keyOrder) if (!skip.has(k as string)) ordered[k as string] = (rest as Record<string, unknown>)[k as string];
    for (const [k, v] of Object.entries(rest)) if (!(k in ordered) && !skip.has(k)) ordered[k] = v;
    return stringifyFrontmatter(ordered, body);
  }

  /** 作る。省いた項目は normalize の既定値になる */
  async create(input: Partial<Omit<T, "id" | "rev" | "createdAt" | "updatedAt">>, actor?: string): Promise<T> {
    // アーカイブ済みの ID も使わない（アーカイブしたタスクへの関係が新しいタスクを指さないように）
    const existing = [...new Set([...this.items.keys(), ...(await this.layout.scan()), ...((await this.layout.reserved?.()) ?? [])])];
    // 別のプロセス（CLI・AI）と同時に作っても、排他作成で衝突を検出して次の ID にする
    for (let attempt = 0; ; attempt++) {
      const id = this.layout.nextId(existing, attempt);
      const now = nowIso();
      const item = this.opts.normalize({}, "", id);
      Object.assign(item, input, { id, rev: 1, createdAt: now, updatedAt: now, updatedBy: actor });
      const final = this.opts.beforeWrite?.(undefined, item) ?? item;
      Object.assign(item, final);
      if (await createExclusive(this.layout.path(id), this.serialize(item))) {
        this.put(id, item);
        return item;
      }
      existing.push(id);
    }
  }

  /**
   * 部分更新。expectedRev を渡すと楽観ロック（AI が古い状態を元に上書きするのを防ぐ）。
   */
  async update(id: string, patch: Partial<T>, opts: { expectedRev?: number; actor?: string } = {}): Promise<T> {
    // 外部での編集を取りこぼさないよう、更新の直前にディスクから読み直す
    await this.reload(id);
    const cur = this.require(id);
    if (opts.expectedRev !== undefined && opts.expectedRev !== cur.rev) {
      throw new ConflictError(id, opts.expectedRev, cur.rev);
    }
    const merged = {
      ...cur,
      ...patch,
      id,
      rev: cur.rev + 1,
      createdAt: cur.createdAt,
      updatedAt: nowIso(),
      updatedBy: opts.actor ?? cur.updatedBy,
    } as T;
    const next = this.opts.beforeWrite?.(cur, merged) ?? merged;
    await writeFileAtomic(this.layout.path(id), this.serialize(next));
    this.put(id, next);
    return next;
  }

  /** 物理削除はせず .archive/ へ移す */
  async archive(id: string): Promise<void> {
    this.require(id);
    const { from, to } = this.layout.archive(id);
    // 既にアーカイブに同じ ID があれば上書きしない（rename は黙って置き換えるので先に確かめる）
    if (await access(to).then(() => true, () => false)) throw new Error(`${id} は既にアーカイブにあります（${to}）。上書きしません`);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    this.items.delete(id);
    this.touch(id);
  }
}

/** ディレクトリの中の "<ID>.md"（タスク）。ID は要望の中の連番 */
export function fileLayout(dir: string, idPattern: RegExp, format: (n: number) => string): Layout {
  /** ディレクトリの中の有効な名前の ID（中身は読まないので、壊れたファイルでも ID は予約される） */
  const ids = async (d: string) =>
    (await readdir(d).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((id) => idPattern.test(id));
  return {
    path: (id) => join(dir, `${id}.md`),
    scan: () => ids(dir),
    reserved: () => ids(join(dir, ".archive")),
    nextId: (existing, attempt) => {
      const nums = existing.map((id) => Number(/\d+/.exec(id)?.[0] ?? 0));
      return format((nums.length ? Math.max(...nums) : 0) + 1 + attempt);
    },
    archive: (id) => ({ from: join(dir, `${id}.md`), to: join(dir, ".archive", `${id}.md`) }),
  };
}

/** "<ID>/<file>"（要望）。フォルダごと1件で、ID は新しく作る */
export function folderLayout(dir: string, file: string, idPattern: RegExp, newId: () => string): Layout {
  return {
    path: (id) => join(dir, id, file),
    scan: async () =>
      (await readdir(dir, { withFileTypes: true }).catch(() => []))
        .filter((d) => d.isDirectory() && idPattern.test(d.name))
        .map((d) => d.name),
    nextId: () => newId(),
    archive: (id) => ({ from: join(dir, id), to: join(dir, ".archive", id) }),
  };
}
