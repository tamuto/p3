import { absRef, parseRef } from "../shared/refs.ts";
import type { Request, SupersededMark, Task } from "../shared/types.ts";
import type { PcubeContext } from "../server/context.ts";
import { supersededWarnings, type Warning } from "../server/supersede.ts";
import { table } from "./format.ts";

/**
 * show の短い出力（--brief）と、通常の出力と共通の項目。
 *
 * 短い出力は、AI がタスクを進めるのに要るものだけにする（本文は切り詰めない）:
 *   タスク: id・ref・request・title・status・body・rev・outputs・依存（relations の depends_on）
 *          + dependencies（依存の相手と状態）・superseded・warnings
 *   要望:   id・title・status・body・rev・workstream + タスクの一覧（id・ref・title・status）・issue
 * 省くもの: 日時・areas・labels・変更者・ファイルのパス・依存以外の関係・関係しそう（暗黙の近さ）・影響範囲。
 * JSON の項目名と階層は通常の --json と同じで、項目を省くだけ（短い出力だけの別名は作らない）。
 */

/** 依存の相手とその状態。相手が見つからない（アーカイブした・参照の誤り）ときは title・status が null（完了とは扱わない） */
export interface DependencyState {
  ref: string;
  title: string | null;
  status: string | null;
}

export function dependencyStates(ctx: PcubeContext, task: Task): DependencyState[] {
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
export function taskExtras(ctx: PcubeContext, task: Task, marks: Map<string, SupersededMark[]>) {
  const superseded = marks.get(task.ref) ?? [];
  const warnings: Warning[] = supersededWarnings(superseded, task.ref);
  return { superseded, dependencies: dependencyStates(ctx, task), warnings };
}

const BRIEF_TASK_KEYS = ["id", "ref", "request", "title", "status", "body", "rev", "outputs", "relations"] as const;

export function briefTask(ctx: PcubeContext, task: Task, marks: Map<string, SupersededMark[]>) {
  const item = Object.fromEntries(BRIEF_TASK_KEYS.map((k) => [k, task[k]])) as Pick<Task, (typeof BRIEF_TASK_KEYS)[number]>;
  item.relations = task.relations.filter((r) => r.type === "depends_on");
  return { item, ...taskExtras(ctx, task, marks) };
}

export function formatBriefTask(view: ReturnType<typeof briefTask>): string {
  const { item, dependencies, warnings } = view;
  const short = (ref: string) => (ref.startsWith(`${item.request}/`) ? ref.slice(item.request.length + 1) : ref);
  const lines = [`${item.ref}  ${item.title}`, `  status  ${item.status}  rev ${item.rev}`];
  if (dependencies.length) {
    lines.push(`  依存    ${dependencies.map((d) => `${short(d.ref)} ${d.status ?? "（状態不明）"}`).join(" / ")}`);
  }
  for (const o of item.outputs) lines.push(`  成果物  ${o}`);
  for (const w of warnings) lines.push(`※ ${w.message}`);
  if (item.body.trim()) lines.push("", item.body.trim());
  return lines.join("\n");
}

export function briefRequest(ctx: PcubeContext, r: Request, issue: string | undefined) {
  const item: Pick<Request, "id" | "title" | "status" | "body" | "rev" | "workstream"> = {
    id: r.id,
    title: r.title,
    status: r.status,
    body: r.body,
    rev: r.rev,
    ...(r.workstream ? { workstream: r.workstream } : {}),
  };
  const tasks = ctx.ws
    .tasksOf(r.id)
    .list()
    .map((t) => ({ id: t.id, ref: t.ref, title: t.title, status: t.status }));
  return { item, tasks, ...(issue ? { issue } : {}) };
}

export function formatBriefRequest(view: ReturnType<typeof briefRequest>): string {
  const { item, tasks, issue } = view;
  return [
    issue ? `※ ${issue}` : "",
    `${item.id}  ${item.title}`,
    `  status  ${item.status}  rev ${item.rev}${item.workstream?.branch ? `  branch ${item.workstream.branch}` : ""}`,
    item.body.trim() ? `\n${item.body.trim()}` : "",
    "",
    `タスク (${tasks.length}):`,
    table(tasks.map((t) => [`  ${t.id}`, t.status, t.title])) || "  （なし）",
  ]
    .filter((l, i) => l !== "" || i > 1)
    .join("\n");
}
