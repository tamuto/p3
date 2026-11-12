import { qualityTemplate, qualityView, updateQuality, type QualityView } from "../core/quality.ts";
import { checkLine, type QualityCheck, type QualityOp } from "../shared/quality.ts";
import { readBody, type CommandEnv } from "./args.ts";
import { table } from "./format.ts";
import { UsageError } from "./project.ts";

/**
 * 品質基準（core/quality.ts。画面の設定の「品質基準」と同じ）。
 *   quality                                  今の設定（未設定・設定済み・読めない）とテンプレートの改版の差分
 *   quality templates / quality template <id> 同梱のテンプレートの一覧・中身
 *   quality init                             空の品質基準を設定する（意図して空）
 *   quality adopt <テンプレート>               テンプレートを写して採用する / quality upgrade <テンプレート> 改版の差分を当てる
 *   quality add --text 文 [--repo 名前]... (--command コマンド --success 成功の条件 | --reference 確かめ方)
 *   quality set <Q1> [--text] [--repo]... [--command --success | --reference]   quality rm <Q1>
 *   quality exempt <Q1> --reason 理由 / quality unexempt <Q1>
 *   変える操作は --version <版>（quality --json の version）を付けると、違えば競合（終了コード 3）
 */
export async function qualityCommand(env: CommandEnv): Promise<number> {
  const { ctx, out, args, o } = env;
  const [sub, ...rest] = args;
  const ws = ctx.ws;
  if (sub === undefined || sub === "show") {
    const v = qualityView(ws);
    return out.result(v, () => formatQuality(v));
  }
  if (sub === "templates") {
    const v = qualityView(ws);
    return out.result(v.templates, () => table(v.templates.map((t) => [`${t.id}@${t.version}`, t.title, `${t.items} 件`, t.description])));
  }
  if (sub === "template") {
    const t = qualityTemplate(rest[0] ?? "", o.version ? Number(o.version) : undefined);
    if (!t) throw new UsageError(`テンプレートがありません: ${rest[0] ?? ""}（p3 quality templates）`);
    return out.result(t, () => [`${t.id}@${t.version}  ${t.title}`, `  ${t.description}`, "", ...t.items.map((i) => `  ${i.key}  ${i.text}\n      ${checkLine(i.check)}`)].join("\n"));
  }
  const check = (): QualityCheck | undefined => {
    if (o.reference !== undefined) {
      if (o.command !== undefined || o.success !== undefined) throw new UsageError("--reference（人の確認）と --command / --success（機械の検査）はどちらか一方です");
      return { kind: "manual", reference: readBody(o.reference) };
    }
    if (o.command !== undefined || o.success !== undefined) return { kind: "machine", command: o.command ?? "", success: o.success ?? "" };
    return undefined;
  };
  let ops: QualityOp[];
  switch (sub) {
    case "init":
      ops = [{ op: "init" }];
      break;
    case "adopt":
      if (!rest[0]) throw new UsageError("使い方: p3 quality adopt <テンプレート>（p3 quality templates）");
      ops = [{ op: "adopt", template: rest[0] }];
      break;
    case "upgrade":
      if (!rest[0]) throw new UsageError("使い方: p3 quality upgrade <テンプレート>（差分は p3 quality で見る）");
      ops = [{ op: "upgrade", template: rest[0] }];
      break;
    case "add": {
      const c = check();
      if (!c) throw new UsageError("確認の方法を指定してください: --command <コマンド> --success <成功の条件>（機械の検査）か --reference <確かめ方>（人の確認）");
      ops = [{ op: "add", standard: { text: readBody(o.text ?? ""), ...(o.repo !== undefined ? { repos: [o.repo] } : {}), check: c } }];
      break;
    }
    case "set": {
      if (!rest[0]) throw new UsageError("使い方: p3 quality set <Q1> [--text 文] [--repo 名前|all] [--command ... --success ... | --reference ...]");
      const c = check();
      ops = [{ op: "edit", id: rest[0], standard: { ...(o.text !== undefined ? { text: readBody(o.text) } : {}), ...(o.repo !== undefined ? { repos: o.repo === "all" ? [] : [o.repo] } : {}), ...(c ? { check: c } : {}) } }];
      break;
    }
    case "rm":
    case "remove":
      if (!rest.length) throw new UsageError("使い方: p3 quality rm <Q1> [...]");
      ops = rest.map((id) => ({ op: "remove", id }));
      break;
    case "exempt":
      if (!rest[0] || o.reason === undefined) throw new UsageError("使い方: p3 quality exempt <Q1> --reason 理由（理由は必須）");
      ops = [{ op: "exempt", id: rest[0], reason: readBody(o.reason) }];
      break;
    case "unexempt":
      if (!rest[0]) throw new UsageError("使い方: p3 quality unexempt <Q1>");
      ops = [{ op: "unexempt", id: rest[0] }];
      break;
    default:
      throw new UsageError(`quality の操作は show / templates / template / init / adopt / upgrade / add / set / rm / exempt / unexempt です: ${sub}`);
  }
  const v = await updateQuality(ws, ops, { expectedVersion: o.version });
  return out.result(v, () => formatQuality(v));
}

export function formatQuality(v: QualityView): string {
  const q = v.quality;
  if (q.state === "unset") {
    return [
      "品質基準: 未設定（初めて作ったときの状態に任せています）",
      "  テンプレートから始める: p3 quality adopt basic（一覧は p3 quality templates）。空のまま設定するなら p3 quality init",
    ].join("\n");
  }
  if (q.state === "invalid") return ["品質基準: 読めません（project.yaml の quality を直してください。保存しても消しません）", ...q.problems.map((p) => `  - ${p}`)].join("\n");
  const lines = [`品質基準: ${q.config.standards.length} 件（版 ${v.version}${q.config.templates?.length ? `・テンプレート ${q.config.templates.map((t) => `${t.id}@${t.version}`).join(", ")}` : ""}）`];
  if (!q.config.standards.length) lines.push("  （意図して空にしています）");
  for (const s of q.config.standards) {
    lines.push(`  ${s.id}  ${s.text}${s.repos?.length ? `  [${s.repos.join(", ")}]` : ""}${s.exempt ? "  ※除外" : ""}`, `      ${checkLine(s.check)}`);
    if (s.exempt) lines.push(`      除外の理由: ${s.exempt.reason}`);
  }
  for (const w of q.warnings ?? []) lines.push(`  ⚠ ${w}`);
  for (const d of v.diffs) {
    lines.push(`テンプレート ${d.template} に新しい版があります（${d.from} → ${d.to}。足す ${d.added.length}・変わる ${d.changed.length}・消える ${d.removed.length}）。当てるなら p3 quality upgrade ${d.template}`);
  }
  return lines.join("\n");
}
