import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { AcceptanceOp } from "../shared/acceptance.ts";
import {
  ANSWER_STATE_LABEL,
  clarificationStates,
  criteriaSourceView,
  requestRequirementView,
  RequirementInputError,
  SOURCE_STATE_LABEL,
  type AnswerInput,
  type Clarification,
  type CriteriaSourceView,
  type SourceOp,
} from "../shared/requirementSource.ts";
import type { ProposedTask } from "../../../shared/types.ts";
import { resolveRequestId } from "../../../core/ops.ts";
import { saveClarifyAnswer, updateRequirement, updateTask } from "../../../core/requestOps.ts";
import { NotFoundError } from "../../../core/store/collection.ts";
import { pickRun } from "../../../cli/preflightCommands.ts";
import { UsageError } from "@infodb/p3-shared/node/usage.ts";
import type { CommandEnv } from "../../../cli/args.ts";
import { formatRequirement, sourceLines } from "../../../cli/showView.ts";

/**
 * 要求の根拠（出典・確かめた人・日・根拠）と、Preflight の確認事項への回答のコマンド（規則は shared/requirementSource.ts）。
 *
 *   source [<要望>] [ls]                              要望の根拠の記録と状態（回答も）
 *   source [<要望>] add|edit <S>|confirm <S>|rm <S>   要望の根拠の記録を変える
 *   source <T001|D1> [<基準>] [add|edit|confirm|rm]   受け入れ基準ごとの記録（D1 はタスク案。--run で run、省くと最新）
 *   source <対象> --sources-json ops.json|-           操作をまとめて当てる（複数行の根拠はこちら）
 *   clarify [<要望>] [--run <run>]                    確認事項（確認先・質問・必要な根拠・判断への影響）と回答の状態
 *   answer [<要望>] <Q> --body 回答|- [...]           確認事項に回答する（要望に残す。過去の run は書き換えない）
 *   answer [<要望>] <Q> rm                            回答を消す
 */

/** source の操作の語（対象・基準の ID と見分ける。読むだけの判定 readOnly.ts も使う） */
export const SOURCE_SUBS = new Set(["ls", "show", "add", "edit", "set", "confirm", "rm", "remove"]);

/** 標準入力（-）は1つの項目にだけ */
function readText(v: string | undefined, flag: string, used: { stdin?: string }): string | undefined {
  if (v === undefined) return undefined;
  if (v !== "-") return v;
  if (used.stdin) throw new UsageError(`標準入力（-）は ${used.stdin} と ${flag} のどちらか一方だけに使えます（もう一方はファイルか文字で渡してください）`);
  used.stdin = flag;
  return readFileSync(0, "utf8");
}

function readJsonFile(file: string, flag: string): unknown {
  let src: string;
  try {
    src = file === "-" ? readFileSync(0, "utf8") : readFileSync(resolvePath(process.cwd(), file), "utf8");
  } catch {
    throw new UsageError(`${flag} のファイルが読めません: ${file}`);
  }
  try {
    return JSON.parse(src);
  } catch (e) {
    throw new UsageError(`${flag} が JSON として読めません: ${(e as Error).message}`);
  }
}

function formatCriteriaSources(head: string, v: CriteriaSourceView, problems: readonly string[] = []): string {
  const lines = [head];
  if (!v.items.length) lines.push("  受け入れ基準なし");
  for (const i of v.items) {
    lines.push(`  ${i.id}  [${SOURCE_STATE_LABEL[i.state]}]  ${i.text}`);
    for (const s of i.sources) lines.push(...sourceLines(s, "      "));
  }
  if (v.orphans.length) {
    lines.push("  対応先不明（基準を消した・参照元が無い）:");
    for (const s of v.orphans) lines.push(...sourceLines(s, "      ").map((l, n) => (n ? l : `${l}  基準 ${s.criterionId}`)));
  }
  for (const p of problems) lines.push(`  ※読めない: ${p}`);
  return lines.join("\n");
}

