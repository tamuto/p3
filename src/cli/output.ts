import { absRef } from "../shared/refs.ts";
import { relationRole, type Request, type SupersededMark, type Task } from "../shared/types.ts";
import { type P3Context } from "../core/context.ts";
import { resolve, titleOf } from "../core/ops.ts";
import { type Warning } from "../core/supersede.ts";
import { table } from "./format.ts";
import { taskWork } from "../core/workTargets.ts";
import { DIRECT_TASK_NOTE, LATER_PREFLIGHT_NOTE } from "../shared/directTask.ts";

/** CLI の出力（人向けの表と --json）と、表示の部品 */

// --- 表示 -----------------------------------------------------------------

export class Output {
  constructor(readonly json: boolean) {}
  result(data: unknown, human: () => string): number {
    process.stdout.write(this.json ? `${JSON.stringify(data, null, 2)}\n` : `${human()}\n`);
    return 0;
  }
}

/** 同じ要望の中で、このタスクに依存しているタスク */
export const dependentsOf = (ctx: P3Context, t: Task): Task[] =>
  ctx.ws.tasksOf(t.request).list().filter((x) => x.relations.some((r) => r.type === "depends_on" && r.target === t.id));

export function formatEntity(ctx: P3Context, item: Task | Request, file: string): string {
  const head = "ref" in item ? item.ref : item.id;
  const home = "ref" in item ? item.request : item.id;
  const lines = [`${head}  ${item.title}`, ""];
  if ("ref" in item) lines.push(`  ${"作業先".padEnd(11)} ${workHint(ctx, item).replace(/^作業先: /, "")}`);
  const skip = new Set(["id", "ref", "request", "title", "body", "relations", "repo", "record"]);
  for (const [k, v] of Object.entries(item)) {
    if (skip.has(k) || v === undefined || (Array.isArray(v) && !v.length)) continue;
    lines.push(`  ${k.padEnd(13)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  if (item.body.trim()) lines.push("", indent(item.body.trim()));
  if ("record" in item && item.record) lines.push("", "変更の記録:", indent(item.record));
  if ("ref" in item) {
    const out = item.relations.map((r) => `  → ${pad(relationRole(r.type, "out"))} ${r.target} ${titleOf(ctx, `${home}/${r.target}`)}`);
    const inc = [
      ...dependentsOf(ctx, item).map((t) => `  ← ${pad(relationRole("depends_on", "in"))} ${t.id} ${t.title}`),
      ...ctx.ws.tasksOf(home).list().filter((t) => t.relations.some((r) => r.type === "supersedes" && r.target === item.id)).map((t) => `  ← ${pad(relationRole("supersedes", "in"))} ${t.id} ${t.title}`),
    ];
    if (out.length || inc.length) lines.push("", "関係:", ...out, ...inc);
  }
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

/** シェルにそのまま貼れる引数（記号や空白を含むものは単引用符で囲む） */
export const shellArg = (s: string) => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Preflight を始められなかった・失敗したときの、直接タスクを作る道の案内（人向け。stderr か、エラーの文に付けて出す）。
 * --project / --dir を付けて呼ばれたら、同じ対象で動くようにそのまま付ける
 */
export function directTaskHint(rid: string, scope: { project?: string; dir?: string } = {}): string {
  const target = [scope.project && `--project ${shellArg(scope.project)}`, scope.dir && `--dir ${shellArg(scope.dir)}`].filter(Boolean).join(" ");
  return [
    "Preflight を通さずに、この要望へタスクを直接作ることもできます（Docker や ChatGPT の接続は要りません）:",
    `  p3 new "タスクの題" --req ${shellArg(rid)}${target ? ` ${target}` : ""} --body "作業内容と完了条件"`,
    `  ${DIRECT_TASK_NOTE}`,
    `  ${LATER_PREFLIGHT_NOTE}（p3 preflight ${shellArg(rid)}）`,
  ].join("\n");
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
  const w = Array.from(label).reduce((n, ch) => n + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return label + " ".repeat(Math.max(1, width - w));
}

/** 作業先の案内（このマシンのパスが無ければ登録の仕方） */
export function workHint(ctx: P3Context, t: Task): string {
  const w = taskWork(ctx.ws, t);
  if (!w.repo) return "作業先: なし";
  return `作業先: ${w.repo}${w.branch ? `  ブランチ ${w.branch}` : "（ブランチなし）"}${w.registered ? "" : `\n  このマシンのパスが未登録です: p3 repo path ${w.repo} <パス>`}`;
}

