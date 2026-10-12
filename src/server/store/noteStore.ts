import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PreflightNote } from "../../shared/types.ts";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import { createExclusive, nowIso } from "./fsutil.ts";

export const NOTE_ID = /^N-\d{8}-\d{6}-[0-9a-f]{4}$/;

/**
 * requests/<要望ID>/notes/N-....md   Preflight へのメモ（1件1ファイル。書き足すだけで、直さない）
 *
 * 誰がいつ書いたかを frontmatter に残す。ファイルを分けるので、複数人が同時に書いても衝突しない。
 */
export class NoteStore {
  /** requestsDir: .p3/requests */
  constructor(readonly requestsDir: string) {}

  dir(requestId: string) {
    return join(this.requestsDir, requestId, "notes");
  }

  async add(requestId: string, body: string, actor?: string): Promise<PreflightNote> {
    const text = body.trim();
    if (!text) throw new Error("メモが空です");
    for (;;) {
      const createdAt = nowIso();
      const stamp = createdAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      const note: PreflightNote = { id: `N-${stamp}-${randomBytes(2).toString("hex")}`, requestId, createdAt, createdBy: actor, body: text };
      const file = stringifyFrontmatter({ id: note.id, createdAt, createdBy: actor }, text);
      if (await createExclusive(join(this.dir(requestId), `${note.id}.md`), file)) return note;
    }
  }

  /** 古い順（作成日時、同じなら ID）。読めないファイルは invalid に理由を返す（黙って捨てない） */
  async list(requestId: string): Promise<{ notes: PreflightNote[]; invalid: { file: string; error: string }[] }> {
    const files = (await readdir(this.dir(requestId)).catch(() => [] as string[])).filter((f) => f.endsWith(".md"));
    const notes: PreflightNote[] = [];
    const invalid: { file: string; error: string }[] = [];
    for (const f of files) {
      const id = f.slice(0, -3);
      try {
        if (!NOTE_ID.test(id)) throw new Error("ファイル名が N-YYYYMMDD-HHMMSS-xxxx.md ではありません");
        const { data, body } = parseFrontmatter(await readFile(join(this.dir(requestId), f), "utf8"));
        if (!body.trim()) throw new Error("本文が空です");
        const createdAt = typeof data.createdAt === "string" ? data.createdAt : "";
        if (!createdAt) throw new Error("createdAt がありません");
        notes.push({ id, requestId, createdAt, createdBy: typeof data.createdBy === "string" ? data.createdBy : undefined, body: body.trim() });
      } catch (e) {
        invalid.push({ file: `notes/${f}`, error: (e as Error).message });
      }
    }
    notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { notes, invalid };
  }
}
