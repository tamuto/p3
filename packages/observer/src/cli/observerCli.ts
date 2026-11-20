import { readFile } from "node:fs/promises";
import { UsageError, resolvePath } from "@infodb/p3-kit/usage.ts";
import { observerStatus } from "../core/status.ts";
import { DefinitionError, DefinitionStore } from "../core/definitionStore.ts";
import { DEFINITIONS_DIR, MEASURE_TYPE_LABEL, PROCEDURE_KIND_LABEL, problemText, type ObservationDefinition, type Procedure } from "../shared/definition.ts";
import type { DefinitionTarget } from "../shared/status.ts";
import type { SuggestionService } from "../core/suggest.ts";
import { MISSING_LABEL, SURFACE_LABEL, validateSuggestionRequest, type SuggestionJob } from "../shared/suggestion.ts";

export const OBSERVER_USAGE = [
  "p3 observer status [--json]",
  "p3 observer list [--json]",
  "p3 observer show <ID> [--json]",
  "p3 observer add [--input <JSON のファイル|->] [--title ..] [--category ..] [--body <観測内容>]",
  "p3 observer update <ID> --rev <今の版> [--input <JSON のファイル|->] [--title ..] [--category ..] [--body <観測内容>]",
  "p3 observer suggest [--input <定義の JSON|->] [--title ..] [--category ..] [--body ..] [--repo <参照先>]... [--note <補足>]",
].join("\n  ");

/** 定義を読み書きするサブコマンド（入口がプロジェクトを決めてから呼ぶ。status だけはプロジェクトを決めない） */
export const OBSERVER_PROJECT_SUBCOMMANDS = ["list", "ls", "show", "add", "update", "suggest"] as const;
/** 定義を変えるサブコマンド（登録が1つだけで決まったときなどに、入口が書き込みを止めるため） */
export const OBSERVER_WRITE_SUBCOMMANDS = ["add", "update"] as const;

export const observerNeedsProject = (args: string[]) => (OBSERVER_PROJECT_SUBCOMMANDS as readonly string[]).includes(args[0] ?? "");
export const observerWrites = (args: string[]) => (OBSERVER_WRITE_SUBCOMMANDS as readonly string[]).includes(args[0] ?? "");

export interface ObserverCliOptions {
  /** 入口が解決したプロジェクト（status 以外で要る） */
  target?: DefinitionTarget;
  cwd?: string;
  actor?: string;
  input?: string;
  title?: string;
  category?: string;
  body?: string;
  rev?: string;
  /** suggest: 読ませる参照先の名前と補足 */
  repo?: string[];
  note?: string;
  /** suggest: 入口が組み立てた提案の実行（Codex の接続を共有するアダプター入り） */
  suggestions?: () => Promise<SuggestionService>;
  /** 標準入力（--input - のとき。テストで差し替える） */
  stdin?: () => Promise<string>;
}

export type ObserverResult = { data: unknown; text: string; code?: undefined } | { code: 1 | 2 | 3; error: string };

const EXIT: Record<DefinitionError["code"], 1 | 2 | 3> = { invalid: 1, unreadable: 1, not_found: 2, conflict: 3 };
/** 保存の層が付ける項目（show --json の出力をそのまま --input に渡せるよう、入力からは落とす） */
const META = ["format", "id", "rev", "createdAt", "createdBy", "updatedAt", "updatedBy"];

/**
 * p3 observer <サブコマンド>。status は入口がプロジェクトを決める前に呼ぶ（tasks のプロジェクトの解決・個人設定を経ない）。
 * 定義の list・show・add・update は、入口が tasks と同じ方法で決めたプロジェクト（target）のデータのフォルダの observer/ を読み書きする。
 * 結果の data（--json）と text（通常の出力）か、終了コードとエラーの文を返す（1 入力の誤り / 2 見つからない / 3 版の競合）
 */
