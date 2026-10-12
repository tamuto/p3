import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment, AttachmentFormat, FixedAttachment } from "../../shared/types.ts";
import { imageInfo, UI_LIMITS } from "../preflight/uiMaterials.ts";
import { nowIso, writeFileAtomic } from "./fsutil.ts";

export const ATTACHMENT_ID = /^A-\d{8}-\d{6}-[0-9a-f]{4}$/;

/** 上限（1つの要望あたり） */
export const ATTACHMENT_LIMITS = {
  count: 20,
  /** 画面資料の画像と同じ上限（run の中で同じ確かめ方をするため） */
  imageBytes: UI_LIMITS.bytes,
  xlsxBytes: 20 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
  /** xlsx（ZIP）の項目数と、展開したときの合計（中身は読まない。一覧だけで断る） */
  zipEntries: 10_000,
  zipUncompressed: 200 * 1024 * 1024,
} as const;

export class AttachmentError extends Error {}

const EXT: Record<AttachmentFormat, string> = { png: "png", jpeg: "jpg", xlsx: "xlsx" };
export const ATTACHMENT_TYPES: Record<AttachmentFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * ZIP の一覧（中央ディレクトリ）だけを読む。展開はしない（中身の読み取りは xlsx の展開で、別に上限をかけて行う）。
 * 読めなければ undefined
 */
export function zipEntries(buf: Buffer): { name: string; uncompressed: number }[] | undefined {
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries: { name: string; uncompressed: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return undefined;
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    entries.push({ name: buf.toString("utf8", at + 46, at + 46 + nameLen), uncompressed: buf.readUInt32LE(at + 24) });
    at += 46 + nameLen + extra + comment;
  }
  return entries;
}

/** 中身から形式を決めて確かめる。拡張子とも合わせる。だめなら AttachmentError */
export function inspectAttachment(data: Buffer, name: string): { format: AttachmentFormat; width?: number; height?: number } {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const want: AttachmentFormat | undefined = ext === "png" ? "png" : ext === "jpg" || ext === "jpeg" ? "jpeg" : ext === "xlsx" ? "xlsx" : undefined;
  if (!want) throw new AttachmentError(`添付できるのは PNG / JPEG / xlsx です（${name}）。xls や xlsm は xlsx で保存し直すか、画像にしてください`);
  if (want === "xlsx") {
    if (data.length > ATTACHMENT_LIMITS.xlsxBytes) throw new AttachmentError(`xlsx が大きすぎます（上限 ${ATTACHMENT_LIMITS.xlsxBytes} バイト）`);
    if (data.readUInt32LE(0) !== 0x04034b50) throw new AttachmentError(`${name}: xlsx（ZIP）として読めません`);
    const entries = zipEntries(data);
    if (!entries) throw new AttachmentError(`${name}: xlsx（ZIP）の一覧が読めません`);
    if (entries.length > ATTACHMENT_LIMITS.zipEntries) throw new AttachmentError(`${name}: 中のファイルが多すぎます（${entries.length}）`);
    const total = entries.reduce((n, e) => n + e.uncompressed, 0);
    if (total > ATTACHMENT_LIMITS.zipUncompressed) throw new AttachmentError(`${name}: 展開すると大きすぎます（${total} バイト）`);
    if (entries.some((e) => e.name.startsWith("/") || e.name.includes("\\") || e.name.split("/").includes(".."))) throw new AttachmentError(`${name}: 中に外を指すパスがあります`);
    const names = new Set(entries.map((e) => e.name));
    if (!names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) throw new AttachmentError(`${name}: xlsx のブックではありません`);
    if ([...names].some((n) => /vbaProject\.bin$/i.test(n))) throw new AttachmentError(`${name}: マクロを含むブックは扱いません（マクロを外した xlsx にしてください）`);
    return { format: "xlsx" };
  }
  if (data.length > ATTACHMENT_LIMITS.imageBytes) throw new AttachmentError(`画像が大きすぎます（上限 ${ATTACHMENT_LIMITS.imageBytes} バイト）`);
  const info = imageInfo(data);
  if (!info) throw new AttachmentError(`${name}: PNG / JPEG として読めません`);
  if (info.format !== want) throw new AttachmentError(`${name}: 拡張子と中身の形式が合いません（中身は ${info.format}）`);
  if (info.width > UI_LIMITS.width || info.height > UI_LIMITS.height || info.width * info.height > UI_LIMITS.pixels) {
    throw new AttachmentError(`${name}: 画像の大きさが上限を超えています（${info.width}x${info.height}）`);
  }
  return info;
}

