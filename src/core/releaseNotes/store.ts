import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ReleaseNote, ReleaseSource } from "../../shared/types.ts";
import { parseFrontmatter, stringifyFrontmatter } from "../store/frontmatter.ts";
import { createExclusive, nowIso, withFileLock, writeFileAtomic } from "../store/fsutil.ts";

/**
 * <data>/release-notes/<マイルストーンID>.md   リリースノート（マイルストーンごとに1件）
 *
 * frontmatter に出典（保存したときの材料: 要望・タスクの ID・タイトル・状態・変更の記録）と材料の hash、
 * 本文に公開する Markdown を書く。出力は本文だけ。要望やタスクが後で変わっても、保存した本文と出典は変えない。
 *
 * 編集の版はファイル全体の sha256。保存はプロセス間のロックの中で、ディスクの今のファイルの版と照らしてから原子的に書く
 * （rev を増やさない直接編集も見つけられる）。ロックを使わない外部のエディタとの完全な排他は保証しない。
 * キャッシュは持たず、問い合わせのたびにディスクを読む（再読み込みは要らない）。
 */

export const RELEASE_NOTES_DIR = "release-notes";
/** マイルストーンの ID（project.yaml と同じ。. と .. は使えない） */
const MILESTONE_ID = /^[A-Za-z0-9._-]+$/;

/** ノートの操作の失敗の種類。CLI は終了コード、API は応答に分ける */
export class ReleaseNoteError extends Error {
  constructor(
    /** not_found: 無い / invalid: 読めない / exists: 既にある / conflict: 版が違う / bad_id: ID が使えない */
    readonly code: "not_found" | "invalid" | "exists" | "conflict" | "bad_id",
    readonly milestone: string,
    message: string,
    /** conflict のときの今の版（読めなければ無い） */
    readonly current?: string,
  ) {
    super(message);
  }
}

export const versionOf = (text: string) => createHash("sha256").update(text).digest("hex");

export function checkMilestoneId(id: string): void {
  if (!MILESTONE_ID.test(id) || id === "." || id === "..") throw new ReleaseNoteError("bad_id", id, `マイルストーンの ID に使えません: ${JSON.stringify(id)}（英数字と . _ -）`);
}

export interface NoteWrite {
  title: string;
  body: string;
  sources: ReleaseSource[];
  materialHash?: string;
}

export class ReleaseNoteStore {
  constructor(readonly dataDir: string) {}

  get dir() {
    return join(this.dataDir, RELEASE_NOTES_DIR);
  }

  /** ノートのファイル。保存先のフォルダの外を指す ID は断る */
  path(milestone: string): string {
    checkMilestoneId(milestone);
    const p = resolve(this.dir, `${milestone}.md`);
    if (!p.startsWith(resolve(this.dir) + sep)) throw new ReleaseNoteError("bad_id", milestone, `保存先の外を指します: ${milestone}`);
    return p;
  }

  private lock(milestone: string) {
    return join(this.dir, `.${milestone}.lock`);
  }