/** フラグから1つの操作を作る */
function sourceOpFromFlags(env: CommandEnv, sub: string, id: string | undefined): SourceOp {
  const { o } = env;
  const used: { stdin?: string } = {};
  const fields = {
    ...(o.target?.length ? { target: o.target.join(" ") } : {}),
    ...(o.source !== undefined ? { source: o.source } : {}),
    ...(o.grounds !== undefined ? { basis: readText(o.grounds, "--grounds", used) } : {}),
  };
  const confirm = o.by !== undefined || o.on !== undefined ? { by: o.by ?? "", on: o.on ?? "" } : undefined;
  const needId = () => {
    if (!id) throw new UsageError(`使い方: p3 source ... ${sub} <S1>`);
    return id;
  };
  switch (sub) {
    case "add":
      return { op: "add", ...fields, ...(o.from ? { from: o.from } : {}), ...(confirm ? { confirm } : {}) };
    case "edit":
    case "set":
      return { op: "edit", id: needId(), ...fields, ...(confirm ? { confirm } : {}) };
    case "confirm":
      if (!confirm) throw new UsageError("使い方: p3 source ... confirm <S1> --by <確かめた役割・アクター> --on YYYY-MM-DD");
      return { op: "confirm", id: needId(), ...confirm };
    case "rm":
    case "remove":
      return { op: "remove", id: needId() };
  }
  throw new UsageError(`source の操作は add / edit / confirm / rm です: ${sub}`);
}

export async function requirementCommand(cmd: string, env: CommandEnv): Promise<number | undefined> {
  switch (cmd) {
    case "source":
    case "sources":
      return sourceCommand(env);
    case "clarify":
      return clarifyCommand(env);
    case "answer":
      return answerCommand(env);
  }
  return undefined;
}

async function sourceCommand(env: CommandEnv): Promise<number> {
  const { args } = env;
  const head = args[0];
  if (head && /^(?:([^/]+)\/)?D\d+$/i.test(head)) return criterionSources(env, "draft");
  if (head && /^(?:[^/]+\/)?T\d+$/i.test(head)) return criterionSources(env, "task");
  return requestSources(env);
}

async function requestSources(env: CommandEnv): Promise<number> {
  const { ctx, out, args, o, actor, expectedRev, requestArg } = env;
  const rid = args[0] && !SOURCE_SUBS.has(args[0]) ? requestArg(args[0]) : requestArg(undefined);
  const rest = args[0] && !SOURCE_SUBS.has(args[0]) ? args.slice(1) : args;
  const [sub, id] = rest;
  const view = () => requestRequirementView(ctx.ws.requests.require(rid));
  const show = () => [`${rid}  ${ctx.ws.requests.require(rid).title}`, ...formatRequirement(view())].join("\n");
  const json = o["sources-json"];
  if (json === undefined && (sub === undefined || sub === "ls" || sub === "show")) return out.result({ request: rid, ...view() }, show);
  let ops: SourceOp[];
  if (json !== undefined) {
    if (sub !== undefined) throw new UsageError("--sources-json と add / edit などの操作は一緒に使えません");
    const raw = readJsonFile(json, "--sources-json");
    if (!Array.isArray(raw)) throw new UsageError("--sources-json は操作の並び（[{\"op\":\"add\",...}]）です");
    ops = raw as SourceOp[];
  } else ops = [sourceOpFromFlags(env, sub, id)];
  const r = await updateRequirement(ctx, rid, ops, { expectedRev, actor });
  return out.result({ request: rid, rev: r.rev, ...requestRequirementView(r) }, () => [`更新: ${rid} (rev ${r.rev})`, ...formatRequirement(requestRequirementView(r))].join("\n"));
}

