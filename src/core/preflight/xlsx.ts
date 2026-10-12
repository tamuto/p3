import { inflateRawSync } from "node:zlib";
import { posix } from "node:path";
import { imageInfo, UI_LIMITS } from "./uiMaterials.ts";

/**
 * xlsx から、セルの文字・保存済みの値と、標準の埋め込み画像（PNG / JPEG）を取り出す（補助の仕様書として Preflight に渡す）。
 *
 * - 数式は計算しない。保存済みの値があればそれを、無ければ「未確認」とする
 * - 外部のブックや URL は取りに行かない。マクロ・OLE は動かさない（見つけたら未対応として記録する）
 * - XML の DOCTYPE（外部実体）は断る。実体は XML の決まった5つと数値の参照だけを戻す
 * - 図形・グラフ・リンクの画像・EMF などは描かない（見つけたら未対応として記録する）。Excel の見た目は再現しない
 * - ZIP の展開後の大きさ・項目数・セル数・画像の数と大きさ・処理時間に上限があり、超えたら打ち切りを記録する
 */
export const XLSX_LIMITS = {
  entries: 10_000,
  /** 1つの項目の展開後の大きさ */
  entryBytes: 30 * 1024 * 1024,
  /** 展開した合計 */
  totalBytes: 200 * 1024 * 1024,
  cells: 50_000,
  /** 取り出した文字の合計 */
  textChars: 1_000_000,
  images: 20,
  timeMs: 10_000,
} as const;

export class XlsxError extends Error {}

export interface XlsxImage {
  /** シートの名前 */
  sheet: string;
  /** 置いてある位置（左上のセル。例: B3） */
  anchor: string;
  format: "png" | "jpeg";
  width: number;
  height: number;
  data: Buffer;
}

export interface XlsxExtract {
  /** 取り出した内容（Markdown） */
  text: string;
  sheets: number;
  cells: number;
  images: XlsxImage[];
  /** 値が保存されていない数式など、確かめられなかったセルの数 */
  unknownCells: number;
  /** 打ち切ったもの */
  truncated: string[];
  /** 見つけたが扱わないもの（図形・グラフ・OLE・リンクの画像・外部参照など） */
  unsupported: string[];
}

interface Entry {
  name: string;
  method: number;
  compressed: number;
  uncompressed: number;
  offset: number;
}

function readEntries(buf: Buffer): Map<string, Entry> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError("ZIP の終わりが見つかりません");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > XLSX_LIMITS.entries) throw new XlsxError(`中のファイルが多すぎます（${count}）`);
  let at = buf.readUInt32LE(eocd + 16);
  const map = new Map<string, Entry>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new XlsxError("ZIP の一覧が壊れています");
    const nameLen = buf.readUInt16LE(at + 28);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    map.set(name, {
      name,
      method: buf.readUInt16LE(at + 10),
      compressed: buf.readUInt32LE(at + 20),
      uncompressed: buf.readUInt32LE(at + 24),
      offset: buf.readUInt32LE(at + 42),
    });
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return map;
}

class Zip {
  private entries: Map<string, Entry>;
  private used = 0;
  constructor(private buf: Buffer) {
    this.entries = readEntries(buf);
  }
  has(name: string) {
    return this.entries.has(name);
  }
  names() {
    return [...this.entries.keys()];
  }
  read(name: string): Buffer | undefined {
    const e = this.entries.get(name);
    if (!e) return undefined;
    const at = e.offset;
    if (at + 30 > this.buf.length || this.buf.readUInt32LE(at) !== 0x04034b50) throw new XlsxError(`${name}: ZIP の項目が壊れています`);
    const start = at + 30 + this.buf.readUInt16LE(at + 26) + this.buf.readUInt16LE(at + 28);
    const raw = this.buf.subarray(start, start + e.compressed);
    const limit = Math.min(XLSX_LIMITS.entryBytes, XLSX_LIMITS.totalBytes - this.used);
    let out: Buffer;
    if (e.method === 0) out = Buffer.from(raw);
    else if (e.method === 8) {
      try {
        out = inflateRawSync(raw, { maxOutputLength: limit + 1 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || /too large|maxOutputLength/i.test((err as Error).message)) {
          throw new XlsxError(`${name}: 展開すると大きすぎます`);
        }
        throw new XlsxError(`${name}: 展開できません`);
      }
    } else throw new XlsxError(`${name}: 対応していない圧縮方式です（${e.method}）`);
    if (out.length > limit) throw new XlsxError(`${name}: 展開すると大きすぎます`);
    this.used += out.length;
    return out;
  }
  text(name: string): string | undefined {
    const b = this.read(name);
    if (!b) return undefined;
    const s = b.toString("utf8");
    // 外部実体を使わせない（DOCTYPE があれば読まない）
    if (/<!DOCTYPE/i.test(s)) throw new XlsxError(`${name}: DOCTYPE を含む XML は読みません`);
    // 要素の名前空間の接頭辞（xdr: a: x: など。書いたソフトで違う）を外す。属性（r:id など）はそのまま
    return s.replace(/<(\/?)[A-Za-z_][\w.-]*:(?=[A-Za-z_])/g, "<$1");
  }
}

/** XML の文字を戻す（決まった5つと数値の参照だけ） */
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "amp") return "&";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name.replace(":", "\\:")}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? unescapeXml(m[2] ?? m[3] ?? "") : undefined;
};

