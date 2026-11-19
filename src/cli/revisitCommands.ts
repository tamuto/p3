import { REVIEW_CODE_LABEL, REVIEW_STATE_HINT, REVIEW_STATE_LABEL, type PremiseChange, type PremiseOp, type ReviewDiagnosis } from "../shared/reviewCandidate.ts";
import { recordPremise } from "../core/requestOps.ts";
import { reviewCandidates } from "../core/reviewCandidates.ts";
import { UsageError } from "./usage.ts";
import type { CommandEnv } from "./args.ts";

/**
 * 見直しが必要（候補）と前提の変更のコマンド（規則は shared/reviewCandidate.ts）。
 *
 *   revisit [<要望>] [--all]                                        見直し候補（完了したタスクと対応済・完了済の要望。完了済みも含む）
 *   premise [<要望>]                                                前提の変更の一覧
 *   premise [<要望>] add --target <ID>... --reason 理由 --condition 新しい条件   前提の変更を記録する（外部の規則の変更など）
 *   premise [<要望>] ack <P> --target <ID> --condition 確かめた条件              変更を確かめたことを記録する
 */

/** 診断の行（p3 show・p3 revisit で使う） */
export function formatReview(d: ReviewDiagnosis, { head = true } = {}): string[] {
  const lines = head ? [`見直し: ${REVIEW_STATE_LABEL[d.state]}${d.record ? `（基点 ${d.record}）` : ""}`] : [];
  if (d.state !== "candidate") lines.push(`  ${REVIEW_STATE_HINT[d.state]}`);
  for (const r of d.reasons) {
    lines.push(`  - ${REVIEW_CODE_LABEL[r.code]}  ${r.target}${r.related?.length ? `（関係: ${r.related.join(", ")}）` : ""}`);
    if (r.was !== undefined) lines.push(`      当時: ${r.was}`);
    if (r.now !== undefined) lines.push(`      今:   ${r.now}`);
  }
  for (const u of d.unreadable ?? []) lines.push(`  ※比べられない: ${u}`);
  if (d.state === "candidate") lines.push("  候補を出すだけで、状態・済みは変えていません。確かめたら、もう一度済みにすると新しい記録が基点になります");
  return lines;
}

const premiseLines = (c: PremiseChange) => [
  `${c.id}  ${c.at}  ${c.by ?? ""}  対象: ${c.targets.join(", ")}`,
  `    理由: ${c.reason}`,
  `    新しい条件: ${c.condition}`,
  ...(c.acks ?? []).map((a) => `    確認: ${a.target}  ${a.condition}  ${a.at}  ${a.by ?? ""}`),
];

export async function revisitCommand(cmd: string, env: CommandEnv): Promise<number | undefined> {
  const { ctx, out, args, o, actor, current, expectedRev, requestArg } = env;
  if (cmd === "revisit") {
    const rid = args[0] ? requestArg(args[0]) : o.all || !current ? undefined : current;
    const list = reviewCandidates(ctx, rid ? { request: rid } : {});
    return out.result(list, () => (list.length ? list.flatMap((d) => [d.target, ...formatReview(d, { head: false }), ""]).join("\n").trimEnd() : `見直しが必要（候補）はありません${rid ? `（${rid}。全要望は --all）` : ""}`));
  }
  if (cmd !== "premise" && cmd !== "premises") return undefined;
  const subs = new Set(["add", "ack", "ls"]);
  const rest = subs.has(args[0] ?? "") || args.length === 0 ? args : args.slice(1);
  const rid = requestArg(subs.has(args[0] ?? "") || args.length === 0 ? undefined : args[0]);
  const sub = rest[0] ?? "ls";
  if (sub === "ls") {
    const list = ctx.ws.requests.require(rid).premiseChanges ?? [];
    return out.result(list, () => (list.length ? list.flatMap(premiseLines).join("\n") : `${rid} に前提の変更の記録はありません`));
  }
  const condition = o.condition;
  if (!condition) throw new UsageError("--condition（新しい条件・版。ack では確かめた条件）を指定してください");
  let op: PremiseOp;
  if (sub === "add") {
    if (!o.target?.length || !o.reason) throw new UsageError("--target <要望 ID・タスク ID・要望の根拠の ID>（複数可）と --reason を指定してください");
    op = { op: "add", targets: o.target, reason: o.reason, condition };
  } else if (sub === "ack") {
    const id = rest[1];
    if (!id || o.target?.length !== 1) throw new UsageError("p3 premise ack <P1> --target <ID> --condition <確かめた条件>");
    op = { op: "ack", id, target: o.target[0], condition };
  } else throw new UsageError("p3 premise [<要望>] [ls | add | ack <P>]");
  const { change, request } = await recordPremise(ctx, rid, op, { expectedRev, actor });
  return out.result({ change, rev: request.rev }, () => [`${sub === "add" ? "記録しました" : "確認を記録しました"}（rev ${request.rev}）`, ...premiseLines(change)].join("\n"));
}
