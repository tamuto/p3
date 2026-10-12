import { ATTACHMENT_FORMATS, UI_MATERIAL_KINDS, type Attachment, type PreflightRun, type UiMaterial, type UiMaterialKind } from "../../shared/types.ts";

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
