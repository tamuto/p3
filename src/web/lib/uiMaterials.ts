import {
  ATTACHMENT_FILE_LIMITS,
  ATTACHMENT_FORMATS,
  UI_MATERIAL_KINDS,
  type Attachment,
  type AttachmentFormat,
  type PreflightRun,
  type UiMaterial,
  type UiMaterialKind,
} from "../../shared/types.ts";

/** 画像の URL（要望 / run / 資料 ID。パスは使わない） */
export const materialUrl = (rid: string, runId: string, id: string) =>
  `/api/requests/${encodeURIComponent(rid)}/preflight/${encodeURIComponent(runId)}/ui/${encodeURIComponent(id)}`;
/** 要望の添付の原本 */
export const attachmentUrl = (rid: string, id: string) => `/api/requests/${encodeURIComponent(rid)}/attachments/${encodeURIComponent(id)}`;
/** run に固定した添付の原本と、xlsx から取り出した内容 */
export const fixedAttachmentUrl = (rid: string, runId: string, id: string, extract = false) =>
  `/api/requests/${encodeURIComponent(rid)}/preflight/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(id)}${extract ? "/extract" : ""}`;

/** タスク案の場所（画面資料の「対象」から移る） */
export const draftAnchor = (key: string) => `draft-${key}`;

export type UiTone = "slate" | "indigo" | "emerald" | "amber" | "rose";
export const KIND_TONE: Record<UiMaterialKind, UiTone> = { proposal: "indigo", current: "slate", spec: "emerald" };
export const kindLabel = (k: UiMaterialKind) => UI_MATERIAL_KINDS[k];

/** 画面資料の状態の表示（以前の run は記録なし） */
export function uiStatusView(run: Pick<PreflightRun, "ui" | "status">): { label: string; tone: UiTone; message?: string } {
  const ui = run.ui;
  if (!ui) return { label: "記録なし", tone: "slate", message: "以前の run なので、画面資料の記録がありません" };
  if (ui.status === "generating" || run.status === "running") return { label: "評価中", tone: "indigo", message: "評価が終わると、画面イメージを取り込みます" };
  if (ui.status === "not_needed") return { label: "不要", tone: "slate", message: ui.reason };
  if (ui.status === "ready") return { label: "そろっています", tone: "emerald" };
  return { label: "足りません", tone: "amber", message: ui.reason };
}

/** タスク化の前に知らせる不足（必要な画面イメージが無い。要るか分からないだけなら出さない） */
export function uiShortage(run: Pick<PreflightRun, "ui">): string | undefined {
  const ui = run.ui;
  if (!ui || ui.status !== "missing" || ui.needed !== true) return undefined;
  return `画面イメージが足りないままです（${ui.reason ?? "理由不明"}）。タスク化する前に画像を確かめるか、メモで再評価してください`;
}

/** 種類の順（提案 → 現状 → 仕様書から）に並べる */
export function sortMaterials(items: UiMaterial[]): UiMaterial[] {
  const order: UiMaterialKind[] = ["proposal", "current", "spec"];
  return [...items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.ceil(n / 1024))}KB`);
export const formatLabel = (a: Pick<Attachment, "format">) => ATTACHMENT_FORMATS[a.format];

/** 添付の入力欄（失敗しても入力を残し、選び直さずに再試行できる） */
export interface AttachForm {
  file: File | null;
  description: string;
  source: string;
  busy: boolean;
  error: string | null;
}
export const emptyAttachForm = (): AttachForm => ({ file: null, description: "", source: "", busy: false, error: null });

/** 添付を送る。成功したら入力を空に、失敗したら入力を残して理由を出す */
export async function submitAttach(form: AttachForm, send: (f: { file: File; description: string; source: string }) => Promise<unknown>): Promise<AttachForm> {
  if (!form.file) return { ...form, error: "ファイルを選んでください" };
  try {
    await send({ file: form.file, description: form.description, source: form.source });
    return emptyAttachForm();
  } catch (e) {
    return { ...form, busy: false, error: (e as Error).message };
  }
}

/** 選べるファイル */
export const ATTACH_ACCEPT = ".png,.jpg,.jpeg,.xlsx,image/png,image/jpeg,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** 作成と同時に添付するファイル（説明・出典つき）。失敗したら理由を持って残る */
export interface PendingAttach {
  key: string;
  file: File;
  description: string;
  source: string;
  error?: string;
}

/** 拡張子から形式を決める（中身はサーバで確かめる） */
export function attachFormatOf(name: string): AttachmentFormat | undefined {
  const ext = name.toLowerCase().split(".").pop();
  return ext === "png" ? "png" : ext === "jpg" || ext === "jpeg" ? "jpeg" : ext === "xlsx" ? "xlsx" : undefined;
}

/**
 * 作成の前に分かる問題（形式・1件の大きさ・件数・合計）。中身の確かめはサーバで行う。
 * items は各ファイルの問題（無ければ undefined）、total は全体の問題
 */
export function checkPending(files: Pick<File, "name" | "size">[]): { items: (string | undefined)[]; total?: string } {
  const L = ATTACHMENT_FILE_LIMITS;
  const items = files.map((f) => {
    const format = attachFormatOf(f.name);
    if (!format) return "PNG / JPEG / xlsx だけ添付できます";
    const max = format === "xlsx" ? L.xlsxBytes : L.imageBytes;
    return f.size > max ? `大きすぎます（上限 ${formatBytes(max)}）` : undefined;
  });
  const sum = files.reduce((n, f) => n + f.size, 0);
  const total =
    files.length > L.count ? `添付は1つの要望に ${L.count} 件までです` : sum > L.totalBytes ? `添付の合計が上限（${formatBytes(L.totalBytes)}）を超えます` : undefined;
  return { items, ...(total ? { total } : {}) };
}

/** 順に添付し、失敗したものだけを理由つきで返す。onProgress は送り終えた件数 */
export async function sendPending(
  items: PendingAttach[],
  send: (f: { file: File; description: string; source: string }) => Promise<unknown>,
  onProgress?: (done: number) => void,
): Promise<PendingAttach[]> {
  const failed: PendingAttach[] = [];
  for (const [i, it] of items.entries()) {
    try {
      await send({ file: it.file, description: it.description, source: it.source });
    } catch (e) {
      failed.push({ ...it, error: (e as Error).message });
    }
    onProgress?.(i + 1);
  }
  return failed;
}

/**
 * 作成時に添付できなかったファイル（要望の画面で付け直す）。この画面を開いている間だけ持つ（再読み込みで消える）。
 * 読むだけでは消さない（React の二重実行でも同じ値が返るように）。空を書くと消える
 */
const unsent = new Map<string, PendingAttach[]>();
export const unsentAttachments = (rid: string): PendingAttach[] => unsent.get(rid) ?? [];
export function setUnsentAttachments(rid: string, items: PendingAttach[]) {
  if (items.length) unsent.set(rid, items);
  else unsent.delete(rid);
}
