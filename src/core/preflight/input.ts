import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InputField, InputMatch, PreflightInput, PreflightRun, Request } from "../../shared/types.ts";
import { changedLabel, normalizeInput } from "../../shared/preflightInput.ts";

export { normalizeInput };

/**
 * Preflight の評価対象（要望のタイトルと本文）の固定と比較。正規化の規則は shared/preflightInput.ts。
 *
 * 比べるのは保存されたタイトルと本文そのもの（rev や lastPreflight では比べない。Preflight 自身の状態の更新や、
 * タグ・期限・ステータスだけの変更では古い評価にしない）。本文を元に戻せば一致に戻る。
 */

/** run の request.md（人が読む評価対象）。input と同じ内容にする */
export function renderRequestSnapshot(requestId: string, input: PreflightInput): string {
  return `# ${requestId} ${input.title}\n\n${input.body}`;
}

/**
 * run の評価対象。run.json の input が無い以前の run は request.md（`# <要望ID> <タイトル>\n\n<本文>`）から読む。
 * 読めない・形が違うときは理由を返す（一致とはみなさない）
 */
export async function runInput(run: PreflightRun, runDir: string): Promise<PreflightInput | { error: string }> {
  if (run.input) {
    const { title, body } = run.input as Partial<PreflightInput>;
    return typeof title === "string" && typeof body === "string" ? normalizeInput({ title, body }) : { error: "run.json の評価対象（input）が壊れています" };
  }
  let text: string;
  try {
    text = await readFile(join(runDir, "request.md"), "utf8");
  } catch {
    return { error: "この run には評価対象の記録（request.md）がありません" };
  }
  const m = /^# (\S+) ([^\r\n]*)(?:\r?\n\r?\n([\s\S]*))?$/.exec(text);
  if (!m || m[1] !== run.requestId) return { error: "この run の request.md の形が読めません" };
  return normalizeInput({ title: m[2], body: m[3] ?? "" });
}

/** 要望の題と本文の識別子（親の目的・子の要望を run に固定して比べる。正規化してから作る） */
export function inputHash(r: { title: string; body: string }): string {
  const n = normalizeInput(r);
  return createHash("sha256").update(`${n.title}\n${n.body}`).digest("hex").slice(0, 16);
}

/**
 * 親子の評価対象を比べる（run に記録が無ければ比べない）。変わった項目を返す。
 *   parent: 今の親が記録と違う・無い・題か本文が変わった / children: 今の子（この run の採用で作った子は除く）の集合か題・本文が違う
 */
export function compareFamily(saved: PreflightInput | undefined, runId: string, request: Request, parent: Request | undefined, children: readonly Request[]): InputField[] {
  const out: InputField[] = [];
  if (saved?.parent && (request.parent !== saved.parent.id || !parent || inputHash(parent) !== saved.parent.hash)) out.push("parent");
  if (saved?.children) {
    const now = children.filter((c) => !c.splitFrom?.startsWith(`${runId}/`)).map((c) => `${c.id}:${inputHash(c)}`).sort();
    const then = saved.children.map((c) => `${c.id}:${c.hash}`).sort();
    if (now.join(",") !== then.join(",")) out.push("children");
  }
  return out;
}

export function compareInput(saved: PreflightInput | { error: string }, current: { title: string; body: string }): InputMatch {
  if ("error" in saved) return { status: "unknown", reason: saved.error };
  const now = normalizeInput(current);
  const changed = (["title", "body"] as const).filter((k) => saved[k] !== now[k]);
  return changed.length ? { status: "changed", changed: [...changed] } : { status: "same" };
}

/** 評価対象が今の要望と違う（か分からない）run からタスク化しようとした */
export class StaleInputError extends Error {
  readonly code = "stale_input";
  constructor(
    readonly requestId: string,
    readonly runId: string,
    readonly match: InputMatch,
  ) {
    super(staleMessage(requestId, runId, match));
  }
}

export function staleMessage(requestId: string, runId: string, m: InputMatch): string {
  const why =
    m.status === "changed"
      ? `${runId} の評価のあとで要望の${changedLabel(m.changed)}が変わりました`
      : `${runId} が何を評価したか確かめられません（${m.reason ?? "不明"}）`;
  return `${why}。古い評価からはタスク化しません。今の内容でもう一度 Preflight を実行してください（p3 preflight ${requestId}）。この評価のままタスク化するなら、要望を評価した時点の内容に戻してください`;
}