  /** ファイルがあるマイルストーン（読めないものも含む。ID の形でないファイルは除く） */
  async ids(): Promise<string[]> {
    const files = await readdir(this.dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as string[];
      throw e;
    });
    return files
      .filter((f) => f.endsWith(".md") && !f.startsWith("."))
      .map((f) => f.slice(0, -3))
      .filter((id) => MILESTONE_ID.test(id) && id !== "." && id !== "..")
      .sort();
  }

  /** 読む。無ければ not_found、読めなければ invalid（空のノートとして扱わない） */
  async read(milestone: string): Promise<ReleaseNote> {
    const path = this.path(milestone);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ReleaseNoteError("not_found", milestone, `リリースノートがありません: ${milestone}`);
      throw new ReleaseNoteError("invalid", milestone, `リリースノートを読めません（${path}）: ${(e as Error).message}`);
    }
    return parseNote(milestone, text, path);
  }

  /** 全部（読めないものは invalid に理由を返す） */
  async list(): Promise<{ notes: ReleaseNote[]; invalid: { milestone: string; error: string }[] }> {
    const notes: ReleaseNote[] = [];
    const invalid: { milestone: string; error: string }[] = [];
    for (const id of await this.ids()) {
      try {
        notes.push(await this.read(id));
      } catch (e) {
        if (e instanceof ReleaseNoteError && e.code === "not_found") continue; // 読む間に消えた
        invalid.push({ milestone: id, error: (e as Error).message });
      }
    }
    return { notes, invalid };
  }

  /** 新しく作る（既にあれば exists。読めないファイルがあっても上書きしない） */
  async create(milestone: string, input: NoteWrite, actor?: string): Promise<ReleaseNote> {
    const path = this.path(milestone);
    return withFileLock(this.lock(milestone), async () => {
      const now = nowIso();
      const text = serialize({ milestone, ...input, createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor });
      if (!(await createExclusive(path, text))) throw new ReleaseNoteError("exists", milestone, `リリースノートは既にあります: ${milestone}（直すときは版を付けて更新してください）`);
      return parseNote(milestone, text, path);
    });
  }

  /**
   * 更新する。expectedVersion は読んだときの版（必須）。ロックの中でディスクの今のファイルと照らし、違えば conflict で何も書かない。
   * 作成の日時と作成者は残す
   */
  async update(milestone: string, input: Partial<NoteWrite>, expectedVersion: string, actor?: string): Promise<ReleaseNote> {
    const path = this.path(milestone);
    return withFileLock(this.lock(milestone), async () => {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ReleaseNoteError("not_found", milestone, `リリースノートがありません（消されました）: ${milestone}`);
        throw e;
      }
      const version = versionOf(raw);
      if (version !== expectedVersion) {
        throw new ReleaseNoteError("conflict", milestone, `${milestone} のリリースノートは読んだ後に変わっています（版が違います）。読み直してからやり直してください`, version);
      }
      const cur = parseNote(milestone, raw, path);
      const text = serialize({
        milestone,
        title: input.title ?? cur.title,
        body: input.body ?? cur.body,
        sources: input.sources ?? cur.sources,
        materialHash: "materialHash" in input ? input.materialHash : cur.materialHash,
        createdAt: cur.createdAt,
        createdBy: cur.createdBy,
        updatedAt: nowIso(),
        updatedBy: actor,
      });
      await writeFileAtomic(path, text);
      return parseNote(milestone, text, path);
    });
  }
}

function serialize(n: Omit<ReleaseNote, "version">): string {
  return stringifyFrontmatter(
    {
      milestone: n.milestone,
      title: n.title,
      createdAt: n.createdAt,
      createdBy: n.createdBy,
      updatedAt: n.updatedAt,
      updatedBy: n.updatedBy,
      materialHash: n.materialHash,
      sources: n.sources.map((s) => ({ request: s.request, title: s.title, status: s.status, tasks: s.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, record: t.record })) })),
    },
    n.body,
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** ファイルを読む。frontmatter が壊れている・マイルストーンが違う・日時が無いものは invalid */
function parseNote(milestone: string, text: string, path: string): ReleaseNote {
  let data: Record<string, unknown>;
  let body: string;
  try {
    ({ data, body } = parseFrontmatter(text));
  } catch (e) {
    throw new ReleaseNoteError("invalid", milestone, `リリースノートの frontmatter を読めません（${path}）: ${(e as Error).message}`);
  }
  const bad = (why: string) => new ReleaseNoteError("invalid", milestone, `リリースノートを読めません（${path}）: ${why}`);
  if (data.milestone !== milestone) throw bad(`milestone が ${JSON.stringify(data.milestone)} です（ファイル名は ${milestone}）`);
  const createdAt = str(data.createdAt);
  const updatedAt = str(data.updatedAt);
  if (!createdAt || !updatedAt) throw bad("createdAt / updatedAt がありません");
  if (data.sources !== undefined && !Array.isArray(data.sources)) throw bad("sources が配列ではありません");
  const sources: ReleaseSource[] = ((data.sources as unknown[] | undefined) ?? []).map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    if (typeof o.request !== "string") throw bad(`sources[${i}].request がありません`);
    const tasks = Array.isArray(o.tasks) ? o.tasks : [];
    return {
      request: o.request,
      title: str(o.title) ?? "",
      status: (str(o.status) ?? "done") as ReleaseSource["status"],
      tasks: tasks.map((t) => {
        const x = (t ?? {}) as Record<string, unknown>;
        return { id: String(x.id ?? ""), title: str(x.title) ?? "", status: (str(x.status) ?? "done") as ReleaseSource["tasks"][number]["status"], ...(str(x.record) ? { record: str(x.record) } : {}) };
      }),
    };
  });
  return {
    milestone,
    title: str(data.title) ?? milestone,
    body: body.trim(),
    sources,
    materialHash: str(data.materialHash),
    createdAt,
    createdBy: str(data.createdBy),
    updatedAt,
    updatedBy: str(data.updatedBy),
    version: versionOf(text),
  };
}