/** ダウンロードの名前（制御文字・パスの区切りを外す） */
export function safeFileName(name: string, format: AttachmentFormat): string {
  const base = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  const ext = `.${EXT[format]}`;
  const withExt = /\.(png|jpe?g|xlsx)$/i.test(base) ? base : `${base || "attachment"}${ext}`;
  return withExt || `attachment${ext}`;
}

/**
 * requests/<要望ID>/attachments/<ID>/
 *   meta.json   元の名前・説明・出典・形式・大きさ・sha256・追加した人と日時
 *   file.<拡張子> 原本（内部の名前）
 *
 * 1件1フォルダなので、複数人が同時に足しても衝突しない。書きかけ（.tmp-）と消しかけ（.del-）は一覧に出さない。
 */
export class AttachmentStore {
  constructor(readonly requestsDir: string) {}

  dir(requestId: string) {
    return join(this.requestsDir, requestId, "attachments");
  }

  private fileOf(requestId: string, a: Pick<Attachment, "id" | "format">) {
    return join(this.dir(requestId), a.id, `file.${EXT[a.format]}`);
  }

  async add(requestId: string, input: { data: Buffer; name: string; description?: string; source?: string }, actor?: string): Promise<Attachment> {
    const name = input.name.trim().split(/[\\/]/).pop() ?? "";
    if (!name) throw new AttachmentError("ファイル名がありません");
    const info = inspectAttachment(input.data, name);
    const { items } = await this.list(requestId);
    if (items.length >= ATTACHMENT_LIMITS.count) throw new AttachmentError(`添付は1つの要望に ${ATTACHMENT_LIMITS.count} 件までです`);
    const total = items.reduce((n, a) => n + a.bytes, 0) + input.data.length;
    if (total > ATTACHMENT_LIMITS.totalBytes) throw new AttachmentError(`添付の合計が上限（${ATTACHMENT_LIMITS.totalBytes} バイト）を超えます`);
    const createdAt = nowIso();
    const id = `A-${createdAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${randomBytes(2).toString("hex")}`;
    const text = (v?: string) => (v?.trim() ? v.trim() : undefined);
    const a: Attachment = {
      id,
      requestId,
      name,
      format: info.format,
      bytes: input.data.length,
      sha256: createHash("sha256").update(input.data).digest("hex"),
      ...(text(input.description) ? { description: text(input.description) } : {}),
      ...(text(input.source) ? { source: text(input.source) } : {}),
      ...(info.width ? { width: info.width, height: info.height } : {}),
      createdAt,
      ...(actor ? { createdBy: actor } : {}),
    };
    // 書きかけのフォルダに全部書いてから名前を変える（途中で止まっても一覧に半端なものが出ない）
    const tmp = join(this.dir(requestId), `.tmp-${id}`);
    await mkdir(tmp, { recursive: true });
    try {
      await writeFile(join(tmp, `file.${EXT[a.format]}`), input.data);
      await writeFile(join(tmp, "meta.json"), JSON.stringify(withoutRequest(a), null, 2) + "\n");
      await rename(tmp, join(this.dir(requestId), id));
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      throw e;
    }
    return a;
  }