async function criterionSources(env: CommandEnv, kind: "task" | "draft"): Promise<number> {
  const { ctx, out, args, o, actor, expectedRev, taskArg, requestArg } = env;
  const [target, ...after] = args;
  // 基準の ID（A1）は省ける（一覧だけ）
  const criterion = after[0] && !SOURCE_SUBS.has(after[0]) ? after[0] : undefined;
  const [sub, id] = criterion ? after.slice(1) : after;
  const json = o["sources-json"];
  const listOnly = json === undefined && (sub === undefined || sub === "ls" || sub === "show");
  let ops: { id: string; source: SourceOp }[] = [];
  if (!listOnly) {
    if (json !== undefined) {
      if (sub !== undefined) throw new UsageError("--sources-json と add / edit などの操作は一緒に使えません");
      const raw = readJsonFile(json, "--sources-json");
      if (!Array.isArray(raw)) throw new UsageError("--sources-json は操作の並び（[{\"criterion\":\"A1\",\"op\":\"add\",...}]）です");
      ops = raw.map((x: unknown, i) => {
        const { criterion: c, ...op } = (x && typeof x === "object" ? x : {}) as { criterion?: string } & SourceOp;
        const cid = c ?? criterion;
        if (!cid) throw new UsageError(`--sources-json の ${i + 1} 件目に基準の ID（criterion）がありません`);
        return { id: cid, source: op };
      });
    } else {
      if (!criterion) throw new UsageError(`使い方: p3 source ${target} <基準の ID> ${sub} ...`);
      ops = [{ id: criterion, source: sourceOpFromFlags(env, sub, id) }];
    }
  }
  if (kind === "task") {
    const ref = taskArg(target);
    const rid = ref.split("/")[0];
    const reqIds = () => (ctx.ws.requests.get(rid)?.requirementSources ?? []).map((s) => s.id);
    const render = (t: { ref: string; acceptanceCriteria?: { id: string; text: string }[]; acceptanceSources?: Parameters<typeof criteriaSourceView>[1]; acceptanceProblems?: string[] }) =>
      criteriaSourceView(t.acceptanceCriteria, t.acceptanceSources, reqIds());
    if (listOnly) {
      const t = ctx.ws.requireTask(ref);
      const v = render(t);
      return out.result({ ref: t.ref, rev: t.rev, ...v, problems: t.acceptanceProblems ?? [] }, () => formatCriteriaSources(`${t.ref}  ${t.title} の基準ごとの出典と確認`, v, t.acceptanceProblems));
    }
    const acceptance: AcceptanceOp[] = ops.map((x) => ({ op: "source", id: x.id, source: x.source }));
    const r = await updateTask(ctx, rid, ref.split("/")[1], { acceptance }, { expectedRev, actor });
    if (r.checkCleared) process.stderr.write(`${r.checkCleared}\n`);
    const v = render(r.task);
    return out.result({ ref: r.task.ref, rev: r.task.rev, ...v, ...(r.checkCleared ? { checkCleared: r.checkCleared } : {}) }, () => formatCriteriaSources(`更新: ${r.task.ref} (rev ${r.task.rev})`, v));
  }
  // タスク案
  const m = /^(?:([^/]+)\/)?(D\d+)$/i.exec(target)!;
  const rid = m[1] ? resolveRequestId(ctx, m[1]) : requestArg(undefined);
  if (!rid) throw new NotFoundError(m[1] ?? "要望");
  const key = m[2].toUpperCase();
  const run = await pickRun(ctx, rid, o.run);
  const d = run.drafts.find((x) => x.key === key);
  if (!d) throw new NotFoundError(`${run.id}/${key}`);
  const reqIds = (ctx.ws.requests.get(rid)?.requirementSources ?? []).map((s) => s.id);
  const head = (x: ProposedTask) => `${rid} / ${run.id} / ${x.key}  ${x.title} の基準ごとの出典と確認`;
  if (listOnly) {
    const v = criteriaSourceView(d.acceptanceCriteria, d.acceptanceSources, reqIds);
    return out.result({ request: rid, run: run.id, key, ...v, problems: d.acceptanceProblems ?? [] }, () => formatCriteriaSources(head(d), v, d.acceptanceProblems));
  }
  if (run.materialized?.length || run.children) throw new UsageError(`${run.id} はタスク化済みか子の要望の案の run です（タスクの記録は p3 source <T>）`);
  const saved = await ctx.preflight.updateDraft(rid, run.id, key, { sourceOps: ops }, { expectedSources: d.acceptanceSources ?? [], actor });
  const v = criteriaSourceView(saved.acceptanceCriteria, saved.acceptanceSources, reqIds);
  return out.result({ request: rid, run: run.id, key, ...v, problems: saved.acceptanceProblems ?? [] }, () => formatCriteriaSources(head(saved), v, saved.acceptanceProblems));
}

/** 要望と run の確認事項（構造化した確認事項が無い以前の run は文の確認事項だけ） */
async function runClarifications(env: CommandEnv, raw: string | undefined) {
  const { ctx, o, requestArg } = env;
  const rid = requestArg(raw);
  const run = await pickRun(ctx, rid, o.run);
  return { rid, run, clarifications: run.assessment?.clarifications ?? [] };
}

