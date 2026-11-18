import { ADOPTION_KIND_LABEL, type RetroCandidate, type RetroTarget } from "../shared/retrospective.ts";
import { confirmRetrospectiveTarget, retrospectiveView, type RetrospectiveView } from "../core/retrospective.ts";
import { UsageError } from "./project.ts";
import type { CommandEnv } from "./args.ts";

/**
 * 要望の振り返り（Preflight で心配したリスクが実装の後に起きたか）のコマンド（規則は shared/retrospective.ts）。
 *
 *   retro [<要望>]                              振り返りの対象（確定した run・リスク）と候補（採用済みの run と根拠）
 *   retro [<要望>] confirm <run> [--reason 理由]  対象を確定する（2回目からは訂正で理由が要る。--rev で版を照らす）
 */

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
  if (v.target) lines.push(...formatTarget(v.target).map((l) => `  ${l}`));
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
  const subs = new Set(["show", "confirm"]);
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
  throw new UsageError("p3 retro [<要望>] [show | confirm <run>]");
}
