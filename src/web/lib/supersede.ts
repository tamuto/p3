import type { SupersedeCandidate, SupersededMark } from "../../shared/types.ts";

/** 置き換えた側を短く（同じ要望の中は T005、要望単位なら「要望」） */
export function markFrom(m: SupersededMark, requestId: string): string {
  if (m.from === requestId) return "要望";
  return m.from.startsWith(`${requestId}/`) ? m.from.slice(requestId.length + 1) : m.from;
}

/** 印の文言（例: 置き換え ← T005, 要望） */
export function markText(marks: SupersededMark[] | undefined, requestId: string): string {
  return marks?.length ? `置き換え ← ${marks.map((m) => markFrom(m, requestId)).join(", ")}` : "";
}

/**
 * タスク化で送るアーカイブの選択。今の候補にあるものだけを、候補として見た rev で送る
 * （採否を変えて候補から外れたものは送らない。rev が変わっていればサーバが競合として返す）。
 */
export function archiveSelection(candidates: SupersedeCandidate[], selected: ReadonlySet<string>): { id: string; rev: number }[] {
  return candidates.filter((c) => selected.has(c.id)).map((c) => ({ id: c.id, rev: c.rev }));
}

/** API の応答に添えられた警告の文言（無ければ空） */
export function warningText(res: unknown): string {
  const ws = (res as { warnings?: { message: string }[] } | undefined)?.warnings ?? [];
  return ws.map((w) => w.message).join(" / ");
}
