import { qualityState, updateQuality } from "../core/quality.ts";
import type { QualityOp, QualityState } from "../shared/quality.ts";
import { readBody, type CommandEnv } from "../../../cli/args.ts";
import { UsageError } from "@infodb/p3-shared/node/usage.ts";

/**
 * 品質基準（core/quality.ts。画面の設定の「品質基準」と同じ）。
 *   quality                                        今の基準（有る・無い・読めない）
 *   quality add --text 文 [--repo 名前]... [--how 確かめ方]
 *   quality set <Q1> [--text 文] [--repo 名前|all]... [--how 確かめ方]   quality rm <Q1>
 *     --repo は繰り返して複数の参照先を指定する（qualityRepos）。add で省くと全参照先、set で省くと対象は変えない。--how= で確かめ方を外す
 */
export async function qualityCommand(env: CommandEnv): Promise<number> {
  const { ctx, out, args, o } = env;
  const [sub, ...rest] = args;
  const ws = ctx.ws;
  if (sub === undefined || sub === "show") {
    const q = qualityState(ws);
    return out.result({ quality: q }, () => formatQuality(q));
  }
  if (o.repos !== undefined && sub !== "add" && sub !== "set") throw new UsageError(`--repo は p3 quality add / set でだけ使えます（${sub} は対象を取りません）`);
  if (o.how !== undefined && sub !== "add" && sub !== "set") throw new UsageError(`--how は p3 quality add / set でだけ使えます`);
  const repoNames = ws.project.repos.map((r) => r.name);
  let ops: QualityOp[];
  switch (sub) {
    case "add": {
      const repos = qualityRepos(o.repos, repoNames);
      ops = [{ op: "add", standard: { text: readBody(o.text ?? ""), ...(repos ? { repos } : {}), ...(o.how !== undefined ? { how: readBody(o.how) } : {}) } }];
      break;
    }
    case "set": {
      if (!rest[0]) throw new UsageError("使い方: p3 quality set <Q1> [--text 文] [--repo 名前 ...|all] [--how 確かめ方]");
      const repos = qualityRepos(o.repos, repoNames);
      ops = [{ op: "edit", id: rest[0], standard: { ...(o.text !== undefined ? { text: readBody(o.text) } : {}), ...(repos ? { repos } : {}), ...(o.how !== undefined ? { how: readBody(o.how) } : {}) } }];
      break;
    }
    case "rm":
    case "remove":
      if (!rest.length) throw new UsageError("使い方: p3 quality rm <Q1> [...]");
      ops = rest.map((id) => ({ op: "remove", id }));
      break;
    default:
      throw new UsageError(`quality の操作は show / add / set / rm です: ${sub}`);
  }
  const q = await updateQuality(ws, ops);
  return out.result({ quality: q }, () => formatQuality(q));
}

/**
 * 品質基準の対象（--repo を繰り返した全部）。省くと undefined（add は全参照先・set は今の対象のまま）、all は全参照先（[]）。
 * all と個別の名前は一緒に使えない。同じ名前は1つにまとめる。登録されていない名前は保存の規則（shared/quality.ts）が断る
 */
export function qualityRepos(raw: string[] | undefined, repoNames: readonly string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  const names = [...new Set(raw.map((r) => r.trim()))];
  if (names.includes("")) throw new UsageError("--repo に参照先の名前を指定してください（全参照先なら --repo all）");
  if (!names.includes("all")) return names;
  if (names.length > 1) throw new UsageError(`--repo all（全参照先）と個別の参照先（${names.filter((n) => n !== "all").join(", ")}）は一緒に指定できません`);
  if (repoNames.includes("all")) throw new UsageError("「all」という名前の参照先があるため、--repo all が全参照先か参照先 all かを決められません（画面の品質基準で対象を選んでください）");
  return [];
}

export function formatQuality(q: QualityState): string {
  if (q.state === "invalid") return ["品質基準: 読めません（project.yaml の quality を直してください。保存しても消しません）", ...q.problems.map((p) => `  - ${p}`)].join("\n");
  const standards = q.state === "set" ? q.config.standards : [];
  if (!standards.length) return ["品質基準: ありません（無くても作業は続けられます）", "  基準を足す: p3 quality add --text 文 [--how 確かめ方] [--repo 名前 ...]"].join("\n");
  const lines = [`品質基準: ${standards.length} 件（タスクを作るときに、作業先に当てはまる基準を受け入れ基準に足します）`];
  for (const s of standards) lines.push(`  ${s.id}  ${s.text}`, `      対象: ${s.repos?.length ? s.repos.join(", ") : "全参照先"}`, ...(s.how ? [`      確かめ方: ${s.how}`] : []));
  for (const w of (q.state === "set" && q.warnings) || []) lines.push(`  ⚠ ${w}`);
  return lines.join("\n");
}
