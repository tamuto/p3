import { qualityTemplate, qualityView, updateQuality, type QualityView } from "../core/quality.ts";
import { checkLine, type QualityCheck, type QualityOp } from "../shared/quality.ts";
import { diagnoseQuality, improvementDraft, registerImprovement, type ImprovementSource } from "../core/qualityImprovement.ts";
import { readBody, type CommandEnv } from "./args.ts";
import { table } from "./format.ts";
import { UsageError } from "./project.ts";

/**
 * 品質基準（core/quality.ts。画面の設定の「品質基準」と同じ）。
 *   quality                                  今の設定（未設定・設定済み・読めない）とテンプレートの改版の差分
 *   quality templates / quality template <id> 同梱のテンプレートの一覧・中身
 *   quality init                             空の品質基準を設定する（意図して空。必須ではなく、設定済みなら内容は変えない）
 *   quality adopt <テンプレート>               テンプレートを写して採用する / quality upgrade <テンプレート> 改版の差分を当てる
 *   quality add --text 文 [--repo 名前]... (--command コマンド --success 成功の条件 | --reference 確かめ方)
 *   quality set <Q1> [--text] [--repo 名前|all]... [--command --success | --reference]   quality rm <Q1>
 *     --repo は繰り返して複数の参照先を指定する（qualityRepos）。add で省くと全参照先、set で省くと対象は変えない
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
  if (sub === "improve") return improveCommand(env, rest);
  const check = (): QualityCheck | undefined => {
    if (o.reference !== undefined) {
      if (o.command !== undefined || o.success !== undefined) throw new UsageError("--reference（人の確認）と --command / --success（機械の検査）はどちらか一方です");
      return { kind: "manual", reference: readBody(o.reference) };
    }
    if (o.command !== undefined || o.success !== undefined) return { kind: "machine", command: o.command ?? "", success: o.success ?? "" };
    return undefined;
  };
  if (o.repos !== undefined && sub !== "add" && sub !== "set") throw new UsageError(`--repo は p3 quality add / set でだけ使えます（${sub} は対象を取りません）`);
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
      const repos = qualityRepos(o.repos, ws.project.repos.map((r) => r.name));
      ops = [{ op: "add", standard: { text: readBody(o.text ?? ""), ...(repos ? { repos } : {}), check: c } }];
      break;
    }
    case "set": {
      if (!rest[0]) throw new UsageError("使い方: p3 quality set <Q1> [--text 文] [--repo 名前 ...|all] [--command ... --success ... | --reference ...]");
      const c = check();
      const repos = qualityRepos(o.repos, ws.project.repos.map((r) => r.name));
      ops = [{ op: "edit", id: rest[0], standard: { ...(o.text !== undefined ? { text: readBody(o.text) } : {}), ...(repos ? { repos } : {}), ...(c ? { check: c } : {}) } }];
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
      throw new UsageError(`quality の操作は show / templates / template / init / adopt / upgrade / add / set / rm / exempt / unexempt / improve です: ${sub}`);
  }
  const v = await updateQuality(ws, ops, { expectedVersion: o.version });
  return out.result(v, () => formatQuality(v));
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

/**
 * quality improve [task <要望>/<T> <run> | milestone <ID> <run>]   不足の診断と改善要望の原稿（読むだけ。省くとプロジェクトの設定）
 *   --key <不足の鍵>...（省くと既定で選ぶもの）
 *   --register --hash <診断の版> [--title 題] [--body 本文|-] [--reopen]   明示して登録する
 */
