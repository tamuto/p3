import { readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve as resolvePath } from "node:path";
import { AttachmentError, safeFileName } from "../core/store/attachments.ts";
import { type AdoptionResult, type PreflightRun, type InputMatch, type MaterializeResult, type UiMaterialsStatus, UI_MATERIAL_KINDS, type Attachment, ATTACHMENT_FORMATS } from "../shared/types.ts";
import { type P3Context } from "../core/context.ts";
import { NotFoundError } from "../core/store/collection.ts";
import { table } from "./format.ts";
import { evidenceLines, scopeLines } from "../shared/scopeView.ts";
import { UsageError } from "./project.ts";
import { StaleInputError, staleMessage } from "../core/preflight/input.ts";
import { changedLabel, isMaterialized } from "../shared/preflightInput.ts";
import { readBody, type CommandEnv } from "./args.ts";
import { deps, directTaskHint, indent } from "./output.ts";
import { PreflightBusyError } from "../core/preflight/service.ts";
import { preflightFailed } from "../shared/directTask.ts";

/** Preflight のコマンド（preflight / attach / notes / drafts / accept）。扱わないコマンドは undefined */

export async function preflightCommand(cmd: string, env: CommandEnv): Promise<number | undefined> {
  const { ctx, out, args, o, actor, requestArg, cwd } = env;
  switch (cmd) {
    // --- Preflight ----------------------------------------------------------
    case "preflight": {
      const rid = requestArg(args[0]);
      const engine = o.engine as "codex" | "mock" | undefined;
      if (o["note-only"] && o.note === undefined) throw new UsageError("--note-only には --note でメモを渡してください");
      if (o["note-only"] && engine) throw new UsageError("--note-only は実行しないので --engine は使えません");
      const note = o.note === undefined ? undefined : await ctx.preflight.addNote(rid, readBody(o.note), actor);
      if (o["note-only"]) return out.result(note, () => `メモ ${note!.id} を書き足しました（次の Preflight に渡します）`);
      if (note && !out.json) process.stderr.write(`メモ ${note.id} を書き足しました\n`);
      const off = ctx.ws.on((e) => {
        if (e.type === "preflight-log" && !out.json) process.stderr.write(`${e.entry.at.slice(11, 19)} ${e.entry.text}\n`);
      });
      const hint = () => directTaskHint(rid, { project: o.project, dir: o.dir });
      const started = await ctx.preflight.start(rid, { engine, actor }).catch((e: Error) => {
        off();
        // メモは残っているので、書き直さずに p3 preflight だけで再実行できる
        const err = note ? new Error(`${e.message}（メモ ${note.id} は保存済みです。p3 preflight ${rid} で再実行できます）`) : e;
        // 始められなかったら直接作る道を添える（実行中・要望が無いときは別の理由なので添えない。終了コードは変えない）
        if (!(e instanceof PreflightBusyError) && !(e instanceof NotFoundError)) err.message += `\n${hint()}`;
        throw err;
      });
      if (!out.json) process.stderr.write(`preflight ${started.id} (${started.engine})\n`);
      const run = await ctx.preflight.wait(rid, started.id);
      off();
      if (!run) throw new Error("preflight の結果が読めません");
      out.result(run, () => formatRun(ctx, rid, run));
      // 失敗したら直接作る道を stderr に出す（--json の stdout は変えない。取消は失敗と扱わない）
      if (preflightFailed(run)) process.stderr.write(`${hint()}\n`);
      return run.status === "completed" ? 0 : 1;
    }

    case "attach": {
      // 要望は --req（か今の要望）。serve なしでファイルを直接扱う（API と同じ確かめ方）
      const rid = requestArg(undefined);
      const [sub = "ls", target] = args;
      const fmt = (a: Attachment) => [a.id, ATTACHMENT_FORMATS[a.format], `${Math.ceil(a.bytes / 1024)}KB`, a.name, a.description ?? "", a.source ? `出典: ${a.source}` : ""];
      if (sub === "ls") {
        const { items, invalid } = await ctx.ws.attachments.list(rid);
        return out.result({ items, invalid }, () =>
          [
            items.length ? table(items.map(fmt)) : "添付はありません",
            ...invalid.map((i) => `[読めない] ${i.id}: ${i.error}`),
            "",
            "次の Preflight を始めるときに、この添付を run に固定して渡します（後で足し・消ししても過去の run の資料は変わりません）",
          ].join("\n"),
        );
      }
      if (sub === "add") {
        if (!target) throw new UsageError("p3 attach add <ファイル> [--description 説明] [--source 出典] --req <要望>");
        const data = await readFile(resolvePath(cwd, target)).catch(() => {
          throw new UsageError(`ファイルが読めません: ${target}`);
        });
        try {
          const a = await ctx.preflight.addAttachment(rid, { data, name: basename(target), description: o.description, source: o.source }, actor);
          return out.result(a, () => `添付しました: ${table([fmt(a)])}\n次の Preflight に渡します`);
        } catch (e) {
          throw e instanceof AttachmentError ? new UsageError(e.message) : e;
        }
      }
      if (sub === "get") {
        if (!target) throw new UsageError("p3 attach get <A-ID> [--out ファイル] [--run PF-...]（--run でその run に固定した原本）");
        const got = o.run ? await ctx.preflight.fixedAttachment(rid, o.run, target) : await ctx.ws.attachments.content(rid, target).catch((e) => {
          throw e instanceof AttachmentError ? new NotFoundError(e.message) : e;
        });
        const file = resolvePath(cwd, o.out ?? safeFileName(got.meta.name, got.meta.format));
        await writeFile(file, got.data, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
          throw e.code === "EEXIST" ? new UsageError(`${file} は既にあります（--out で別の名前に）`) : e;
        });
        return out.result({ ...got.meta, file }, () => `書き出しました: ${file}`);
      }
      if (sub === "rm") {
        if (!target) throw new UsageError("p3 attach rm <A-ID>");
        await ctx.preflight.removeAttachment(rid, target).catch((e) => {
          throw e instanceof AttachmentError ? new NotFoundError(target) : e;
        });
        return out.result({ removed: target }, () => `添付を外しました: ${target}（固定済みの過去の run の資料は残ります）`);
      }
      throw new UsageError("p3 attach [ls | add <ファイル> | get <A-ID> | rm <A-ID>] --req <要望>");
    }

    case "notes": {
      const rid = requestArg(args[0]);
      const { notes, invalid } = await ctx.ws.notes.list(rid);
      const carry = await ctx.preflight.carryover(rid);
      const pending = new Set(carry.notes.map((n) => n.id));
      const items = notes.map((n) => ({ ...n, pending: pending.has(n.id) }));
      return out.result({ notes: items, invalid, previous: carry.previous?.id ?? null, previousSkipped: carry.previousSkipped ?? null }, () =>
        [
          `次の Preflight: ${carry.previous ? `前回 ${carry.previous.id} を引き継ぐ` : carry.previousSkipped ? `前回を引き継がない（${carry.previousSkipped}）` : "前回なし"}・メモ ${carry.notes.length} 件を渡す`,
          ...items.map((n) => `\n${n.pending ? "[未]" : "[済]"} ${n.id}  ${n.createdBy ?? ""}  ${n.createdAt.slice(0, 16).replace("T", " ")}\n${indent(n.body)}`),
          ...invalid.map((i) => `\n[読めない] ${i.file}: ${i.error}`),
        ].join("\n"),
      );
    }

    case "drafts": {
      const rid = requestArg(args[0]);
      const run = await pickRun(ctx, rid, o.run);
      // タスク化の前なら、置き換えられる既存タスクも見せる（分割の run には無い）
      const supersedes = run.materialized?.length || run.children ? [] : (await ctx.preflight.previewMaterialize(rid, run.id)).candidates;
      const inputMatch = await ctx.preflight.inputMatch(rid, run);
      return out.result({ ...run, inputMatch, supersedes }, () =>
        [
          formatRun(ctx, rid, run),
          inputMatchLine(rid, run, inputMatch),
          supersedes.length
            ? `\n置き換えられる既存タスク（accept では残す。--archive-superseded でアーカイブ）:\n${table(supersedes.map((c) => [c.id, c.status, c.title]))}`
            : "",
        ].join("\n"),
      );
    }

    case "accept": {
      const rid = requestArg(args[0]);
      const run = await pickRun(ctx, rid, o.run);
      const keys = (s: string | undefined) => s?.split(",").map((x) => x.trim().toUpperCase());
      const only = keys(o.only);
      const skip = keys(o.skip) ?? [];
      if (run.children) return adoptChildren(ctx, out, rid, run, only, skip, actor, !!o.json);
      for (const d of run.drafts) {
        const include = (only ? only.includes(d.key) : d.include) && !skip.includes(d.key);
        if (include !== d.include) await ctx.preflight.updateDraft(rid, run.id, d.key, { include });
      }
      // 置き換えられるタスクは --archive-superseded のときだけ、確定時点の候補（プレビューと同じ rev）をアーカイブする
      const { candidates } = await ctx.preflight.previewMaterialize(rid, run.id);
      const archive = o["archive-superseded"] ? candidates.map((c) => ({ id: c.id, rev: c.rev })) : [];
      let r: MaterializeResult;
      try {
        r = await ctx.preflight.materialize(rid, run.id, actor, { archive });
      } catch (e) {
        if (!(e instanceof StaleInputError) || !o.json) throw e;
        // --json では理由を機械可読で返す（終了コードは 1）
        out.result({ error: e.message, code: e.code, request: rid, run: run.id, inputMatch: e.match }, () => "");
        return 1;
      }
      return out.result(r, () =>
        [
          `タスク化 (${rid} / ${run.id}):\n${table(r.tasks.map((t) => [t.id, t.title, deps(t)]))}`,
          r.archived.length ? `\n置き換えられたタスクをアーカイブしました: ${r.archived.join(", ")}` : "",
          r.kept.length
            ? `\n置き換えられるタスクを残しました（着手前に確かめ、不要なら p3 archive <T> か accept --archive-superseded）:\n${table(
                r.kept.map((c) => [c.id, c.status, c.title, c.reasons.map((x) => `案 ${x.draft}`).join(",")]),
              )}`
            : "",
        ].join("\n"),
      );
    }

  }
  return undefined;
}

