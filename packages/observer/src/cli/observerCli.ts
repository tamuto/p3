import { readFile } from "node:fs/promises";
import { UsageError, resolvePath } from "@infodb/p3-shared/node/usage.ts";
import { observerStatus } from "../core/status.ts";
import { DefinitionError, DefinitionStore, PreparationStore } from "../core/definitionStore.ts";
import { FILE_STATE_LABEL, MEASURE_TYPE_LABEL, RUN_KIND_LABEL, problemText, type Executable, type FileState, type ObservationDefinition, type Procedure, type References } from "../shared/definition.ts";
import { SLOT_LABEL, SLOTS, type Preparation, type Slot } from "../shared/preparation.ts";
import { fileChecker } from "../core/files.ts";
import type { DefinitionTarget } from "../shared/status.ts";
import type { SuggestionService } from "../core/suggest.ts";
import { WorkStore } from "../core/workStore.ts";
import { MISSING_LABEL, SURFACE_LABEL, validateSuggestionRequest, type SuggestionJob } from "../shared/suggestion.ts";

export const OBSERVER_USAGE = [
  "p3 observer status [--json]",
  "p3 observer list [--json]",
  "p3 observer show <ID> [--json]",
  "p3 observer add [--input <JSON のファイル|->] [--title ..] [--category ..] [--body <観測内容>] [--expected <期待する結果>]",
  "p3 observer update <ID> --rev <今の版> [--input <JSON のファイル|->] [--title ..] [--category ..] [--body <観測内容>]",
  "p3 observer suggest <ID> [--note <補足>]（保存した観測に提案を頼み、依頼と結果を観測に残す）",
  "p3 observer suggestions <ID> [<提案 ID>] [--json]（提案の履歴・1件）",
  "p3 observer switch <ID> <手順 P1> --rev <今の版> --command <確かめた呼び出し方> --body <確かめた結果>（置き換え候補のスクリプトに切り替える）",
  "p3 observer suggest --input <定義の JSON|-> [--title ..] [--body ..] [--note ..]（ID の無い互換の経路。保存しない）",
  "p3 observer prep list | show <準備 ID>（準備の一覧・詳細と、それを使う観測）",
  "p3 observer prep add [--input <JSON のファイル|->] [--title <名前>] [--body <説明>]",
  "p3 observer prep update <準備 ID> --rev <今の版> [--input ..] [--title <名前>] [--body <説明>]",
  "p3 observer prep switch <準備 ID> <check|setup|teardown> --rev <今の版> --command <確かめた呼び出し方> --body <確かめた結果>",
  "p3 observer prep rm <準備 ID> --rev <今の版>（使っている観測があれば断る）",
].join("\n  ");

/** 定義を読み書きするサブコマンド（入口がプロジェクトを決めてから呼ぶ。status だけはプロジェクトを決めない） */
export const OBSERVER_PROJECT_SUBCOMMANDS = ["list", "ls", "show", "add", "update", "suggest", "suggestions", "switch", "prep"] as const;
/** 定義を変えるサブコマンド（登録が1つだけで決まったときなどに、入口が書き込みを止めるため） */
export const OBSERVER_WRITE_SUBCOMMANDS = ["add", "update", "switch"] as const;

export const observerNeedsProject = (args: string[]) => (OBSERVER_PROJECT_SUBCOMMANDS as readonly string[]).includes(args[0] ?? "");
export const observerWrites = (args: string[]) =>
  (OBSERVER_WRITE_SUBCOMMANDS as readonly string[]).includes(args[0] ?? "") || (args[0] === "suggest" && args.length > 1) || (args[0] === "prep" && ["add", "update", "switch", "rm"].includes(args[1] ?? ""));

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
  /** add / update / suggest: 期待する結果 */
  expected?: string;
  /** switch: 確かめた呼び出し方 */
  command?: string;
  /** --repo（observer では使わない。黙って無視しないために受け取って断る） */
  repo?: string[];
  /** suggest: 補足 */
  note?: string;
  /** suggest: 入口が組み立てた提案の実行（Codex の接続を共有するアダプター入り） */
  suggestions?: () => Promise<SuggestionService>;
  /** 標準入力（--input - のとき。テストで差し替える） */
  stdin?: () => Promise<string>;
}

export type ObserverResult = { data: unknown; text: string; code?: undefined } | { code: 1 | 2 | 3; error: string };