async function clarifyCommand(env: CommandEnv): Promise<number> {
  const { ctx, out, args } = env;
  if (args.length > 1) throw new UsageError("使い方: p3 clarify [<要望>] [--run <run>]");
  const { rid, run, clarifications } = await runClarifications(env, args[0]);
  const r = ctx.ws.requests.require(rid);
  const items = clarificationStates(run.id, clarifications, r.clarifyAnswers, r.requirementSources);
  const questions = run.assessment?.questions ?? [];
  const problems = run.assessment?.clarificationProblems ?? [];
  return out.result({ request: rid, run: run.id, verdict: run.assessment?.verdict ?? null, items, questions, problems }, () => {
    const lines = [`${rid} / ${run.id}  判定 ${run.assessment?.verdict ?? "（評価なし）"}`];
    if (!items.length) lines.push("構造化した確認事項はありません（以前の run か、確認事項なし）");
    for (const i of items) {
      const q = i.clarification;
      lines.push(
        `  ${q.id}  [${ANSWER_STATE_LABEL[i.state]}]  ${q.question}`,
        `      確認先: ${q.ask}`,
        `      対象: ${q.target}`,
        ...(q.needed ? [`      必要な根拠: ${q.needed}`] : []),
        ...(q.impact ? [`      判断への影響: ${q.impact}`] : []),
        ...(i.answer ? [`      回答${i.answer.by || i.answer.on ? `（${[i.answer.by, i.answer.on].filter(Boolean).join("・")}）` : ""}: ${i.answer.answer.split("\n").join("\n            ")}`] : []),
      );
    }
    if (questions.length) lines.push("確認事項（文）:", ...questions.map((x) => `  - ${x}`));
    for (const p of problems) lines.push(`  ※読めない確認事項: ${p}`);
    if (items.length) lines.push(`回答: p3 answer ${rid} <Q> --body <回答> [--by <役割> --on YYYY-MM-DD --source <出典> --grounds <根拠> --link <S1>] --run ${run.id}`);
    lines.push(`回答を保存したら、明示して再評価します: p3 preflight ${rid}`);
    return lines.join("\n");
  });
}

async function answerCommand(env: CommandEnv): Promise<number> {
  const { ctx, out, args, o, actor, expectedRev } = env;
  // answer [<要望>] <Q> [rm]
  const looksQ = (x: string | undefined) => !!x && /^[A-Za-z0-9._-]{1,32}$/.test(x) && !resolveRequestId(ctx, x);
  const [a0, a1, a2] = args;
  const [rawRid, qid, tail] = looksQ(a0) ? [undefined, a0, a1] : [a0, a1, a2];
  if (!qid) throw new UsageError("使い方: p3 answer [<要望>] <Q1> --body 回答|- [--by <役割> --on YYYY-MM-DD --source <出典> --grounds <根拠> --link <S1>] [--run <run>]");
  const { rid, run, clarifications } = await runClarifications(env, rawRid);
  const q: Clarification | undefined = clarifications.find((x) => x.id === qid);
  if (!q) throw new UsageError(`${run.id} に確認事項 ${qid} はありません${clarifications.length ? `（${clarifications.map((x) => x.id).join(", ")}）` : "（構造化した確認事項がありません。以前の run の文の確認事項にはメモで答えます: p3 note）"}`);
  if (tail === "rm" || tail === "remove") {
    const r = await saveClarifyAnswer(ctx, rid, run.id, q, null, { expectedRev, actor });
    return out.result({ request: rid, rev: r.request.rev, run: run.id, question: q.id, removed: true }, () => `回答を消しました: ${rid} ${run.id}/${q.id}`);
  }
  if (tail !== undefined) throw new UsageError(`answer の操作は rm だけです: ${tail}`);
  let input: AnswerInput;
  if (o["answer-json"] !== undefined) {
    if (o.body !== undefined || o.grounds !== undefined) throw new UsageError("--answer-json と --body / --grounds は一緒に使えません");
    const raw = readJsonFile(o["answer-json"], "--answer-json");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UsageError("--answer-json は {\"answer\": ..., \"by\": ..., \"on\": ..., \"source\": ..., \"basis\": ..., \"links\": [...]} の形です");
    input = raw as AnswerInput;
  } else {
    const used: { stdin?: string } = {};
    const answer = readText(o.body, "--body", used);
    if (answer === undefined) throw new UsageError("回答を --body で書いてください（複数行は --body - か --answer-json）");
    input = { answer, by: o.by, on: o.on, source: o.source, basis: readText(o.grounds, "--grounds", used), links: o.link };
  }
  try {
    const r = await saveClarifyAnswer(ctx, rid, run.id, q, input, { expectedRev, actor });
    return out.result({ request: rid, rev: r.request.rev, run: run.id, question: q.id, answer: r.answer ?? null }, () =>
      [`回答を要望に残しました: ${rid} ${run.id}/${q.id}（rev ${r.request.rev}）`, "回答だけでは根拠の記録を「確認記録あり」にしません（確認は p3 source ... confirm）", `今の内容で評価し直すなら: p3 preflight ${rid}`].join("\n"),
    );
  } catch (e) {
    if (e instanceof RequirementInputError) throw new UsageError(e.message);
    throw e;
  }
}
