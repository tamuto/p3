import { absRef } from "../shared/refs.ts";
import { relationRole, type Request, type SupersededMark, type Task } from "../shared/types.ts";
import { type P3Context } from "../core/context.ts";
import { resolve, titleOf } from "../core/ops.ts";
import { type Warning } from "../core/supersede.ts";
import { table } from "./format.ts";
import { taskWork } from "../core/workTargets.ts";

/** CLI の出力（人向けの表と --json）と、表示の部品 */

// --- 表示 -----------------------------------------------------------------

export class Output {
  constructor(readonly json: boolean) {}
  result(data: unknown, human: () => string): number {
    process.stdout.write(this.json ? `${JSON.stringify(data, null, 2)}\n` : `${human()}\n`);
    return 0;
  }
}

export function formatEntity(ctx: P3Context, item: Task | Request, graph: ReturnType<P3Context["index"]["neighborhood"]>, file: string): string {
  const head = "ref" in item ? item.ref : item.id;
  const home = "ref" in item ? item.request : item.id;
  /** 同じ要望の中は T003 と短く見せる */
  const short = (ref: string) => (ref.startsWith(`${home}/`) ? ref.slice(home.length + 1) : ref);
  const lines = [`${head}  ${item.title}`, ""];
  if ("ref" in item) lines.push(`  ${"作業先".padEnd(11)} ${workHint(ctx, item).replace(/^作業先: /, "")}`);
  const skip = new Set(["id", "ref", "request", "title", "body", "relations", "repo"]);
  for (const [k, v] of Object.entries(item)) {
    if (skip.has(k) || v === undefined || (Array.isArray(v) && !v.length)) continue;
    lines.push(`  ${k.padEnd(13)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  if (item.body.trim()) lines.push("", indent(item.body.trim()));
  if (graph.outgoing.length || graph.incoming.length) {
    lines.push("", "関係:");
    for (const e of graph.outgoing) {
      const origin = e.origin !== "human" ? `  [${e.origin}${e.weight !== undefined ? ` ${e.weight}` : ""}]` : "";
      lines.push(`  → ${pad(relationRole(e.type, "out"))} ${short(e.to)} ${titleOf(ctx, e.to)}${origin}`);
    }
    for (const e of graph.incoming) lines.push(`  ← ${pad(relationRole(e.type, "in"))} ${short(e.from)} ${titleOf(ctx, e.from)}`);
  }
  if (graph.implicit.length) {
    lines.push("", "関係しそう:");
    for (const r of graph.implicit) lines.push(`  ${r.score.toFixed(2)}  ${short(r.ref)} ${r.title}  (${r.reasons.join(" / ")})`);
  }
  if (graph.impactScope.length) lines.push("", `影響範囲: ${graph.impactScope.map(short).join(", ")}`);
  lines.push("", `ファイル: ${file}`);
  return lines.join("\n");
}

export function ambiguous(out: Output, ctx: P3Context, query: string, current?: string): number {
  const r = resolve(ctx, query, current);
  out.result(r, () =>
    r.candidates.length ? `候補が複数あります:\n${table(r.candidates.map((c) => [c.ref, c.score.toFixed(2), c.title]))}` : `見つかりません: ${query}`,
  );
  return r.candidates.length ? 1 : 2; // 候補が複数なら使い方の誤り（1）、何も無ければ見つからない（2）
}

/** 依存先（同じ要望なら T003、別の要望なら絶対参照） */
/** 置き換えられたタスクの印（同じ要望の中は T005 と短く） */
export const replacedBy = (t: Task, marks: Map<string, SupersededMark[]>) => {
  const m = marks.get(t.ref);
  return m?.length ? `※置換 ← ${m.map((x) => (x.from.startsWith(`${t.request}/`) ? x.from.slice(t.request.length + 1) : x.from)).join(",")}` : "";
};

/** タスクを変えた後、対応済の要望を進行中に戻していたら知らせる（requestOps が戻す）。戻した要望の ID を返す */
export function reopenedNote(rid: string | undefined): string | undefined {
  if (rid) process.stderr.write(`要望 ${rid} を対応済から進行中に戻しました（未完了のタスクがあるため）\n`);
  return rid;
}

/** 警告は stderr に出す（--json の stdout を汚さない。JSON では warnings フィールドで返す） */
export const warn = (warnings: Warning[]) => {
  for (const w of warnings) process.stderr.write(`警告: ${w.message}\n`);
};

export const deps = (t: Task) => {
  const d = t.relations.filter((r) => r.type === "depends_on").map((r) => (absRef(r.target, t.request)?.startsWith(`${t.request}/`) ? r.target : (absRef(r.target, t.request) ?? r.target)));
  return d.length ? `← ${d.join(",")}` : "";
};

export const bar = (ratio: number, width = 10) => {
  const n = Math.round(ratio * width);
  return `${"█".repeat(n)}${"░".repeat(width - n)}`;
};

export const indent = (s: string) => s.split("\n").map((l) => `  ${l}`).join("\n");

/** 関係の役割を同じ幅にそろえる（全角は2桁として数える。CLI の詳細で相手の列がそろうように） */
export function pad(label: string, width = 8): string {
  const w = [...label].reduce((n, ch) => n + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return label + " ".repeat(Math.max(1, width - w));
}

/** 作業先の案内（このマシンのパスが無ければ登録の仕方） */
export function workHint(ctx: P3Context, t: Task): string {
  const w = taskWork(ctx.ws, t);
  if (!w.repo) return "作業先: なし";
  return `作業先: ${w.repo}${w.branch ? `  ブランチ ${w.branch}` : "（ブランチなし）"}${w.registered ? "" : `\n  このマシンのパスが未登録です: p3 repo path ${w.repo} <パス>`}`;
}

