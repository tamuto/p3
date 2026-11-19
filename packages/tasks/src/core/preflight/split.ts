import { createHash } from "node:crypto";
import { normalizeTaskId } from "../../shared/refs.ts";
import type { PreflightRun, ProposedChild, Request, SplitDecision } from "../../shared/types.ts";

/**
 * 分割の run（子の要望の案）の規則（docs/architecture.md の「Preflight の分割の案」）。読み込みの検証・子の本文・採用の版。
 * 採用の手順（予約・作成・やり直し）は service.ts の adopt
 */

/** 子の案のキー（C1, C2, ...） */
const CHILD_KEY = /^C\d+$/;

/** 見出しの下の本文（無ければ空） */
function section(md: string, heading: string): string {
  const m = new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m").exec(md);
  return m?.[1]?.trim() ?? "";
}

/**
 * 案の読み込みの問題。あれば採用しない（直すか、再評価する）。
 *   タスク案と子の案の混在・キーの形と重なり・題・目的・完了条件の欠け・無い案を指す requires・親に無いタスクを指す overlaps
 */
export function draftProblems(run: Pick<PreflightRun, "drafts" | "children">, parentTasks: readonly string[]): string[] {
  const children = run.children;
  if (!children) return [];
  const problems: string[] = [];
  if (children.length && run.drafts.length) problems.push("タスク案（drafts/）と子の案（children/）が両方あります。1つの run はどちらか一方だけにしてください");
  const keys = children.map((c) => c.key);
  for (const k of new Set(keys.filter((k, i) => keys.indexOf(k) !== i))) problems.push(`子の案のキーが重なっています: ${k}`);
  for (const c of children) {
    if (!CHILD_KEY.test(c.key)) problems.push(`子の案のキーの形が違います: ${c.key}（C1, C2, ...）`);
    if (!c.title.trim()) problems.push(`${c.key}: 題がありません`);
    if (!section(c.description, "目的")) problems.push(`${c.key}: 「## 目的」がありません`);
    if (!section(c.description, "完了条件")) problems.push(`${c.key}: 「## 完了条件」がありません`);
    for (const r of c.requires) {
      if (r === c.key) problems.push(`${c.key}: 自分を前提にしています`);
      else if (!keys.includes(r)) problems.push(`${c.key}: 前提の ${r} という子の案はありません`);
    }
    for (const t of c.overlaps) {
      const id = normalizeTaskId(t) ?? t;
      if (!parentTasks.includes(id)) problems.push(`${c.key}: 重なるとした ${t} は親のタスクにありません`);
    }
  }
  return problems;
}

/** 評価の split を取り込む（形が揺れても弾かず、読めなければ無し） */
export function parseSplit(v: unknown): SplitDecision | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  if (s.decision !== "split" && s.decision !== "keep") return undefined;
  const n = Number(s.estimatedTasks);
  return {
    decision: s.decision,
    ...(s.estimatedTasks !== undefined && Number.isFinite(n) ? { estimatedTasks: Math.max(0, Math.round(n)) } : {}),
    reasons: Array.isArray(s.reasons) ? s.reasons.map(String) : [],
  };
}

/** 採用する案の版（題・本文・前提・重なり・採否）。確認のときと採用のときで比べる */
export function childrenVersion(children: readonly ProposedChild[]): string {
  const key = children.map((c) => [c.key, c.title, c.description, c.estimatedTasks ?? null, c.requires, c.overlaps, c.include]);
  return createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16);
}

/** 子の要望の本文: 出典・親の目的（採用のときの題と本文）・案の範囲・前提にする子 */
export function childBody(parent: Pick<Request, "id" | "title" | "body">, c: ProposedChild, runId: string, ids: Record<string, string>): string {
  const quote = (s: string) => (s.trim() ? s.trim().split("\n").map((l) => `> ${l}`).join("\n") : "> （本文なし）");
  const requires = c.requires.map((k) => `- ${k} → ${ids[k] ?? "（採用していない案）"}`);
  return [
    `> 親の要望 ${parent.id} を分割した子の要望（${runId} / ${c.key}）。添付は親の要望にあります`,
    "## 親の目的（採用のときの親の題と本文）",
    `> **${parent.title}**\n>\n${quote(parent.body)}`,
    c.description.trim(),
    ...(requires.length ? ["## 前提にする子の要望", requires.join("\n")] : []),
  ].join("\n\n");
}

/** 子の採用元の印（request.md の splitFrom） */
export const splitMarker = (runId: string, key: string) => `${runId}/${key}`;