/** <t> の文字を全部つなぐ（リッチテキストの断片を含む。ふりがな rPh は除く） */
const texts = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => unescapeXml(m[1] ?? "")).join("");

/** 関係（rels）: Id → { target（ZIP の中のパス）, type, external } */
function rels(zip: Zip, base: string): Map<string, { target: string; type: string; external: boolean }> {
  const file = posix.join(posix.dirname(base), "_rels", `${posix.basename(base)}.rels`);
  const xml = zip.text(file);
  const map = new Map<string, { target: string; type: string; external: boolean }>();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target") ?? "";
    const external = attr(m[0], "TargetMode") === "External";
    if (!id) continue;
    const resolved = external ? target : target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(posix.dirname(base), target));
    map.set(id, { target: resolved, type: attr(m[0], "Type") ?? "", external });
  }
  return map;
}

const colName = (n: number) => {
  let s = "";
  for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

const md = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n/g, " ⏎ ").trim();

/** xlsx（固定した原本）から取り出す。ブックとして読めなければ XlsxError */
export function extractXlsx(data: Buffer, title: string, now: () => number = Date.now): XlsxExtract {
  const started = now();
  const zip = new Zip(data);
  if (!zip.has("xl/workbook.xml")) throw new XlsxError("xl/workbook.xml がありません（xlsx のブックではありません）");
  const truncated: string[] = [];
  const unsupported = new Set<string>();
  const out: string[] = [];
  const images: XlsxImage[] = [];
  let cells = 0;
  let unknownCells = 0;
  let chars = 0;
  const timeUp = () => now() - started > XLSX_LIMITS.timeMs;

  if (zip.names().some((n) => /vbaProject\.bin$/i.test(n))) unsupported.add("マクロ（実行しません）");
  if (zip.names().some((n) => n.startsWith("xl/embeddings/"))) unsupported.add("埋め込みのオブジェクト（OLE。開きません）");
  if (zip.names().some((n) => n.startsWith("xl/externalLinks/"))) unsupported.add("外部のブックへの参照（取りに行きません）");
  if (zip.names().some((n) => n.startsWith("xl/charts/"))) unsupported.add("グラフ（描きません）");

  const shared: string[] = [];
  const ss = zip.text("xl/sharedStrings.xml");
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(texts(m[1] ?? ""));

  const wbXml = zip.text("xl/workbook.xml")!;
  const wbRels = rels(zip, "xl/workbook.xml");
  const sheets = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: attr(m[0], "name") ?? "?", rid: attr(m[0], "r:id") ?? "", state: attr(m[0], "state") }));

  let done = 0;
  for (const sheet of sheets) {
    if (timeUp()) {
      truncated.push(`時間の上限（${XLSX_LIMITS.timeMs / 1000} 秒）で、シート「${sheet.name}」から先を読んでいません`);
      break;
    }
    const rel = wbRels.get(sheet.rid);
    if (!rel || rel.external || !rel.target.startsWith("xl/")) {
      out.push(`## シート「${sheet.name}」\n（読めません: シートの場所が分かりません）`);
      continue;
    }
    const xml = zip.text(rel.target);
    if (!xml) {
      out.push(`## シート「${sheet.name}」\n（読めません: ${rel.target} がありません）`);
      continue;
    }
    done++;
    const lines: string[] = [`## シート「${sheet.name}」${sheet.state === "hidden" || sheet.state === "veryHidden" ? "（非表示のシート）" : ""}`];
    const merges = [...xml.matchAll(/<mergeCell\b[^>]*>/g)].map((m) => attr(m[0], "ref")).filter(Boolean);
    if (merges.length) lines.push(`結合セル: ${merges.slice(0, 200).join(", ")}${merges.length > 200 ? ` ほか ${merges.length - 200}` : ""}`);
    let stopped = false;
    for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (cells >= XLSX_LIMITS.cells || chars >= XLSX_LIMITS.textChars || timeUp()) {
        truncated.push(`${cells >= XLSX_LIMITS.cells ? `セル数の上限（${XLSX_LIMITS.cells}）` : chars >= XLSX_LIMITS.textChars ? "文字数の上限" : "時間の上限"}で、シート「${sheet.name}」の途中から先を読んでいません`);
        stopped = true;
        break;
      }
      const head = `<c${m[1]}>`;
      const body = m[2] ?? "";
      const ref = attr(head, "r") ?? "?";
      const t = attr(head, "t");
      const f = /<f\b[^>]*>([\s\S]*?)<\/f>|<f\b[^>]*\/>/.exec(body);
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value: string | undefined;
      if (t === "s") value = v !== undefined ? shared[Number(v)] : undefined;
      else if (t === "inlineStr") value = texts(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
      else if (t === "b") value = v === undefined ? undefined : v === "1" ? "TRUE" : "FALSE";
      else if (t === "e") value = v === undefined ? undefined : `エラー ${unescapeXml(v)}`;
      else value = v === undefined ? undefined : unescapeXml(v);
      if (f) {
        const formula = f[1] ? unescapeXml(f[1]) : "（共有の数式）";
        if (value === undefined || value === "") {
          unknownCells++;
          lines.push(`- ${ref}: =${md(formula)} → （値が保存されていません。未確認）`);
        } else lines.push(`- ${ref}: =${md(formula)} → ${md(value)}（保存済みの値）`);
      } else if (value !== undefined && value !== "") lines.push(`- ${ref}: ${md(value)}`);
      else continue;
      cells++;
      chars += lines.at(-1)!.length;
    }
    // 標準の図（drawing）の画像
    const sheetRels = rels(zip, rel.target);
    for (const r of sheetRels.values()) {
      if (r.external) unsupported.add(`シート「${sheet.name}」の外部への参照（取りに行きません）`);
      if (/\/oleObject$/.test(r.type)) unsupported.add(`シート「${sheet.name}」の埋め込みのオブジェクト（OLE）`);
    }
    const drawing = [...sheetRels.values()].find((r) => r.type.endsWith("/drawing") && !r.external);
    if (drawing && !stopped) lines.push(...readDrawing(zip, drawing.target, sheet.name, images, truncated, unsupported));
    out.push(lines.join("\n"));
  }

  const head = [
    `# ${title} から取り出した内容`,
    `範囲: シート ${done}/${sheets.length}・セル ${cells}・画像 ${images.length}${unknownCells ? `・値が保存されていない数式 ${unknownCells}（未確認）` : ""}`,
    "セルの文字と保存済みの値だけです。数式は計算していません。書式・図形・グラフなど見た目は再現していません。",
    ...(truncated.length ? ["打ち切り:", ...truncated.map((x) => `- ${x}`)] : []),
    ...(unsupported.size ? ["扱っていないもの（中身は未確認）:", ...[...unsupported].map((x) => `- ${x}`)] : []),
  ];
  return { text: `${[head.join("\n"), ...out].join("\n\n")}\n`, sheets: done, cells, images, unknownCells, truncated, unsupported: [...unsupported] };
}

