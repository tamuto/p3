import type { DefinitionInput, Executable, FileKind, MeasureType, RunKind, Switch } from "../../shared/definition.ts";

/**
 * 観測の定義の入力欄の中身（検証の前。そのまま編集途中の入力として観測に残す）と、定義との行き来。
 * 一覧の値（操作・引数）は1行に1つの文で持つ。v は入力欄の形の版（違う形の下書きは戻さない）
 */
export interface MeasureDraft {
  name: string;
  type: MeasureType;
  unit: string;
  description: string;
}
export interface RunDraft {
  kind: RunKind;
  premise: string;
  target: string;
  steps: string;
  judge: string;
  record: string;
  command: string;
  args: string;
  repo: string;
  cwd: string;
  path: string;
  invoke: string;
}
export interface ReplacementDraft {
  on: boolean;
  kind: FileKind;
  repo: string;
  path: string;
  operation: string;
  output: string;
  compare: string;
  switchWhen: string;
  invoke: string;
}
/** 実行できるもの（手順と準備の確かめ・前処理・後処理で共通）の入力欄 */
export interface ExecDraft {
  run: RunDraft;
  replacement: ReplacementDraft;
  history?: Switch[];
}
export interface ProcedureDraft extends ExecDraft {
  id: string;
  title: string;
  measures: string[];
}
export interface Draft {
  v: 2;
  title: string;
  category: string;
  description: string;
  expected: string;
  /** 前提の観測の ID・使う準備の ID（期待する結果と同じく、足す前の下書きには無い） */
  prerequisites: string[];
  preparations: string[];
  measures: MeasureDraft[];
  procedures: ProcedureDraft[];
}

const emptyRun = (): RunDraft => ({ kind: "ai-instruction", premise: "", target: "", steps: "", judge: "", record: "", command: "", args: "", repo: "", cwd: "", path: "", invoke: "" });
const emptyReplacement = (): ReplacementDraft => ({ on: false, kind: "ui-script", repo: "", path: "", operation: "", output: "", compare: "", switchWhen: "", invoke: "" });
export const emptyMeasure = (): MeasureDraft => ({ name: "", type: "number", unit: "", description: "" });
export const emptyExec = (): ExecDraft => ({ run: emptyRun(), replacement: emptyReplacement() });
export const emptyProcedure = (): ProcedureDraft => ({ id: "", title: "", measures: [], ...emptyExec() });

export const procedureDraft = <P extends Executable & { id: string; title: string; measures: string[] }>(p: P): ProcedureDraft => ({ id: p.id, title: p.title, measures: [...p.measures], ...execDraft(p) });

export function execDraft(p: Executable): ExecDraft {
  const r = p.run;
  const run: RunDraft = { ...emptyRun(), kind: r.kind };
  if (r.kind === "ai-instruction") Object.assign(run, { premise: r.premise ?? "", target: r.target, steps: r.steps.join("\n"), judge: r.judge, record: r.record });
  else if (r.kind === "command") Object.assign(run, { command: r.command, args: r.args.join("\n"), repo: r.repo ?? "", cwd: r.cwd ?? "" });
  else Object.assign(run, { repo: r.repo, path: r.path, invoke: r.invoke ?? "" });
  const rep = p.replacement;
  return { run, replacement: rep ? { ...rep, on: true, invoke: rep.invoke ?? "" } : emptyReplacement(), ...(p.history ? { history: p.history } : {}) };
}

export function toDraft(d?: DefinitionInput): Draft {
  if (!d) return { v: 2, title: "", category: "", description: "", expected: "", prerequisites: [], preparations: [], measures: [], procedures: [] };
  return {
    v: 2,
    title: d.title,
    category: d.category,
    description: d.description,
    expected: d.expected ?? "",
    prerequisites: d.prerequisites ?? [],
    preparations: d.preparations ?? [],
    measures: d.measures.map((m) => ({ name: m.name, type: m.type, unit: m.unit ?? "", description: m.description ?? "" })),
    procedures: d.procedures.map(procedureDraft),
  };
}

export const isDraft = (v: unknown): v is Draft => typeof v === "object" && v !== null && (v as Draft).v === 2;
/** 保存した下書き（期待する結果を足す前のものも読む） */
export const draftOf = (v: Draft): Draft => ({ ...v, expected: v.expected ?? "", prerequisites: v.prerequisites ?? [], preparations: v.preparations ?? [] });

const lines = (t: string) => t.split("\n").filter((x) => x.trim() !== "");

/** 入力欄から送る中身（種別に使わない欄は送らない。空の任意項目は検証が落とす） */
export function toInput(d: Draft): Record<string, unknown> {
  return {
    title: d.title,
    category: d.category,
    description: d.description,
    expected: d.expected,
    prerequisites: d.prerequisites,
    preparations: d.preparations,
    measures: d.measures.map((m) => ({ name: m.name, type: m.type, ...(m.type === "number" ? { unit: m.unit } : {}), description: m.description })),
    procedures: d.procedures.map((p) => ({ id: p.id, title: p.title, measures: p.measures, ...execInput(p) })),
  };
}

export function execInput(p: ExecDraft): Record<string, unknown> {
  const r = p.run;
  const run =
    r.kind === "ai-instruction"
      ? { kind: r.kind, premise: r.premise, target: r.target, steps: lines(r.steps), judge: r.judge, record: r.record }
      : r.kind === "command"
        ? { kind: r.kind, command: r.command, args: lines(r.args), repo: r.repo, cwd: r.cwd }
        : { kind: r.kind, repo: r.repo, path: r.path, invoke: r.invoke };
  const { on, ...rep } = p.replacement;
  return { run, ...(on ? { replacement: rep } : {}) };
}