async function improveCommand({ ctx, out, o, actor }: CommandEnv, rest: string[]): Promise<number> {
  const [kind, a, b] = rest;
  let source: ImprovementSource;
  if (kind === undefined || kind === "project") source = { type: "project" };
  else if (kind === "task") {
    const [rid, tid] = (a ?? "").split("/");
    if (!rid || !tid || !b) throw new UsageError("使い方: p3 quality improve task <要望>/<T> <run>");
    source = { type: "task-review", request: rid, task: tid, run: b };
  } else if (kind === "milestone") {
    if (!a || !b) throw new UsageError("使い方: p3 quality improve milestone <ID> <run>");
    source = { type: "milestone-review", milestone: a, run: b };
  } else throw new UsageError("使い方: p3 quality improve [task <要望>/<T> <run> | milestone <ID> <run>]");
  const d = await diagnoseQuality(ctx, source);
  const keys = o.key?.length ? o.key : d.findings.filter((f) => f.suggested).map((f) => f.key);
  if (!o.register) {
    const draft = keys.length ? improvementDraft(d, keys) : undefined;
    return out.result({ ...d, picked: keys, ...(draft ? { draft } : {}) }, () =>
      [
        `品質の診断（${kind ?? "project"}。版 ${d.hash}）:`,
        ...(d.findings.length ? d.findings.map((f) => `  [${keys.includes(f.key) ? "x" : " "}] ${f.key}  ${f.reason}${d.registered[f.key] ? `  → 登録済み ${d.registered[f.key].request}（${d.registered[f.key].status ?? "?"}）` : ""}`) : ["  不足はありません"]),
        ...d.notes.map((n) => `  ※ ${n}`),
        ...(draft ? ["", `題: ${draft.title}`, "", draft.body, "", `登録するなら: p3 quality improve ${rest.join(" ")} --register --hash ${d.hash}${o.key?.length ? o.key.map((k) => ` --key ${k}`).join("") : ""}`] : []),
      ].join("\n"),
    );
  }
  if (!o.hash) throw new UsageError("登録するには、原稿を確かめた診断の版を --hash で渡してください（p3 quality improve で出ます）");
  const draft = improvementDraft(d, keys);
  const r = await registerImprovement(ctx, { source, keys, title: o.title ?? draft.title, body: o.body !== undefined ? readBody(o.body) : draft.body, hash: o.hash, reopenClosed: o.reopen }, actor);
  return out.result(r, () => `要望を登録しました: ${r.request.id}  ${r.request.title}（不足 ${r.keys.join(", ")}）`);
}

export function formatQuality(v: QualityView): string {
  const q = v.quality;
  if (q.state === "unset") {
    return [
      "品質基準: 未設定（このままでも作業は続けられます。p3 quality init は必須ではありません）",
      "  基準を足す:       p3 quality add --text 文 (--command コマンド --success 成功の条件 | --reference 確かめ方) [--repo 名前 ...]",
      "  テンプレートから: p3 quality adopt basic（一覧は p3 quality templates）",
      "  基準を置かないと決めたことを残す: p3 quality init（意図して空にする。設定済みなら何も変えない）",
    ].join("\n");
  }
  if (q.state === "invalid") return ["品質基準: 読めません（project.yaml の quality を直してください。保存しても消しません）", ...q.problems.map((p) => `  - ${p}`)].join("\n");
  const lines = [`品質基準: ${q.config.standards.length} 件（版 ${v.version}${q.config.templates?.length ? `・テンプレート ${q.config.templates.map((t) => `${t.id}@${t.version}`).join(", ")}` : ""}）`];
  if (!q.config.standards.length) lines.push("  （意図して空にしています）");
  for (const s of q.config.standards) {
    lines.push(`  ${s.id}  ${s.text}${s.exempt ? "  ※除外" : ""}`, `      対象: ${s.repos?.length ? s.repos.join(", ") : "全参照先"}`, `      ${checkLine(s.check)}`);
    if (s.exempt) lines.push(`      除外の理由: ${s.exempt.reason}`);
  }
  for (const w of q.warnings ?? []) lines.push(`  ⚠ ${w}`);
  for (const d of v.diffs) {
    lines.push(`テンプレート ${d.template} に新しい版があります（${d.from} → ${d.to}。足す ${d.added.length}・変わる ${d.changed.length}・消える ${d.removed.length}）。当てるなら p3 quality upgrade ${d.template}`);
  }
  return lines.join("\n");
}
