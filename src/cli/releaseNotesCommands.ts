import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { ReleaseGeneration, ReleaseMaterial, ReleaseWarning, RequestCompletionPlan } from "../shared/types.ts";
import { exportReleaseNote, releaseNoteDetail, releaseOverview, saveReleaseNote, startGeneration } from "../core/releaseNotes/service.ts";
import { readBody, type CommandEnv } from "./args.ts";
import { table } from "./format.ts";
import { UsageError } from "./project.ts";
import { shellArg } from "./output.ts";
import { GenerationRejected } from "../core/releaseNotes/generate.ts";
import { completeMilestoneRequests, CompletionRejected } from "../core/releaseNotes/completeRequests.ts";

/**
 * p3 release-notes ...   マイルストーンごとのリリースノート（規則と保存は core/releaseNotes）
 *
 *   ls                 マイルストーンごとのノートの有無と要望の数
 *   show <id>          保存したノート（本文・版）と、対象の要望・警告
 *   generate <id>      機能の要約を生成して案を出す（保存しない。進み具合は stderr）
 *   save <id>          本文を保存する（--body 本文|- か --file。更新は --version 必須）
 *   export <id>        保存した本文だけを stdout に出す
 *   complete-requests <id> --based-on <hash>   対応済の要望を一括で完了済にする（判定と hash は show。頼めない・途中で止まったら非ゼロ）
 */
export async function releaseNotesCommand(env: CommandEnv): Promise<number> {
  const { ctx, out, args, o, actor } = env;
  const [sub = "ls", mid] = args;
  const need = () => {
    if (!mid) throw new UsageError(`p3 release-notes ${sub} <マイルストーン>`);
    return mid;
  };
  switch (sub) {
    case "ls":
    case "list": {
      const r = await releaseOverview(ctx);
      return out.result(r, () => {
        const rows = r.milestones.map((m) => [
          m.milestone,
          m.title,
          `要望 ${m.requests}`,
          m.note.state === "ok" ? `ノートあり（${m.note.updatedAt.slice(0, 10)}）` : m.note.state === "invalid" ? "ノートを読めません" : "ノートなし",
          m.known ? "" : "マイルストーンが project.yaml にありません",
        ]);
        return [table(rows) || "マイルストーンはありません（p3 milestone add v0.1 --title 最初のリリース）", ...warnLines(r.warnings)].join("\n");
      });
    }

    case "show": {
      const d = await releaseNoteDetail(ctx, need());
      return out.result(d, () => {
        const lines = [`${d.material.milestone.id}  ${d.material.milestone.title}${d.material.milestone.done ? "（リリース済み）" : ""}`, ""];
        lines.push(...materialLines(d.material), "", ...completionLines(d.completion), "");
        if (d.noteError) lines.push(`ノート: 読めません（${d.noteError}）`, "  直すまで新しく保存できません。frontmatter を直すか、本文を退避してファイルを消してください");
        else if (!d.note) lines.push("ノート: まだありません（p3 release-notes generate → save）");
        else {
          lines.push(`ノート: 更新 ${d.note.updatedAt}${d.note.updatedBy ? `（${d.note.updatedBy}）` : ""}`, `  版 ${d.note.version}（更新は --version にこの値）`);
          if (d.materialChanged) lines.push("  ※ 保存のあとで要望・タスクが変わっています（本文は変えていません。必要なら生成し直して保存してください）");
          lines.push("", d.note.body || "（本文なし）");
        }
        return lines.join("\n");
      });
    }

    case "generate": {
      if (o.engine !== undefined && o.engine !== "codex" && o.engine !== "mock") throw new UsageError("--engine は codex か mock");
      const id = need();
      const g = await startGeneration(ctx, id, actor, o.engine).catch((e: Error) => {
        // 始められなければ手で書く道を添える（実行中は別の理由なので添えない。終了コードは変えない）
        if (e instanceof GenerationRejected && e.code !== "running") e.message += `\n${manualSaveHint(id)}`;
        throw e;
      });
      const gen = ctx.releaseGenerator;
      // 進み具合は stderr（stdout は本文の案か JSON だけにする）
      let shown = 0;
      const tick = setInterval(() => (shown = flushLog(gen.get(g.id)!, shown)), 300);
      // Ctrl-C で取り消す（保存したノートは変えない）。終わるまでは何度押しても取り消すだけ
      const onInt = () => gen.cancel(g.id);
      process.on("SIGINT", onInt);
      const done = (await gen.wait(g.id))!;
      clearInterval(tick);
      process.removeListener("SIGINT", onInt);
      flushLog(done, shown);
      if (done.status !== "completed") {
        if (out.json) out.result(done, () => "");
        else process.stderr.write(`${failureLine(done)}\n`);
        // 失敗したら手で書く道を stderr に出す（--json の stdout は変えない。取消は失敗と扱わない）
        if (done.status === "failed") process.stderr.write(`${manualSaveHint(done.milestone)}\n`);
        return 1;
      }
      if (!out.json) {
        process.stderr.write(`${summaryLines(done).join("\n")}\n`);
      }
      return out.result(done, () => done.markdown!);
    }

    case "save": {
      const body = o.file !== undefined ? await readFile(resolvePath(process.cwd(), o.file), "utf8") : o.body !== undefined ? readBody(o.body) : undefined;
      if (body === undefined) throw new UsageError("本文を --body 本文|- か --file ファイルで指定してください");
      const r = await saveReleaseNote(ctx, need(), { body, title: o.title, basedOn: o["based-on"], version: o.version }, actor);
      return out.result(r, () =>
        [`保存しました: ${r.note.milestone}  版 ${r.note.version}`, `  ${ctx.ws.releaseNotes.path(r.note.milestone)}`, ...warnLines(r.warnings)].join("\n"),
      );
    }

    case "export": {
      const body = await exportReleaseNote(ctx, need());
      if (out.json) return out.result({ milestone: mid, body }, () => "");
      process.stdout.write(body);
      return 0;
    }

    case "complete-requests": {
      const id = need();
      const basedOn = o["based-on"];
      if (!basedOn) throw new UsageError(`判定を確かめた材料の hash を --based-on で指定してください（p3 release-notes show ${shellArg(id)} --json の completion.basedOn）`);
      try {
        const r = await completeMilestoneRequests(ctx, id, basedOn, actor);
        out.result(r, () =>
          [
            r.completed.length ? `完了済にしました（${r.completed.length} 件）:` : r.failed ? "完了済にした要望はありません" : "完了済にする要望はありません（変えていません）",
            ...r.completed.map((t) => `  ${t.id}  ${t.title}`),
            ...(r.failed ? [`止まりました: ${r.failed.id}（${r.failed.reason}）`, ...(r.notRun.length ? [`まだ変えていません: ${r.notRun.join(", ")}`] : []), `やり直すには show で読み直してから、表示された --based-on で実行してください`] : []),
          ].join("\n"),
        );
        return r.failed ? (r.failed.code === "error" ? 1 : 3) : 0;
      } catch (e) {
        if (!(e instanceof CompletionRejected)) throw e;
        if (out.json) out.result({ error: e.message, code: e.code, plan: e.plan }, () => "");
        else process.stderr.write(`${[e.message, ...completionLines(e.plan)].join("\n")}\n`);
        return e.code === "material_changed" ? 3 : 1;
      }
    }

    default:
      throw new UsageError("p3 release-notes [ls | show <id> | generate <id> | save <id> | export <id> | complete-requests <id> --based-on <hash>]");
  }
}

