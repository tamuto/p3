import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { ANSWER_STATE_LABEL, clarificationStates, RequirementInputError, type AnswerInput, type Clarification } from "../shared/clarify.ts";
import { resolveRequestId } from "../../../core/ops.ts";
import { saveClarifyAnswer } from "../../../core/requestOps.ts";
import { pickRun } from "../../../cli/preflightCommands.ts";
import { UsageError } from "@infodb/p3-shared/node/usage.ts";
import type { CommandEnv } from "../../../cli/args.ts";

/**
 * Preflight の確認事項への回答のコマンド（規則は shared/clarify.ts）。
 *
 *   clarify [<要望>] [--run <run>]                    確認事項（確認先・質問・必要な根拠・判断への影響）と回答の状態
 *   answer [<要望>] <Q> --body 回答|- [--by --on]     確認事項に回答する（要望に残す。過去の run は書き換えない）
 *   answer [<要望>] <Q> rm                            回答を消す
 */

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

export async function requirementCommand(cmd: string, env: CommandEnv): Promise<number | undefined> {
  switch (cmd) {
    case "clarify":
      return clarifyCommand(env);
    case "answer":
      return answerCommand(env);
  }
  return undefined;
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
  const items = clarificationStates(run.id, clarifications, r.clarifyAnswers);
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
    if (items.length) lines.push(`回答: p3 answer ${rid} <Q> --body <回答> [--by <役割> --on YYYY-MM-DD] --run ${run.id}`);
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
  if (!qid) throw new UsageError("使い方: p3 answer [<要望>] <Q1> --body 回答|- [--by <役割> --on YYYY-MM-DD] [--run <run>]");
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
    if (o.body !== undefined) throw new UsageError("--answer-json と --body は一緒に使えません");
    const raw = readJsonFile(o["answer-json"], "--answer-json");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UsageError('--answer-json は {"answer": ..., "by": ..., "on": ...} の形です');
    const { answer, by, on } = raw as Record<string, unknown>;
    input = { answer: String(answer ?? ""), ...(typeof by === "string" ? { by } : {}), ...(typeof on === "string" ? { on } : {}) };
  } else {
    const answer = o.body === "-" ? readFileSync(0, "utf8") : o.body;
    if (answer === undefined) throw new UsageError("回答を --body で書いてください（複数行は --body - か --answer-json）");
    input = { answer, by: o.by, on: o.on };
  }
  try {
    const r = await saveClarifyAnswer(ctx, rid, run.id, q, input, { expectedRev, actor });
    return out.result({ request: rid, rev: r.request.rev, run: run.id, question: q.id, answer: r.answer ?? null }, () =>
      [`回答を要望に残しました: ${rid} ${run.id}/${q.id}（rev ${r.request.rev}）`, `今の内容で評価し直すなら: p3 preflight ${rid}`].join("\n"),
    );
  } catch (e) {
    if (e instanceof RequirementInputError) throw new UsageError(e.message);
    throw e;
  }
}