export async function observerCommand(args: string[], opts: ObserverCliOptions = {}): Promise<ObserverResult> {
  const [sub, ...rest] = args;
  if (sub === "status") {
    if (rest.length) throw new UsageError(`status は引数を取りません: ${rest.join(" ")}（${OBSERVER_USAGE}）`);
    const s = observerStatus();
    return { data: s, text: [`p3-observer ${s.version}`, `  state  ${s.state}`].join("\n") };
  }
  if (!observerNeedsProject(args)) {
    throw new UsageError(sub === undefined ? `サブコマンドを指定してください:\n  ${OBSERVER_USAGE}` : `observer のサブコマンドではありません: ${sub}\n  ${OBSERVER_USAGE}`);
  }
  if (sub !== "suggest" && (opts.repo?.length || opts.note !== undefined)) throw new UsageError("--repo・--note は p3 observer suggest でだけ使えます");
  if (!opts.target) throw new Error("observer: プロジェクトが決まっていません");
  const store = new DefinitionStore(opts.target.dataDir);
  const actor = opts.actor ?? "human:cli";
  const where = `${opts.target.project ? `プロジェクト ${opts.target.project}` : "プロジェクト"}（${store.dir}）`;
  const fail = (e: unknown): ObserverResult => {
    if (!(e instanceof DefinitionError)) throw e;
    return { code: EXIT[e.code], error: e.problems.length ? `${e.message}:\n${problemText(e.problems)}` : e.message };
  };
  try {
    if (sub === "list" || sub === "ls") {
      if (rest.length) throw new UsageError(`list は引数を取りません: ${rest.join(" ")}`);
      const l = await store.list();
      const lines = [`観測の定義 ${l.definitions.length} 件  登録先: ${where}`];
      for (const d of l.definitions) lines.push(`${d.id}  v${d.rev}  [${d.category}]  ${d.title}  （測定 ${d.measures.length}・手順 ${d.procedures.length}）`);
      for (const u of l.unreadable) lines.push(`⚠ 読めないファイル ${u.file}: ${u.reason}`);
      return { data: { target: { project: opts.target.project ?? null, dataDir: opts.target.dataDir, dir: DEFINITIONS_DIR }, ...l }, text: lines.join("\n") };
    }
    if (sub === "show") {
      const [id, ...extra] = rest;
      if (!id || extra.length) throw new UsageError(`観測の定義の ID を1つ指定してください: p3 observer show <ID>`);
      const d = await store.get(id);
      return { data: d, text: describe(d) };
    }
    const fromFlags = (base: Record<string, unknown>) => ({
      ...base,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.category !== undefined ? { category: opts.category } : {}),
      ...(opts.body !== undefined ? { description: opts.body } : {}),
    });
    if (sub === "add") {
      if (rest.length) throw new UsageError(`add は位置引数を取りません: ${rest.join(" ")}（中身は --input か --title・--category・--body）`);
      if (opts.rev !== undefined) throw new UsageError("add に --rev は要りません（版は作成で 1 になる）");
      const input = opts.input !== undefined ? await readInput(opts) : { input: {} as Record<string, unknown> };
      const d = await store.create(fromFlags(input.input), actor);
      return { data: d, text: `作成しました: ${d.id}（v${d.rev}）  登録先: ${where}` };
    }
    if (sub === "suggest") {
      if (rest.length) throw new UsageError(`suggest は位置引数を取りません: ${rest.join(" ")}（材料は --input か --title・--category・--body）`);
      const input = opts.input !== undefined ? await readInput(opts) : { input: {} as Record<string, unknown> };
      const v = validateSuggestionRequest({ definition: fromFlags(input.input), repos: opts.repo ?? [], ...(opts.note !== undefined ? { note: opts.note } : {}) });
      if (!v.ok) return { code: 1, error: `提案の依頼に誤りがあります:\n${problemText(v.problems)}` };
      if (!opts.suggestions) throw new Error("observer: 提案の実行が渡されていません");
      const job = await (await opts.suggestions()).run(v.value);
      if (job.status !== "completed" || !job.result) return { code: 1, error: `提案できませんでした（${job.failure ?? job.status}）: ${job.error ?? ""}`.trim() };
      // 取り込んだ形（今の手順に提案を足したもの）。編集して p3 observer add --input / update --input に渡せる。保存はしない
      const definition = { ...v.value.definition, procedures: [...v.value.definition.procedures, ...job.result.procedures.map((p) => p.procedure)] };
      return { data: { ...job, definition }, text: suggestionText(job) };
    }
    // update
    const [id, ...extra] = rest;
    if (!id || extra.length) throw new UsageError(`観測の定義の ID を1つ指定してください: p3 observer update <ID> --rev <今の版>`);
    let base: Record<string, unknown>;
    let rev = opts.rev !== undefined ? parseRev(opts.rev) : undefined;
    if (opts.input !== undefined) {
      const r = await readInput(opts);
      base = r.input;
      rev ??= r.rev;
    } else {
      // --input を省くと今の定義に --title などを重ねる（版は必ず添える。読んだ版に黙って合わせない）
      const { format: _f, id: _i, rev: _r, createdAt: _ca, createdBy: _cb, updatedAt: _ua, updatedBy: _ub, ...content } = await store.get(id);
      base = { ...content };
    }
    if (rev === undefined) throw new UsageError("更新には今の定義の版を --rev で添えてください（p3 observer show <ID> で読める）");
    const d = await store.update(id, rev, fromFlags(base), actor);
    return { data: d, text: `更新しました: ${d.id}（v${d.rev}）  登録先: ${where}` };
  } catch (e) {
    return fail(e);
  }
}

