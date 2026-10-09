import type { PreflightNote, PreflightRun } from "../../shared/types.ts";
import { ApiError, type NotesInfo, type api as Api } from "./api.ts";

/** 次の Preflight が何を引き継ぐか（実行する前に見せる） */
export function nextRunLabel(info: Pick<NotesInfo, "notes" | "previous" | "previousSkipped">): string {
  const pending = info.notes.filter((n) => n.pending).length;
  const prev = info.previous
    ? `前回 ${info.previous} の結果を引き継ぎます`
    : info.previousSkipped
      ? `前回の結果は引き継ぎません（${info.previousSkipped}）`
      : "最初の評価です";
  return `次の Preflight: ${prev}。メモ ${pending} 件を渡します。`;
}

export type SubmitResult =
  | { kind: "saved"; note: PreflightNote }
  | { kind: "started"; run: PreflightRun }
  /** メモは保存したが実行を始められなかった。再試行はメモを書き直さず Preflight だけ */
  | { kind: "not-started"; note: PreflightNote; error: string };

/** メモを保存する（run: 続けて Preflight を実行する）。空のメモは送らない */
export async function submitNote(
  client: Pick<typeof Api, "addNote" | "startPreflight">,
  rid: string,
  body: string,
  run: boolean,
): Promise<SubmitResult> {
  const text = body.trim();
  if (!text) throw new Error("メモが空です");
  if (!run) return { kind: "saved", note: await client.addNote(rid, text) };
  try {
    return { kind: "started", run: await client.startPreflight(rid, { note: text }) };
  } catch (e) {
    const note = e instanceof ApiError ? (e.body as { note?: PreflightNote }).note : undefined;
    if (note) return { kind: "not-started", note, error: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}