/**
 * 分割の run の採用: 選んだ子の案から子の要望を作る（子のタスク化・Preflight はしない）。途中で失敗したら作った・失敗・未実行を出し、
 * 同じ accept でやり直せる（作った子は作り直さない）。終了コード: 全部作れたら 0、失敗があれば 1
 */
async function adoptChildren(ctx: P3Context, out: CommandEnv["out"], rid: string, run: PreflightRun, only: string[] | undefined, skip: string[], actor: string, json: boolean) {
  if (!run.adoption) {
    for (const c of run.children ?? []) {
      const include = (only ? only.includes(c.key) : c.include) && !skip.includes(c.key);
      if (include !== c.include) await ctx.preflight.updateChild(rid, run.id, c.key, { include });
    }
  } else if (only || skip.length) {
    throw new UsageError(`${run.id} は採用を始めています（選んだ案: ${run.adoption.keys.join(", ")}）。--only / --skip を外して、同じ採用を続けてください`);
  }
  let r: AdoptionResult;
  try {
    r = await ctx.preflight.adopt(rid, run.id, actor);
  } catch (e) {
    if (!(e instanceof StaleInputError) || !json) throw e;
    out.result({ error: e.message, code: e.code, request: rid, run: run.id, inputMatch: e.match }, () => "");
    return 1;
  }
  const title = (id: string) => ctx.ws.requests.get(id)?.title ?? "";
  out.result(r, () =>
    [
      `子の要望を作りました (${rid} / ${run.id}):`,
      table(r.created.map((c) => [`  ${c.key}`, c.id, title(c.id)])) || "  （なし）",
      ...r.failed.map((f) => `\n作れませんでした: ${f.key}（${f.error}）`),
      r.pending.length ? `まだ作っていない案: ${r.pending.join(", ")}（直してから p3 accept ${rid} --run ${run.id} で続けます。作った子は作り直しません）` : "",
      r.failed.length ? "" : `\n親 ${rid} は残します。子ごとに Preflight を実行してください（例: p3 preflight ${r.created[0]?.id ?? "<子>"}）`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return r.failed.length ? 1 : 0;
}

/** 評価対象と今の要望の比較（drafts の表示） */
function inputMatchLine(rid: string, run: PreflightRun, m: InputMatch): string {
  if (m.status === "same") return "";
  if (isMaterialized(run)) {
    return `\n※ この評価のあとで要望が変わっています（${m.status === "changed" ? changedLabel(m.changed) : m.reason}）。タスク化は済んでいます。作り直すなら p3 preflight ${rid}`;
  }
  return `\n※ ${staleMessage(rid, run.id, m)}`;
}

async function pickRun(ctx: P3Context, rid: string, runId?: string) {
  const runs = await ctx.preflight.list(rid);
  const run = runId ? runs.find((r) => r.id === runId) : runs[0];
  if (!run) throw new NotFoundError(runId ?? `${rid} の preflight`);
  return run;
}

function formatRun(ctx: P3Context, rid: string, run: Awaited<ReturnType<typeof pickRun>>): string {
  const lines = [`${rid} / ${run.id}  ${run.engine}  ${run.status}${run.startedBy ? `  ${run.startedBy}` : ""}`];
  if (run.previous || run.notes?.length) {
    lines.push(`引き継ぎ: ${run.previous ? `前回 ${run.previous}` : "前回なし"}${run.notes?.length ? ` / メモ ${run.notes.join(", ")}` : ""}`);
  }
  if (run.error) lines.push(`エラー: ${run.error}`);
  const a = run.assessment;
  if (a) {
    lines.push("", `判定: ${a.verdict}  妥当性 ${a.validity.score} / 実現可能性 ${a.feasibility.score}`, indent(a.summary));
    if (a.risks.length) lines.push("", "リスク:", ...a.risks.map((x) => `  - ${x}`));
    if (a.questions.length) lines.push("", "確認事項:", ...a.questions.map((x) => `  - ${x}`));
  }
  lines.push("", ...scopeLines(run.scope));
  if (a) lines.push("", ...evidenceLines(a.evidence));
  if (run.scope?.some((s) => s.status === "unregistered")) lines.push("  → このマシンのパスは p3 repo path <名前> <パス> で登録します");
  if (run.drafts.length) {
    lines.push("", `タスク案 (${run.drafts.filter((d) => d.include).length}/${run.drafts.length} 件を採用):`);
    const multi = ctx.ws.project.repos.length > 0;
    lines.push(
      table(
        run.drafts.map((d) => [
          d.include ? "[x]" : "[ ]",
          d.key,
          ...(multi ? [d.repo ?? "（作業先なし）"] : []),
          d.title,
          d.dependsOn.length ? `← ${d.dependsOn.join(",")}` : "",
        ]),
      ),
    );
    lines.push("", `ファイル: ${relative(process.cwd(), join(ctx.ws.preflight.runDir(rid, run.id), "drafts"))}/`);
  }
  if (a?.split) {
    lines.push("", `分割: ${a.split.decision === "split" ? "子の要望に分ける" : "分けない"}${a.split.estimatedTasks !== undefined ? `（想定 ${a.split.estimatedTasks} 件）` : ""}`, ...a.split.reasons.map((x) => `  - ${x}`));
  }
  if (run.children) {
    lines.push("", `子の要望の案 (${run.children.filter((c) => c.include).length}/${run.children.length} 件を採用):`);
    lines.push(
      table(
        run.children.map((c) => [
          c.include ? "[x]" : "[ ]",
          c.key,
          c.title,
          c.estimatedTasks !== undefined ? `想定 ${c.estimatedTasks} 件` : "",
          c.requires.length ? `前提 ${c.requires.join(",")}` : "",
          c.overlaps.length ? `重なり ${c.overlaps.join(",")}` : "",
          run.adoption?.reserved[c.key] ? `→ ${run.adoption.reserved[c.key]}${run.adoption.created.includes(c.key) ? "" : "（予約）"}` : "",
        ]),
      ),
    );
    for (const p of run.draftProblems ?? []) lines.push(`  [問題] ${p}`);
    lines.push("", `ファイル: ${relative(process.cwd(), join(ctx.ws.preflight.runDir(rid, run.id), "children"))}/`);
    lines.push(run.adoption?.done ? "子の要望を作成済み（子ごとに Preflight を実行します）" : `採用: p3 accept ${rid} --run ${run.id}（親は残し、子の要望だけを作ります。子の Preflight はまだ）`);
  }
  lines.push("", ...uiLines(run.ui, relative(process.cwd(), join(ctx.ws.preflight.runDir(rid, run.id), "ui"))));
  if (run.materialized?.length) lines.push("", `タスク化済み: ${run.materialized.join(", ")}`);
  return lines.join("\n");
}

const UI_STATUS: Record<UiMaterialsStatus, string> = { generating: "評価中", ready: "そろっています", not_needed: "不要", missing: "足りません" };

/** 画面資料（ui/）。資料 ID は画面・API（/api/requests/<要望>/preflight/<run>/ui/<ID>）と同じ */
function uiLines(ui: PreflightRun["ui"], dir: string): string[] {
  if (!ui) return ["画面資料: 記録なし（以前の run）"];
  const lines = [`画面資料: ${UI_STATUS[ui.status]}${ui.reason ? `（${ui.reason}）` : ""}`];
  if (ui.verdictAdjusted) lines.push("  → 必要な画面イメージが足りないので、判定を go から clarify にしました");
  if (ui.items.length) {
    lines.push(
      table(
        ui.items.map((m) => [`  ${m.id}`, UI_MATERIAL_KINDS[m.kind], m.drafts.join(","), `${m.width}x${m.height}`, m.title, `ui/${m.file}`]),
      ),
    );
    for (const m of ui.items.filter((x) => x.assumptions.length)) lines.push(`  ${m.id} の前提: ${m.assumptions.join(" / ")}`);
    if (ui.items.some((m) => m.rendered)) lines.push("  P3 が原稿から描いた画像です（Codex は画像を見ていません。読めるかは画像で確かめてください）");
    lines.push(`  ファイル: ${dir}/`);
  }
  for (const p of ui.problems) lines.push(`  [取り込めない] ${p}`);
  return lines;
}

