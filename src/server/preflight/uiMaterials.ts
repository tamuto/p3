import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreflightAssessment, UiMaterial, UiMaterials } from "../../shared/types.ts";

/**
 * Preflight の画面資料（run の ui/）。エンジンは画像と一覧を書き、P3 が確かめてから run に取り込む:
 *
 *   <runDir>/ui/index.json   資料の一覧（UI_INDEX_SPEC）
 *   <runDir>/ui/U1.png ...   画像（PNG / JPEG）
 *   <runDir>/ui/src/U1.html  原稿（HTML / CSS。画面には配信しない）
 *
 * パスはすべて ui/ からの相対。絶対パス・..・シンボリックリンク・拡張子と中身が合わない画像・上限を超える画像は取り込まない。
 * 資料が不正でも評価は消さず、取り込めなかった理由を残す。必要な画面イメージが足りなければ go を clarify にする（no_go は変えない）。
 */
export const UI_DIR = "ui";
export const UI_INDEX = "index.json";

/** 上限（1つの run あたり） */
export const UI_LIMITS = {
  items: 20,
  /** 1枚の大きさ */
  bytes: 5 * 1024 * 1024,
  /** 全部の大きさ */
  totalBytes: 30 * 1024 * 1024,
  width: 4096,
  height: 16384,
  pixels: 40_000_000,
} as const;

export const UI_INDEX_SPEC = `{
  "needed": true | false,          // 画面（UI）を伴う案があるか
  "reason": "不要の理由（needed が false のとき必須）",
  "targets": ["D1"],                // 画面イメージが要るタスク案（省くと items の drafts を合わせたもの）
  "items": [
    { "id": "U1", "file": "U1.png", "html": "src/U1.html", "title": "何の画面か",
      "drafts": ["D1", "D2"], "viewport": 1280, "assumptions": ["仮のデータで描いた"] }
  ]
}`;

export class UiMaterialError extends Error {}

export interface ImageInfo {
  format: "png" | "jpeg";
  width: number;
  height: number;
}

/** 画像の形式と大きさを中身から読む（PNG / JPEG だけ。ほかは undefined） */
export function imageInfo(buf: Buffer): ImageInfo | undefined {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.toString("latin1", 12, 16) === "IHDR") {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    // SOF（フレームの始まり）を探して大きさを読む
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return undefined;
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return undefined;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

const EXT: Record<string, ImageInfo["format"]> = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg" };
export const IMAGE_TYPES: Record<ImageInfo["format"], string> = { png: "image/png", jpeg: "image/jpeg" };

/** base の中の相対パスか（絶対パス・..・空の部分・\ を断る）。正規化した相対パスを返す */
export function safeRelative(rel: unknown): string | undefined {
  if (typeof rel !== "string" || !rel.trim()) return undefined;
  const p = rel.trim().replace(/^(\.\/)+/, "");
  if (p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p)) return undefined;
  const parts = p.split("/");
  if (parts.some((s) => !s || s === "." || s === "..")) return undefined;
  return parts.join("/");
}

/** base（それ自身も含む）から rel までのどこにもシンボリックリンクが無い、ふつうのファイルか。違えば理由 */
async function plainFileProblem(base: string, rel: string, dir = false): Promise<string | undefined> {
  const parts = rel.split("/");
  let cur = base;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) cur = join(cur, parts[i]);
    const st = await lstat(cur).catch(() => undefined);
    if (!st) return "ファイルがありません";
    if (st.isSymbolicLink()) return "シンボリックリンクは使えません";
    if (i < parts.length - 1 || dir ? !st.isDirectory() : !st.isFile()) return i < parts.length - 1 || dir ? "フォルダではありません" : "ふつうのファイルではありません";
  }
  return undefined;
}

/**
 * ui/ の中の画像を確かめて読む（取り込みと配信で同じ確かめ方をする）。
 * 返すのは中身と形式。だめなら UiMaterialError（理由）
 */