function readDrawing(zip: Zip, path: string, sheet: string, images: XlsxImage[], truncated: string[], unsupported: Set<string>): string[] {
  const xml = zip.text(path);
  if (!xml) return [];
  const dRels = rels(zip, path);
  const lines: string[] = [];
  for (const m of xml.matchAll(/<(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/\1>/g)) {
    const a = m[0];
    const col = /<from>[\s\S]*?<col>(\d+)<\/col>[\s\S]*?<row>(\d+)<\/row>/.exec(a);
    const anchor = col ? `${colName(Number(col[1]))}${Number(col[2]) + 1}` : "（位置不明）";
    if (/<pic\b/.test(a)) {
      const embed = /<blip\b[^>]*r:embed\s*=\s*"([^"]+)"/.exec(a)?.[1];
      const link = /<blip\b[^>]*r:link\s*=\s*"([^"]+)"/.exec(a)?.[1];
      if (link && !embed) {
        unsupported.add(`シート「${sheet}」${anchor} のリンクの画像（取りに行きません）`);
        continue;
      }
      const r = embed ? dRels.get(embed) : undefined;
      if (!r || r.external) {
        unsupported.add(`シート「${sheet}」${anchor} の画像（場所が分かりません）`);
        continue;
      }
      if (images.length >= XLSX_LIMITS.images) {
        truncated.push(`画像の数の上限（${XLSX_LIMITS.images}）で、シート「${sheet}」${anchor} から先の画像を取り出していません`);
        break;
      }
      const data = zip.read(r.target);
      const info = data && imageInfo(data);
      if (!data || !info) {
        unsupported.add(`シート「${sheet}」${anchor} の画像（${posix.extname(r.target).slice(1) || "形式不明"}。PNG / JPEG ではありません）`);
        continue;
      }
      if (data.length > UI_LIMITS.bytes || info.width > UI_LIMITS.width || info.height > UI_LIMITS.height) {
        unsupported.add(`シート「${sheet}」${anchor} の画像（大きすぎます）`);
        continue;
      }
      images.push({ sheet, anchor, ...info, data });
      lines.push(`- 画像 ${images.length}: ${anchor} に置かれた ${info.format.toUpperCase()}（${info.width}x${info.height}）`);
    } else if (/<graphicFrame\b/.test(a)) unsupported.add(`シート「${sheet}」${anchor} のグラフ・図表（描きません）`);
    else if (/<(sp|grpSp|cxnSp)\b/.test(a)) {
      const label = texts(a);
      unsupported.add(`シート「${sheet}」${anchor} の図形（描きません${label ? `。中の文字: ${md(label).slice(0, 80)}` : ""}）`);
    }
  }
  return lines;
}