const EXIT: Record<DefinitionError["code"], 1 | 2 | 3> = { invalid: 1, unreadable: 1, not_found: 2, conflict: 3, in_use: 3 };
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
  if (opts.repo?.length) throw new UsageError("p3 observer は --repo を使いません（手順の提案では、読める参照先を全部 AI に渡します）");
  if (sub !== "suggest" && opts.note !== undefined) throw new UsageError("--note は p3 observer suggest でだけ使えます");
  if (!opts.target) throw new Error("observer: プロジェクトが決まっていません");
  const files = opts.target.repoPath && fileChecker(opts.target.repoPath);
  const store = new DefinitionStore(opts.target.dataDir, files);
  const actor = opts.actor ?? "human:cli";
  const fail = (e: unknown): ObserverResult => {
    if (!(e instanceof DefinitionError)) throw e;
    return { code: EXIT[e.code], error: e.problems.length ? `${e.message}:\n${problemText(e.problems)}` : e.message };
  };
  try {
    if (sub === "list" || sub === "ls") {
      if (rest.length) throw new UsageError(`list は引数を取りません: ${rest.join(" ")}`);
      const l = await store.list();
      const lines = [`観測の定義 ${l.definitions.length} 件`];
      for (const d of l.definitions) lines.push(`${d.id}  v${d.rev}  [${d.category}]  ${d.title}  （測定 ${d.measures.length}・手順 ${d.procedures.length}）`);
      for (const u of l.unreadable) lines.push(`⚠ 読めないファイル ${u.file}: ${u.reason}`);
      return { data: l, text: lines.join("\n") };
    }
    if (sub === "show") {
      const [id, ...extra] = rest;
      if (!id || extra.length) throw new UsageError(`観測の定義の ID を1つ指定してください: p3 observer show <ID>`);
      const d = await store.get(id);
      return { data: d, text: describe(d, files, await store.references(d)) };
    }
    const fromFlags = (base: Record<string, unknown>) => ({
      ...base,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.category !== undefined ? { category: opts.category } : {}),
      ...(opts.body !== undefined ? { description: opts.body } : {}),
      ...(opts.expected !== undefined ? { expected: opts.expected } : {}),
    });
    if (sub === "add") {
      if (rest.length) throw new UsageError(`add は位置引数を取りません: ${rest.join(" ")}（中身は --input か --title・--category・--body）`);
      if (opts.rev !== undefined) throw new UsageError("add に --rev は要りません（版は作成で 1 になる）");
      const input = opts.input !== undefined ? await readInput(opts) : { input: {} as Record<string, unknown> };
      const d = await store.create(fromFlags(input.input), actor);
      return { data: d, text: `作成しました: ${d.id}（v${d.rev}）` };
    }
    if (sub === "prep") return await prepCommand(rest, opts, actor, files);
    if (sub === "switch") {
      const [id, pid, ...extra] = rest;
      if (!id || !pid || extra.length) throw new UsageError("p3 observer switch <ID> <手順 P1> --rev <今の版> --command <確かめた呼び出し方> --body <確かめた結果>");
      if (opts.rev === undefined) throw new UsageError("切り替えには今の定義の版を --rev で添えてください");
      const d = await store.switchProcedure(id, parseRev(opts.rev), pid, { invoke: opts.command, evidence: opts.body }, actor);
      return { data: d, text: `切り替えました: ${d.id} の ${pid}（v${d.rev}）\n${procedureLines(d.procedures.find((p) => p.id === pid)!, files).join("\n")}` };
    }
    if (sub === "suggestions") {
      const [id, sid, ...extra] = rest;
      if (!id || extra.length) throw new UsageError("p3 observer suggestions <ID> [<提案 ID>]");
      const work = new WorkStore(opts.target.dataDir);
      const def = await store.get(id);
      if (sid) {
        const j = await work.getSuggestion(def.id, sid);
        if (!j) return { code: 2, error: `提案がありません: ${sid}` };
        return { data: j, text: j.result ? suggestionText(j, files) : `${j.id}  ${j.status}${j.error ? `  ${j.error}` : ""}` };
      }
      const list = await work.listSuggestions(def.id);
      return { data: { suggestions: list }, text: [`提案 ${list.length} 件（${def.id}・今の版 v${def.rev}）`, ...list.map((j) => `${j.id}  ${j.status}  v${j.basedOnRev}  ${j.startedAt}${j.error ? `  ${j.error}` : ""}`)].join("\n") };
    }
    if (sub === "suggest" && rest.length) {
      // 保存した観測に頼む: 依頼（今の定義・版・補足）を観測に残してから始め、結果も残す
      const [id, ...extra] = rest;
      if (extra.length || opts.input !== undefined) throw new UsageError("p3 observer suggest <ID> [--note <補足>]（材料は保存した観測。--input は ID の無い互換の経路）");
      const def = await store.get(id);
      const { format: _f, id: _i, rev: _r, createdAt: _ca, createdBy: _cb, updatedAt: _ua, updatedBy: _ub, ...content } = def;
      const v = validateSuggestionRequest({ definition: content, ...(opts.note !== undefined ? { note: opts.note } : {}) });
      if (!v.ok) return { code: 1, error: `提案の依頼に誤りがあります:\n${problemText(v.problems)}` };
      if (!opts.suggestions) throw new Error("observer: 提案の実行が渡されていません");
      const job = await (await opts.suggestions()).run(v.value, { definition: def.id, basedOnRev: def.rev });
      if (job.status !== "completed" || !job.result) return { code: 1, error: `提案できませんでした（${job.failure ?? job.status}）: ${job.error ?? ""}（p3 observer suggestions ${def.id} ${job.id} で読める）`.trim() };
      return { data: job, text: `${suggestionText(job, files)}\n提案 ${job.id} を ${def.id} に残しました` };
    }
    if (sub === "suggest") {
      const input = opts.input !== undefined ? await readInput(opts) : { input: {} as Record<string, unknown> };
      const v = validateSuggestionRequest({ definition: fromFlags(input.input), ...(opts.note !== undefined ? { note: opts.note } : {}) });
      if (!v.ok) return { code: 1, error: `提案の依頼に誤りがあります:\n${problemText(v.problems)}` };
      if (!opts.suggestions) throw new Error("observer: 提案の実行が渡されていません");
      const job = await (await opts.suggestions()).run(v.value);
      if (job.status !== "completed" || !job.result) return { code: 1, error: `提案できませんでした（${job.failure ?? job.status}）: ${job.error ?? ""}`.trim() };
      // 取り込んだ形（今の測定項目と手順に、候補と提案を足したもの）。編集して p3 observer add --input / update --input に渡せる。保存はしない
      const r = job.result;
      const ids = (now: string[] | undefined, add: { id: string }[]) => [...new Set([...(now ?? []), ...add.map((x) => x.id)])];
      const definition = { ...v.value.definition, prerequisites: ids(v.value.definition.prerequisites, r.prerequisites), preparations: ids(v.value.definition.preparations, r.preparations), measures: [...v.value.definition.measures, ...r.measures], procedures: [...v.value.definition.procedures, ...r.procedures.map((p) => p.procedure)] };
      return { data: { ...job, definition }, text: `${suggestionText(job, files)}\n\n保存はしていません。--json の definition（今の手順・前提・使う準備に提案を足したもの）を編集して p3 observer add --input に渡すと登録できます（新しい準備の案は先に p3 observer prep add で登録する）` };
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
    return { data: d, text: `更新しました: ${d.id}（v${d.rev}）` };
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

type Files = ((repo: string, path: string) => FileState) | undefined;
const fileNote = (files: Files, repo: string, path: string) => `［${FILE_STATE_LABEL[files?.(repo, path) ?? "unverified"]}］`;

/** 手順を読める文にする（見出しと、実行できるものの中身） */
function procedureLines(p: Procedure, files: Files, indent = "  "): string[] {
  return [`${indent}${p.id ? `${p.id} ` : ""}${p.title}（${RUN_KIND_LABEL[p.run.kind]}）${p.measures.length ? `  測る: ${p.measures.join("・")}` : ""}`, ...executableLines(p, files, `${indent}  `)];
}

/** 今の実行方法・置き換え候補・切り替えの履歴を読める文にする（ファイルは有無を添える。手順と準備で共通） */
function executableLines(p: Executable, files: Files, i2: string): string[] {
  const r = p.run;
  const out: string[] = [];
  if (r.kind === "ai-instruction") {
    if (r.premise) out.push(`${i2}前提: ${r.premise}`);
    out.push(`${i2}対象: ${r.target}`, ...r.steps.map((x, j) => `${i2}${j + 1}. ${x}`), `${i2}判定: ${r.judge}`, `${i2}記録: ${r.record}`);
  } else if (r.kind === "command") out.push(`${i2}${[r.command, ...r.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ")}${r.repo ? `  （作業場所 ${r.repo}:${r.cwd ?? "."}）` : ""}`);
  else out.push(`${i2}${r.repo}:${r.path} ${fileNote(files, r.repo, r.path)}${r.invoke ? `  呼び出し方: ${r.invoke}` : ""}`);
  const rep = p.replacement;
  if (rep) {
    out.push(`${i2}置き換え候補: ${RUN_KIND_LABEL[rep.kind]} ${rep.repo}:${rep.path} ${fileNote(files, rep.repo, rep.path)}`);
    out.push(`${i2}  再現する操作: ${rep.operation}`, `${i2}  出力の形: ${rep.output}`, `${i2}  比べる条件: ${rep.compare}`, `${i2}  切り替えの条件: ${rep.switchWhen}`);
    if (rep.invoke) out.push(`${i2}  呼び出し方の案: ${rep.invoke}`);
  }
  for (const h of p.history ?? []) out.push(`${i2}切り替え ${h.at} ${h.by}: ${RUN_KIND_LABEL[h.from.kind]} → 呼び出し方 ${h.invoke}（根拠: ${h.evidence}）`);
  return out;
}

function suggestionText(job: SuggestionJob, files?: Files): string {
  const r = job.result!;
  const lines = [`操作面: ${SURFACE_LABEL[r.surface]}（${job.engine}）`, `根拠: ${r.rationale}`];
  for (const m of r.measures ?? []) lines.push(`測定項目の候補: ${m.name}  ${MEASURE_TYPE_LABEL[m.type]}${m.unit ? `（${m.unit}）` : ""}${m.description ? `  ${m.description}` : ""}`);
  r.procedures.forEach((p, i) => lines.push(`手順 ${i + 1}.`, ...procedureLines(p.procedure, files, "  "), `    根拠: ${p.evidence}`));
  const c = job.request?.candidates;
  for (const p of r.prerequisites) lines.push(`前提の観測の候補: ${p.id} ${c?.observations.find((o) => o.id === p.id)?.title ?? ""} — ${p.reason}`);
  for (const p of r.preparations) lines.push(`使う準備の候補（既にある）: ${p.id} ${c?.preparations.find((x) => x.id === p.id)?.name ?? ""} — ${p.reason}`);
  for (const p of r.newPreparations) lines.push(`新しい準備の案: ${p.preparation.name}（${SLOTS.filter((s) => p.preparation[s]).map((s) => SLOT_LABEL[s]).join("・") || "中身なし"}）— ${p.reason}`);
  for (const m of r.missing) lines.push(`足りない材料: ${MISSING_LABEL[m.field]} — ${m.reason}`);
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  return lines.join("\n");
}

function describe(d: ObservationDefinition, files: Files, refs: References): string {
  const lines = [`${d.id}  v${d.rev}  [${d.category}]  ${d.title}`, "", d.description, ...(d.expected ? ["", `期待する結果: ${d.expected}`] : []), ""];
  if (refs.prerequisites.length) lines.push(`前提の観測（失敗したらこの観測は未確認）: ${refs.prerequisites.map((r) => `${r.id} ${r.title ?? "（見つからない）"}`).join("・")}`);
  if (refs.preparations.length) lines.push(`使う準備: ${refs.preparations.map((r) => `${r.id} ${r.name ?? "（見つからない）"}`).join("・")}`);
  lines.push(`測定項目 ${d.measures.length} 件`);
  for (const m of d.measures) lines.push(`  ${m.name}  ${MEASURE_TYPE_LABEL[m.type]}${m.unit ? `（${m.unit}）` : ""}${m.description ? `  ${m.description}` : ""}`);
  lines.push(`確認の手順 ${d.procedures.length} 件`);
  for (const p of d.procedures) lines.push(...procedureLines(p, files));
  lines.push("", `作成 ${d.createdAt} ${d.createdBy} / 更新 ${d.updatedAt} ${d.updatedBy}`);
  return lines.join("\n");
}

/** p3 observer prep <list|show|add|update|switch|rm>（準備。観測の定義と同じ保存の層・検証） */
async function prepCommand(args: string[], opts: ObserverCliOptions, actor: string, files: Files): Promise<ObserverResult> {
  const [sub, id, ...rest] = args;
  const store = new PreparationStore(opts.target!.dataDir, files);
  const one = (usage: string, n = 0) => {
    if (!id || rest.length !== n) throw new UsageError(`p3 observer prep ${usage}`);
  };
  const fromFlags = (base: Record<string, unknown>) => ({ ...base, ...(opts.title !== undefined ? { name: opts.title } : {}), ...(opts.body !== undefined ? { description: opts.body } : {}) });
  if (sub === "list" || sub === "ls") {
    if (id) throw new UsageError("prep list は引数を取りません");
    const l = await store.list();
    const lines = [`準備 ${l.items.length} 件`, ...l.items.map((p) => `${p.id}  v${p.rev}  ${p.name}  （${SLOTS.filter((s) => p[s]).map((s) => SLOT_LABEL[s]).join("・") || "中身なし"}${p.exclusive.length ? `・占有 ${p.exclusive.join("・")}` : ""}）`)];
    for (const u of l.unreadable) lines.push(`⚠ 読めないファイル ${u.file}: ${u.reason}`);
    return { data: l, text: lines.join("\n") };
  }
  if (sub === "show") {
    one("show <準備 ID>");
    const p = await store.get(id);
    const usedBy = await store.usedBy(p.id);
    return { data: { preparation: p, usedBy }, text: describePreparation(p, usedBy.definitions, files) };
  }
  if (sub === "add") {
    if (id) throw new UsageError(`prep add は位置引数を取りません: ${id}（中身は --input か --title・--body）`);
    const input = opts.input !== undefined ? (await readInput(opts)).input : {};
    const p = await store.create(fromFlags(input), actor);
    return { data: p, text: `作成しました: ${p.id}（v${p.rev}）${p.name}` };
  }
  if (sub === "update") {
    one("update <準備 ID> --rev <今の版> [--input ..] [--title <名前>] [--body <説明>]");
    let rev = opts.rev !== undefined ? parseRev(opts.rev) : undefined;
    let base: Record<string, unknown>;
    if (opts.input !== undefined) {
      const r = await readInput(opts);
      base = r.input;
      rev ??= r.rev;
    } else base = { ...(await store.get(id)) };
    for (const k of META) delete base[k];
    if (rev === undefined) throw new UsageError("更新には今の版を --rev で添えてください（p3 observer prep show <準備 ID> で読める）");
    const p = await store.update(id, rev, fromFlags(base), actor);
    return { data: p, text: `更新しました: ${p.id}（v${p.rev}）` };
  }
  if (sub === "switch") {
    one("switch <準備 ID> <check|setup|teardown> --rev <今の版> --command <確かめた呼び出し方> --body <確かめた結果>", 1);
    if (opts.rev === undefined) throw new UsageError("切り替えには今の版を --rev で添えてください");
    const slot = rest[0] as Slot;
    const p = await store.switchSlot(id, parseRev(opts.rev), slot, { invoke: opts.command, evidence: opts.body }, actor);
    return { data: p, text: `切り替えました: ${p.id} の${SLOT_LABEL[slot]}（v${p.rev}）\n${executableLines(p[slot]!, files, "  ").join("\n")}` };
  }
  if (sub === "rm") {
    one("rm <準備 ID> --rev <今の版>");
    if (opts.rev === undefined) throw new UsageError("消すには今の版を --rev で添えてください");
    await store.remove(id, parseRev(opts.rev));
    return { data: { deleted: id }, text: `消しました: ${id}` };
  }
  throw new UsageError(`prep のサブコマンドではありません: ${sub ?? ""}（list・show・add・update・switch・rm）`);
}

function describePreparation(p: Preparation, usedBy: { id: string; title: string }[], files: Files): string {
  const lines = [`${p.id}  v${p.rev}  ${p.name}`, ...(p.description ? ["", p.description] : []), "", `占有: ${p.exclusive.join("・") || "なし"}`];
  for (const s of SLOTS) lines.push(`${SLOT_LABEL[s]}: ${p[s] ? RUN_KIND_LABEL[p[s].run.kind] : "なし"}`, ...(p[s] ? executableLines(p[s], files, "  ") : []));
  lines.push(`使う観測 ${usedBy.length} 件`, ...usedBy.map((d) => `  ${d.id}  ${d.title}`));
  lines.push("", `作成 ${p.createdAt} ${p.createdBy} / 更新 ${p.updatedAt} ${p.updatedBy}`);
  return lines.join("\n");
}
