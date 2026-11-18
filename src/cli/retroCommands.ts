import { readFileSync } from "node:fs";
import {
  ADOPTION_KIND_LABEL,
  EVIDENCE_CHECK_LABEL,
  isRiskState,
  RETRO_EVIDENCE_LABEL,
  RISK_STATE_LABEL,
  RISK_STATES,
  type EvidenceCheck,
  type RetroCandidate,
  type RetroEvidence,
  type RetroTarget,
  type RiskJudgment,
} from "../shared/retrospective.ts";
import { confirmRetrospectiveTarget, judgeRisk, retrospectiveView, type EvidenceRef, type RetrospectiveView } from "../core/retrospective.ts";
import { UsageError } from "./project.ts";
import type { CommandEnv } from "./args.ts";

/**
 * 要望の振り返り（Preflight で心配したリスクが実装の後に起きたか）のコマンド（規則は shared/retrospective.ts）。
 *
 *   retro [<要望>]                              振り返りの対象（確定した run・リスク）と候補（採用済みの run と根拠）
 *   retro [<要望>] confirm <run> [--reason 理由]  対象を確定する（2回目からは訂正で理由が要る。--rev で版を照らす）
 *   retro [<要望>] judge <リスクの番号> --state occurred|not_occurred|unchecked [--facts 事実] [--scope 範囲] [--reason 理由]
 *         --evidence review:T001:<run>:<項目>[:<位置>] | milestone:<ID>:<run>:<項目>[:<位置>][:<結び付く理由>] | rework:T001:R1 | manual:<参照>
 *         （繰り返し可）/ --evidence-json 根拠.json|-   リスクの確認を記録する（人の判断。根拠だけなら unchecked のまま結び付ける）
 */

/** 根拠の指定の文字列を読む */
export function parseEvidenceSpec(spec: string): EvidenceRef {
  const [kind, ...rest] = spec.split(":");
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number.isInteger(Number(v)) ? Number(v) : NaN);
  if (kind === "manual" && rest.join(":").trim()) return { kind: "manual", reference: rest.join(":").trim() };
  if (kind === "rework" && rest.length === 2) return { kind: "rework", task: rest[0], history: rest[1] };
  if (kind === "review" && rest.length >= 3 && !Number.isNaN(num(rest[3]))) return { kind: "task_review", task: rest[0], run: rest[1], section: rest[2] as never, index: num(rest[3]) };
  if (kind === "milestone" && rest.length >= 3 && !Number.isNaN(num(rest[3])))
    return { kind: "milestone_review", milestone: rest[0], run: rest[1], section: rest[2] as never, index: num(rest[3]), ...(rest.length > 4 ? { reason: rest.slice(4).join(":") } : {}) };
  throw new UsageError(`根拠の指定が読めません: ${spec}（review:T001:<run>:<項目>[:<位置>] / milestone:<ID>:<run>:<項目>[:<位置>][:<理由>] / rework:T001:R1 / manual:<参照>）`);
}

const evidenceLine = (e: RetroEvidence, check?: EvidenceCheck) => {
  const where =
    e.kind === "task_review" ? `${e.request}/${e.task} ${e.run} ${e.section}[${e.index}]` : e.kind === "milestone_review" ? `${e.milestone} ${e.run} ${e.section}[${e.index}]${e.inputChanged ? "（実行中に材料が変わった）" : ""}` : e.kind === "rework" ? `${e.request}/${e.task} ${e.history}` : e.reference;
  const text = e.kind === "manual" ? (e.note ?? "") : e.excerpt;
  return `${RETRO_EVIDENCE_LABEL[e.kind]}  ${where}${check ? `  [${EVIDENCE_CHECK_LABEL[check]}]` : ""}${text ? `\n          当時の抜粋: ${text}` : ""}${e.kind === "milestone_review" && e.reason ? `\n          結び付く理由: ${e.reason}` : ""}`;
};

const judgmentLines = (j: RiskJudgment, checks: EvidenceCheck[] | undefined) => [
  `      ${j.id}  ${RISK_STATE_LABEL[j.state]}  ${j.at}  ${j.by ?? ""}${j.reason ? `  理由: ${j.reason}` : ""}`,
  ...(j.facts ? [`        事実: ${j.facts}`] : []),
  ...(j.scope ? [`        範囲: ${j.scope}`] : []),
  ...j.evidence.map((e, i) => `        根拠: ${evidenceLine(e, checks?.[i])}`),
];

const basisLine = (b: RetroCandidate["basis"][number]) => `${b.key ? `${b.key}→` : ""}${b.target}${b.state === "present" ? "" : `（${{ archived: "アーカイブ済み", missing: "見つからない", mismatch: "採用元が合わない" }[b.state]}）`}`;