function parseRev(v: string): number {
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError(`--rev は 1 以上の整数です: ${v}`);
  return Number(v);
}

/** --input の JSON を読む（- は標準入力）。show --json の出力（ID・版・記録つき）も受け付け、rev は版として使う */
async function readInput(opts: ObserverCliOptions): Promise<{ input: Record<string, unknown>; rev?: number }> {
  const src = opts.input!;
  let text: string;
  try {
    text = src === "-" ? await (opts.stdin ?? readStdin)() : await readFile(resolvePath(opts.cwd ?? process.cwd(), src), "utf8");
  } catch (e) {
    throw new UsageError(`--input を読めません: ${src}（${(e as Error).message}）`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`--input が JSON として読めません: ${(e as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new UsageError("--input は観測の定義の JSON のオブジェクトにしてください");
  const rec = { ...(data as Record<string, unknown>) };
  const rev = typeof rec.rev === "number" ? rec.rev : undefined;
  for (const k of META) delete rec[k];
  return { input: rec, rev };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function procedureLine(p: Procedure): string {
  if (p.kind === "command") return `${p.command}${p.args.length ? ` ${p.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}` : ""}${p.repo ? `  （作業場所 ${p.repo}:${p.cwd ?? "."}）` : ""}`;
  if (p.kind === "ai-instruction") return p.body.split("\n")[0];
  return `${p.repo}:${p.path}${p.invoke ? `  （${p.invoke}）` : ""}`;
}

function suggestionText(job: SuggestionJob): string {
  const r = job.result!;
  const lines = [`操作面: ${SURFACE_LABEL[r.surface]}（${job.engine}）`, `根拠: ${r.rationale}`];
  r.procedures.forEach((p, i) => lines.push(`手順 ${i + 1}. ${PROCEDURE_KIND_LABEL[p.procedure.kind]}: ${p.procedure.title}`, `    ${procedureLine(p.procedure)}`, `    根拠: ${p.evidence}`));
  for (const m of r.missing) lines.push(`足りない材料: ${MISSING_LABEL[m.field]} — ${m.reason}`);
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  lines.push("", "保存はしていません。--json の definition（今の手順に提案を足したもの）を編集して p3 observer add --input に渡すと登録できます");
  return lines.join("\n");
}

function describe(d: ObservationDefinition): string {
  const lines = [`${d.id}  v${d.rev}  [${d.category}]  ${d.title}`, "", d.description, "", `測定項目 ${d.measures.length} 件`];
  for (const m of d.measures) lines.push(`  ${m.name}  ${MEASURE_TYPE_LABEL[m.type]}${m.unit ? `（${m.unit}）` : ""}${m.description ? `  ${m.description}` : ""}`);
  lines.push(`確認の手順 ${d.procedures.length} 件`);
  for (const p of d.procedures) {
    lines.push(`  ${PROCEDURE_KIND_LABEL[p.kind]}: ${p.title}`, `    ${procedureLine(p)}`);
    if (p.measures.length) lines.push(`    測る: ${p.measures.join("・")}`);
  }
  lines.push("", `作成 ${d.createdAt} ${d.createdBy} / 更新 ${d.updatedAt} ${d.updatedBy}`);
  return lines.join("\n");
}