  /** 古い順。読めないものは invalid に理由（黙って捨てない） */
  async list(requestId: string): Promise<{ items: Attachment[]; invalid: { id: string; error: string }[] }> {
    const names = await readdir(this.dir(requestId)).catch(() => [] as string[]);
    const items: Attachment[] = [];
    const invalid: { id: string; error: string }[] = [];
    for (const id of names.filter((n) => !n.startsWith("."))) {
      try {
        items.push(await this.read(requestId, id));
      } catch (e) {
        invalid.push({ id, error: (e as Error).message });
      }
    }
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { items, invalid };
  }

  private async read(requestId: string, id: string): Promise<Attachment> {
    if (!ATTACHMENT_ID.test(id)) throw new AttachmentError("名前が A-YYYYMMDD-HHMMSS-xxxx ではありません");
    const dir = join(this.dir(requestId), id);
    const st = await lstat(dir);
    if (!st.isDirectory()) throw new AttachmentError("フォルダではありません");
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
    if (meta.id !== id || !(meta.format in EXT) || typeof meta.name !== "string") throw new AttachmentError("meta.json が読めません");
    return { ...meta, requestId };
  }

  async get(requestId: string, id: string): Promise<Attachment | undefined> {
    if (!ATTACHMENT_ID.test(id)) return undefined;
    return this.read(requestId, id).catch(() => undefined);
  }

  /** 原本を読む。保存したときの形式・大きさ・sha256 と合うかを確かめる（差し替えやシンボリックリンクは断る） */
  async content(requestId: string, id: string): Promise<{ meta: Attachment; data: Buffer }> {
    const meta = await this.get(requestId, id);
    if (!meta) throw new AttachmentError(`添付 ${id} がありません`);
    const file = this.fileOf(requestId, meta);
    const st = await lstat(file).catch(() => undefined);
    if (!st?.isFile()) throw new AttachmentError(`添付 ${id} の原本がありません`);
    const data = await readFile(file);
    if (data.length !== meta.bytes || createHash("sha256").update(data).digest("hex") !== meta.sha256) {
      throw new AttachmentError(`添付 ${id} の原本が保存したときと変わっています`);
    }
    return { meta, data };
  }

  async remove(requestId: string, id: string): Promise<void> {
    if (!(await this.get(requestId, id))) throw new AttachmentError(`添付 ${id} がありません`);
    // 先に名前を変えて一覧から外してから消す（消しかけを開始時のコピーが読まない）
    const del = join(this.dir(requestId), `.del-${id}-${randomBytes(2).toString("hex")}`);
    await rename(join(this.dir(requestId), id), del);
    await rm(del, { recursive: true, force: true });
  }

  /**
   * Preflight を始めるときに、今の添付を run の中へコピーして固定する。画像は <runDir>/ui/current/、xlsx は
   * <runDir>/attachments/ に置き、一覧を <runDir>/attachments.json に書く。コピーの途中で消された・変わったものがあれば
   * AttachmentError（その Preflight は始めない。原本は残る）
   */
  async snapshot(requestId: string, runDir: string): Promise<FixedAttachment[]> {
    const { items } = await this.list(requestId);
    const fixed: FixedAttachment[] = [];
    for (const a of items) {
      let data: Buffer;
      try {
        ({ data } = await this.content(requestId, a.id));
      } catch (e) {
        throw new AttachmentError(`添付を固定できません（始める間に添付が変わりました。もう一度始めてください）: ${(e as Error).message}`);
      }
      const path = a.format === "xlsx" ? `attachments/${a.id}.xlsx` : `ui/current/${a.id}.${EXT[a.format]}`;
      await mkdir(join(runDir, path, ".."), { recursive: true });
      await writeFile(join(runDir, path), data);
      const { requestId: _, ...rest } = a;
      fixed.push({ ...rest, path });
    }
    if (fixed.length) await writeFileAtomic(join(runDir, "attachments.json"), JSON.stringify(fixed, null, 2) + "\n");
    return fixed;
  }
}

const withoutRequest = ({ requestId: _, ...a }: Attachment) => a;