export function formatTarget(t: RetroTarget): string[] {
  return [
    `${t.id}  ${t.run}  ${ADOPTION_KIND_LABEL[t.kind]}  ${t.at}  ${t.by ?? ""}${t.replaces ? `  （${t.replaces} を訂正: ${t.reason ?? ""}）` : ""}`,
    `    評価の版 ${t.assessmentVersion}  根拠: ${t.basis.map(basisLine).join(", ")}`,
    ...(t.risks.length ? t.risks.map((r) => `    リスク ${r.index + 1}: ${r.text}`) : ["    リスクなし"]),
  ];
}

export function formatRetro(v: RetrospectiveView): string {
  const lines = [v.target ? "振り返りの対象:" : "振り返りの対象: 未確定（p3 retro confirm <run> で確定する）"];
  if (v.target) {
    lines.push(`  ${formatTarget(v.target)[0]}`, `      評価の版 ${v.target.assessmentVersion}`);
    lines.push("", `リスクの確認（人の判断。起きた ${v.counts.occurred}・起きなかった ${v.counts.not_occurred}・未確認 ${v.counts.unchecked}）:`);
    if (!v.risks.length) lines.push("  リスクなし（評価にリスクがありませんでした）");
    for (const r of v.risks) {
      lines.push(`  ${r.index + 1}. [${RISK_STATE_LABEL[r.state]}] ${r.text}`);
      for (const j of r.history) lines.push(...judgmentLines(j, v.checks[j.id]));
    }
  }
  if (v.targets.length > 1) lines.push("", "前の対象（訂正の履歴）:", ...v.targets.slice(0, -1).flatMap((t) => formatTarget(t).slice(0, 1).map((l) => `  ${l}`)));
  lines.push("", "候補（採用を終えた Preflight。新しい順）:");
  if (!v.candidates.length) lines.push(`  なし: ${v.none ?? ""}`);
  for (const c of v.candidates)
    lines.push(`  ${c.run}  ${ADOPTION_KIND_LABEL[c.kind]}${c.latest ? "  最新" : ""}${v.target?.run === c.run ? "  ← 対象" : ""}  リスク ${c.risks}  根拠: ${c.basis.map(basisLine).join(", ")}`);
  return lines.join("\n");
}

export async function retroCommand(cmd: string, env: CommandEnv): Promise<number | undefined> {
  if (cmd !== "retro" && cmd !== "retrospective") return undefined;
  const { ctx, out, args, o, actor, expectedRev, requestArg } = env;
  const subs = new Set(["show", "confirm", "judge"]);
  const explicit = args[0] && !subs.has(args[0]) ? args[0] : undefined;
  const rid = requestArg(explicit);
  const rest = explicit ? args.slice(1) : args;
  const sub = rest[0] ?? "show";
  if (sub === "show") {
    const v = await retrospectiveView(ctx, rid);
    return out.result(v, () => formatRetro(v));
  }
  if (sub === "confirm") {
    const run = rest[1];
    if (!run) throw new UsageError("p3 retro [<要望>] confirm <run> [--reason 理由]（run は p3 retro の候補から）");
    const v = await confirmRetrospectiveTarget(ctx, rid, { run, reason: o.reason }, { expectedVersion: expectedRev, actor });
    return out.result(v, () => `確定しました（版 ${v.version}）\n${formatRetro(v)}`);
  }
  if (sub === "judge") {
    const no = Number(rest[1]);
    if (!Number.isInteger(no) || no < 1) throw new UsageError("p3 retro [<要望>] judge <リスクの番号（1 から）> --state occurred|not_occurred|unchecked ...");
    if (!isRiskState(o.state)) throw new UsageError(`--state は ${RISK_STATES.join(" / ")} です`);
    const evidence: EvidenceRef[] = (o.evidence ?? []).map(parseEvidenceSpec);
    if (o["evidence-json"]) {
      const raw = JSON.parse(readFileSync(o["evidence-json"] === "-" ? 0 : o["evidence-json"], "utf8")) as unknown;
      if (!Array.isArray(raw)) throw new UsageError("--evidence-json は根拠の並び（[{kind: task_review|milestone_review|rework|manual, ...}]）にしてください");
      evidence.push(...(raw as EvidenceRef[]));
    }
    const v = await judgeRisk(ctx, rid, { risk: no - 1, state: o.state, facts: o.facts, scope: o.scope, reason: o.reason, evidence }, { expectedVersion: expectedRev, actor });
    return out.result(v, () => `記録しました（版 ${v.version}）\n${formatRetro(v)}`);
  }
  throw new UsageError("p3 retro [<要望>] [show | confirm <run> | judge <番号>]");
}