const warnLines = (ws: ReleaseWarning[]) => ws.map((w) => `  ⚠ ${w.code}: ${w.message}`);

function materialLines(m: ReleaseMaterial): string[] {
  const rows = m.requests.map((r) => [
    `  ${r.included ? "収録" : "対象外"}`,
    r.id,
    r.status,
    `${r.tasks.filter((t) => t.hasRecord).length}/${r.tasks.length} 記録`,
    r.title,
    r.reason ? `（${r.reason}）` : "",
  ]);
  return [
    `対象の要望 ${m.requests.length} 件（収録 ${m.requests.filter((r) => r.included).length}）  材料 ${m.hash.slice(0, 12)}`,
    ...(rows.length ? [table(rows)] : ["  （このマイルストーンの要望はありません）"]),
    ...warnLines([...m.warnings, ...m.requests.flatMap((r) => r.warnings)]),
  ];
}

/** 要望を一括で完了済にできるか（show と、頼めなかったとき） */
function completionLines(p: RequestCompletionPlan): string[] {
  const head = !p.ready
    ? "要望の一括完了: できません（見送り以外の全要望が、全タスク完了の対応済か完了済になってから）"
    : p.targets.length
      ? `要望の一括完了: 対応済 ${p.targets.length} 件を完了済にできます（タスクの済みは変えません）`
      : "要望の一括完了: 完了済にする要望はありません";
  return [
    head,
    ...p.blockers.map((b) => `  ✕ ${b.target}: ${b.reason}`),
    ...p.targets.map((t) => `  → ${t.id}  ${t.title}`),
    ...(p.ready && p.targets.length ? [`  実行: p3 release-notes complete-requests ${shellArg(p.milestone)} --based-on ${p.basedOn}`] : []),
  ];
}

function flushLog(g: ReleaseGeneration, from: number): number {
  for (const e of g.log.slice(from)) process.stderr.write(`[${e.kind}] ${e.text}\n`);
  return g.log.length;
}

/** 要約を生成できないときの、本文を手で書いて保存する道（Codex・Docker・ChatGPT は要らない） */
function manualSaveHint(mid: string): string {
  const m = shellArg(mid);
  return [
    "生成せずに、本文を手で書いて保存できます（Docker や ChatGPT の接続は要りません）:",
    `  p3 release-notes show ${m}                       # 材料（収録する要望と変更の記録）を確かめる`,
    `  p3 release-notes save ${m} --file <本文.md>       # 新しく保存する`,
    `  既にノートがあるときは、show で読んだ版を付けて更新します: p3 release-notes save ${m} --file <本文.md> --version <版>`,
  ].join("\n");
}

function failureLine(g: ReleaseGeneration): string {
  if (g.status === "cancelled") return "取り消しました（保存したノートは変えていません）";
  return `生成できませんでした（${g.failure}）: ${g.error}（保存したノートは変えていません）`;
}

function summaryLines(g: ReleaseGeneration): string[] {
  return [
    `生成しました: ${g.id}（保存はしていません）  材料 ${g.materialHash.slice(0, 12)}`,
    "出典:",
    ...g.items!.map((x, i) => `  ${i + 1}. ${x.sources.join(", ")}`),
    ...warnLines(g.warnings),
    `保存するときは本文を確かめてから: p3 release-notes save ${g.milestone} --file <本文.md> --based-on ${g.materialHash}`,
  ];
}
