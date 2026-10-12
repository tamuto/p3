import { absRef, parseRef } from "../shared/refs.ts";
import type { Request, SupersededMark, Task } from "../shared/types.ts";
import type { P3Context } from "../core/context.ts";
import { supersededWarnings, type Warning } from "../core/supersede.ts";
import { table } from "./format.ts";
import { taskWork } from "../core/workTargets.ts";
import { requestWorkstreams } from "../shared/workTarget.ts";

/**
 * show の短い出力（--brief）と、通常の出力と共通の項目。
 *
 * 短い出力は、AI がタスクを進めるのに要るものだけにする（本文は切り詰めない）:
 *   タスク: id・ref・request・title・status・body・rev・outputs・repoOutputs・依存（relations の depends_on）
 *          + work（作業先とそのブランチ）・dependencies（依存の相手と状態）・superseded・warnings
 *   要望:   id・title・status・body・rev・workstreams + branches（作業先ごとのブランチ）+
 *          タスクの一覧（id・ref・title・status・repo）・issue
 * 省くもの: 日時・areas・labels・変更者・ファイルのパス・依存以外の関係・関係しそう（暗黙の近さ）・影響範囲。
 * JSON の項目名と階層は通常の --json と同じで、項目を省くだけ（短い出力だけの別名は作らない）。
 */

/** 依存の相手とその状態。相手が見つからない（アーカイブした・参照の誤り）ときは title・status が null（完了とは扱わない） */
export interface DependencyState {
  ref: string;
  title: string | null;
  status: string | null;
}

export function dependencyStates(ctx: P3Context, task: Task): DependencyState[] {
  return task.relations
    .filter((r) => r.type === "depends_on")
    .map((r) => {
      const ref = absRef(r.target, task.request) ?? r.target;
      const p = parseRef(ref);
      const target = p?.task ? ctx.ws.task(ref) : ctx.ws.requests.get(ref);
      return { ref, title: target?.title ?? null, status: target?.status ?? null };
    });
}

/** タスクの詳細で共通に出す項目（通常・短い出力の両方） */
export function taskExtras(ctx: P3Context, task: Task, marks: Map<string, SupersededMark[]>) {
  const superseded = marks.get(task.ref) ?? [];
  const warnings: Warning[] = supersededWarnings(superseded, task.ref);
  return { superseded, dependencies: dependencyStates(ctx, task), warnings };
}

const BRIEF_TASK_KEYS = ["id", "ref", "request", "title", "status", "body", "rev", "outputs", "relations"] as const;

export function briefTask(ctx: P3Context, task: Task, marks: Map<string, SupersededMark[]>) {
  const item = Object.fromEntries(BRIEF_TASK_KEYS.map((k) => [k, task[k]])) as unknown as Pick<Task, (typeof BRIEF_TASK_KEYS)[number]> & Pick<Task, "repoOutputs" | "record">;
  item.relations = task.relations.filter((r) => r.type === "depends_on");
  if (task.repoOutputs?.length) item.repoOutputs = task.repoOutputs;
  // 変更の記録（完了したタスク）。経緯を知るために読む
  if (task.record) item.record = task.record;
  // 着手先: 作業先のリポジトリとそのブランチ（作業先なしは repo: null）
  return { item, work: taskWork(ctx.ws, task), ...taskExtras(ctx, task, marks) };
}

export function formatBriefTask(view: ReturnType<typeof briefTask>): string {
  const { item, work, dependencies, warnings } = view;
  const short = (ref: string) => (ref.startsWith(`${item.request}/`) ? ref.slice(item.request.length + 1) : ref);
  const lines = [`${item.ref}  ${item.title}`, `  status  ${item.status}  rev ${item.rev}`];
  lines.push(
    `  作業先  ${work.repo ? `${work.repo}${work.branch ? `  branch ${work.branch}` : "（ブランチなし）"}${work.registered ? "" : `  ※このマシンのパスが未登録（p3 repo path ${work.repo} <パス>）`}` : "なし"}`,
  );
  if (dependencies.length) {
    lines.push(`  依存    ${dependencies.map((d) => `${short(d.ref)} ${d.status ?? "（状態不明）"}`).join(" / ")}`);
  }
  for (const o of item.outputs) lines.push(`  成果物  ${o}`);
  for (const o of item.repoOutputs ?? []) lines.push(`  成果物  ${o.repo}: ${o.output}`);
  for (const w of warnings) lines.push(`※ ${w.message}`);
  if (item.body.trim()) lines.push("", item.body.trim());
  if (item.record) lines.push("", "## 変更の記録", item.record);
  return lines.join("\n");
}

export function briefRequest(ctx: P3Context, r: Request, issue: string | undefined) {
  const item: Pick<Request, "id" | "title" | "status" | "body" | "rev" | "workstreams"> = {
    id: r.id,
    title: r.title,
    status: r.status,
    body: r.body,
    rev: r.rev,
    ...(r.workstreams ? { workstreams: r.workstreams } : {}),
  };
  const branches = requestWorkstreams(r);
  const tasks = ctx.ws
    .tasksOf(r.id)
    .list()
    .map((t) => ({ id: t.id, ref: t.ref, title: t.title, status: t.status, repo: t.repo }));
  return { item, branches, tasks, ...(issue ? { issue } : {}) };
}

export function formatBriefRequest(view: ReturnType<typeof briefRequest>): string {
  const { item, branches, tasks, issue } = view;
  const names = Object.keys(branches);
  // ブランチは作業先ごと
  const branchLine = "";
  return [
    issue ? `※ ${issue}` : "",
    `${item.id}  ${item.title}`,
    `  status  ${item.status}  rev ${item.rev}${branchLine}`,
    ...(branchLine ? [] : names.map((n) => `  branch  ${n}: ${branches[n].branch}`)),
    item.body.trim() ? `\n${item.body.trim()}` : "",
    "",
    `タスク (${tasks.length}):`,
    table(tasks.map((t) => [`  ${t.id}`, t.status, t.repo ?? "（作業先なし）", t.title])) || "  （なし）",
  ]
    .filter((l, i) => l !== "" || i > 1)
    .join("\n");
}