export async function readUiImage(uiDir: string, file: string): Promise<{ data: Buffer; info: ImageInfo }> {
  const rel = safeRelative(file);
  if (!rel) throw new UiMaterialError(`ui/ の中の相対パスではありません: ${String(file)}`);
  const ext = EXT[rel.slice(rel.lastIndexOf(".")).toLowerCase()];
  if (!ext) throw new UiMaterialError(`画像は PNG か JPEG（.png / .jpg / .jpeg）にしてください: ${rel}`);
  const problem = await plainFileProblem(uiDir, rel);
  if (problem) throw new UiMaterialError(`${rel}: ${problem}`);
  const full = join(uiDir, rel);
  const st = await lstat(full);
  if (st.size > UI_LIMITS.bytes) throw new UiMaterialError(`${rel}: 大きすぎます（${st.size} バイト。上限 ${UI_LIMITS.bytes}）`);
  const data = await readFile(full);
  const info = imageInfo(data);
  if (!info) throw new UiMaterialError(`${rel}: PNG / JPEG として読めません`);
  if (info.format !== ext) throw new UiMaterialError(`${rel}: 拡張子と中身の形式が合いません（中身は ${info.format}）`);
  if (!info.width || !info.height || info.width > UI_LIMITS.width || info.height > UI_LIMITS.height || info.width * info.height > UI_LIMITS.pixels) {
    throw new UiMaterialError(`${rel}: 画像の大きさが上限を超えています（${info.width}x${info.height}。幅 ${UI_LIMITS.width}・高さ ${UI_LIMITS.height} まで）`);
  }
  return { data, info };
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * エンジンが書いた ui/ を確かめて取り込む。draftKeys: この run のタスク案の D キー。
 * 一覧が無い・読めない・資料が不正でも例外にせず、状態と理由で返す
 */
export async function loadUiMaterials(runDir: string, runId: string, draftKeys: string[]): Promise<UiMaterials> {
  const uiDir = join(runDir, UI_DIR);
  const problems: string[] = [];
  const missing = (reason: string, extra: Partial<UiMaterials> = {}): UiMaterials => ({ status: "missing", reason, targets: [], items: [], problems, ...extra });

  const dirProblem = await plainFileProblem(runDir, UI_DIR, true);
  if (dirProblem === "ファイルがありません") return missing("画面資料の一覧（ui/index.json）がありません");
  if (dirProblem) return missing(`ui/ が使えません（${dirProblem}）`);
  const indexProblem = await plainFileProblem(uiDir, UI_INDEX);
  if (indexProblem) return missing(`画面資料の一覧（ui/index.json）が読めません（${indexProblem}）`, { needed: indexProblem === "ファイルがありません" ? undefined : true });

  let index: Record<string, unknown>;
  try {
    const raw = JSON.parse(await readFile(join(uiDir, UI_INDEX), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("オブジェクトではありません");
    index = raw;
  } catch (e) {
    // 一覧を書こうとしたが壊れている: 画面イメージが要る案だった可能性があるので、要るものとして足りない扱いにする
    return missing(`画面資料の一覧（ui/index.json）が JSON として読めません: ${(e as Error).message}`, { needed: true });
  }

  if (index.needed === false) {
    const reason = text(index.reason);
    if (!reason) problems.push("不要の理由が書かれていません");
    return { status: "not_needed", needed: false, reason: reason ?? "（理由が書かれていません）", targets: [], items: [], problems };
  }

  const keys = new Set(draftKeys);
  const rawItems = Array.isArray(index.items) ? index.items : [];
  if (!Array.isArray(index.items) && index.items !== undefined) problems.push("items が配列ではありません");
  if (rawItems.length > UI_LIMITS.items) problems.push(`資料が多すぎます（${rawItems.length} 件。先頭の ${UI_LIMITS.items} 件だけ取り込みます）`);

  const items: UiMaterial[] = [];
  let total = 0;
  for (const [i, raw] of rawItems.slice(0, UI_LIMITS.items).entries()) {
    const label = `items[${i}]`;
    if (!raw || typeof raw !== "object") {
      problems.push(`${label}: 読めません`);
      continue;
    }
    const r = raw as Record<string, unknown>;
    const id = text(r.id);
    if (!id || !ID.test(id)) {
      problems.push(`${label}: id は英数字・_・- で書いてください（${String(r.id)}）`);
      continue;
    }
    if (items.some((x) => x.id === id)) {
      problems.push(`${id}: id が重なっています`);
      continue;
    }
    if (r.kind !== undefined && r.kind !== "proposal") {
      problems.push(`${id}: エンジンが書けるのは提案（proposal）の画面イメージだけです（${String(r.kind)}）`);
      continue;
    }
    if (r.run !== undefined && r.run !== runId) {
      problems.push(`${id}: ほかの run（${String(r.run)}）の資料は取り込みません`);
      continue;
    }
    const drafts = strs(r.drafts);
    const unknown = drafts.filter((k) => !keys.has(k));
    if (unknown.length) problems.push(`${id}: 無いタスク案 ${unknown.join(", ")} を外しました`);
    const known = drafts.filter((k) => keys.has(k));
    if (!known.length) {
      problems.push(`${id}: 対象のタスク案（drafts）がありません`);
      continue;
    }
    let image: Awaited<ReturnType<typeof readUiImage>>;
    try {
      image = await readUiImage(uiDir, r.file as string);
    } catch (e) {
      if (!(e instanceof UiMaterialError)) throw e;
      problems.push(`${id}: ${e.message}`);
      continue;
    }
    if (total + image.data.length > UI_LIMITS.totalBytes) {
      problems.push(`${id}: 資料の合計が上限（${UI_LIMITS.totalBytes} バイト）を超えるので取り込みません`);
      continue;
    }
    total += image.data.length;
    let html: string | undefined;
    if (r.html !== undefined) {
      const h = safeRelative(r.html);
      const p = h && /\.html?$/i.test(h) ? await plainFileProblem(uiDir, h) : "ui/ の中の HTML ではありません";
      if (h && !p) html = h;
      else problems.push(`${id}: 原稿 ${String(r.html)} を記録しません（${p}）`);
    }
    const viewport = Number(r.viewport);
    items.push({
      id,
      kind: "proposal",
      file: safeRelative(r.file)!,
      format: image.info.format,
      width: image.info.width,
      height: image.info.height,
      bytes: image.data.length,
      title: text(r.title) ?? id,
      ...(text(r.source) ? { source: text(r.source) } : {}),
      ...(html ? { html, source: text(r.source) ?? `ui/${html}` } : {}),
      drafts: known,
      ...(Number.isInteger(viewport) && viewport > 0 ? { viewport } : {}),
      assumptions: strs(r.assumptions),
      run: runId,
    });
  }

  const declared = strs(index.targets);
  const unknownTargets = declared.filter((k) => !keys.has(k));
  if (unknownTargets.length) problems.push(`targets: 無いタスク案 ${unknownTargets.join(", ")} を外しました`);
  const targets = declared.length ? declared.filter((k) => keys.has(k)) : [...new Set(strs(rawItems.flatMap((r) => (r && typeof r === "object" ? (r as Record<string, unknown>).drafts : []) as unknown[])).filter((k) => keys.has(k)))];
  const covered = new Set(items.flatMap((x) => x.drafts));
  const lacking = targets.filter((k) => !covered.has(k));
  if (lacking.length) return { status: "missing", needed: true, reason: `画面イメージが足りないタスク案: ${lacking.join(", ")}`, targets, items, problems };
  if (!items.length) return { status: "missing", needed: true, reason: problems.length ? "取り込める画面イメージがありません" : "画面イメージがありません", targets, items, problems };
  return { status: "ready", needed: true, targets, items, problems };
}

/**
 * 必要な画面イメージが足りないとき、評価に反映する（go → clarify と確認事項）。no_go・clarify は変えない。
 * 一覧が無い（エンジンが画面資料を扱っていない）だけのときは変えない
 */
export function applyUiShortage(assessment: PreflightAssessment, ui: UiMaterials): UiMaterials {
  if (ui.status !== "missing" || ui.needed !== true) return ui;
  assessment.questions = [...assessment.questions, `画面イメージが足りません（${ui.reason}）。画面の内容を確かめてから進めるか、メモで再評価してください`];
  if (assessment.verdict !== "go") return ui;
  assessment.verdict = "clarify";
  return { ...ui, verdictAdjusted: { from: "go", to: "clarify" } };
}
