import { resolveRequestId } from "../core/ops.ts";
import { NotFoundError } from "../core/store/collection.ts";
import type { TaskReviewDetail } from "../core/taskReview/service.ts";
import { normalizeTaskId } from "../shared/refs.ts";
import { previewOf, TASK_REVIEW_SCOPE, TASK_REVIEW_VERDICT_LABELS, TASK_REVIEW_VERDICTS, type TaskReviewVerdict } from "../shared/taskReview.ts";
import type { CommandEnv } from "./args.ts";
import { table } from "./format.ts";
import { UsageError } from "./project.ts";

/**
 * タスクの AI レビュー（core/taskReview。画面と同じサービス）。
 *   review <T> [--target ...] [--viewpoint ...] [--engine codex|mock] [--preview]   材料を固定して始め、終わるまで待つ（進み具合は stderr、
 *                                                                                  Ctrl-C で取り消す）。--preview は材料を見るだけ
 *   reviews <T> / review-show <T> <run> / review-cancel <T> <run> [--acknowledge-stopped]
 * 結果は参考の記録で、タスクの状態・済み・基準・証拠を変えない。アーカイブしたタスクの履歴も読める
 */

const STATUS_LABEL = { running: "実行中", completed: "完了", failed: "失敗", cancelled: "取消" } as const;

/** タスクの参照（アーカイブしたタスクも読むので、今のタスクの一覧では探さない） */
function taskKey({ ctx, current }: CommandEnv, raw: string | undefined): { rid: string; tid: string } {
  if (!raw) throw new UsageError("タスクを指定してください（T003 / <要望>/T003）");
  const [head, tail] = raw.split("/", 2);
  const rid = tail !== undefined ? resolveRequestId(ctx, head) : current;
  if (tail === undefined && !current) throw new UsageError(`${raw}: 要望を --req で指定してください`);
  if (!rid) throw new NotFoundError(head);
  const tid = normalizeTaskId(tail ?? head);
  if (!tid) throw new UsageError(`${raw}: タスクの ID（T003）を指定してください`);
  return { rid, tid };
}

export async function taskReviewCommand(cmd: string, env: CommandEnv): Promise<number | undefined> {
  if (cmd !== "review" && cmd !== "reviews" && cmd !== "review-show" && cmd !== "review-cancel") return undefined;
  const { ctx, out, args, o, actor } = env;
  const svc = ctx.taskReview;
  const { rid, tid } = taskKey(env, args[0]);
  const key = `${rid}/${tid}`;

  if (cmd === "reviews") {
    const items = await svc.list(rid, tid);
    return out.result(items, () =>
      items.length
        ? table(
            items.map((x) =>
              x.state === "broken"
                ? [x.id, "読めない", x.error]
                : [x.run.id, STATUS_LABEL[x.run.status], x.run.startedAt.slice(0, 16).replace("T", " "), verdictSummary(x.verdicts), x.run.error ?? ""],
            ),
          )
        : `レビューの履歴はありません（p3 review ${key}）`,
    );
  }
  if (cmd === "review-show" || cmd === "review-cancel") {
    const run = args[1];
    if (!run) throw new UsageError(`p3 ${cmd} ${key} <run>`);
    if (cmd === "review-show") {
      const d = await svc.get(rid, tid, run);
      return out.result(d, () => formatTaskReview(d));
    }
    const r = await svc.cancel(rid, tid, run, actor, { acknowledgeStopped: o["acknowledge-stopped"] });
    return out.result(r, () =>
      r.requested
        ? `取消を頼みました: ${key}/${run}（実行しているプロセスが見つけて止めます）`
        : r.run.abandoned
          ? `中断にしました: ${key}/${run}（記録の上で終わりにしました。ほかの環境で動いているプロセスを止めたとは限りません）`
          : `終わりにしました: ${key}/${run}（${STATUS_LABEL[r.run.status]}${r.run.error ? `: ${r.run.error}` : ""}）`,
    );
  }

  if (o.engine !== undefined && o.engine !== "codex" && o.engine !== "mock") throw new UsageError("--engine は codex か mock");
  const opts = { targets: o.target, viewpoint: o.viewpoint };
  if (o.preview) {
    const p = await svc.preview(rid, tid, opts);
    const view = { ...previewOf(p.input), engineRequired: p.engineRequired };
    return out.result(view, () => formatPreview(view));
  }
  const started = await svc.start(rid, tid, actor, { ...opts, engine: o.engine });
  process.stderr.write(`レビューを始めました: ${key}/${started.id}（Ctrl-C で取り消す）\n`);
  let shown = 0;
  const tick = setInterval(() => {
    void svc.get(rid, tid, started.id).then((d) => {
      for (const e of d.run.log.slice(shown)) process.stderr.write(`  ${e.text}\n`);
      shown = Math.max(shown, d.run.log.length);
    }, () => undefined);
  }, 500);
  const onInt = () => void svc.cancel(rid, tid, started.id, actor).catch(() => undefined);
  process.on("SIGINT", onInt);
  const d = await svc.wait(rid, tid, started.id);
  clearInterval(tick);
  process.removeListener("SIGINT", onInt);
  for (const e of d.run.log.slice(shown)) process.stderr.write(`  ${e.text}\n`);
  if (d.run.status !== "completed") {
    if (out.json) out.result(d, () => "");
    else process.stderr.write(`${STATUS_LABEL[d.run.status]}: ${d.run.error ?? ""}\n`);
    return 1;
  }
  return out.result(d, () => formatTaskReview(d));
}

function verdictSummary(v: Partial<Record<TaskReviewVerdict, number>> | undefined): string {
  if (!v) return "";
  return TASK_REVIEW_VERDICTS.filter((k) => v[k]).map((k) => `${TASK_REVIEW_VERDICT_LABELS[k]} ${v[k]}`).join(" · ");
}

function formatPreview(p: ReturnType<typeof previewOf> & { engineRequired: boolean }): string {
  const lines = [`${p.task.ref}  ${p.task.title}`, `材料の hash: ${p.hash}`, "", "比較項目:"];
  for (const i of p.items) lines.push(`  ${i.id}  ${i.text.split("\n")[0]}${i.kind === "body" ? "（本文から）" : ""}`);
  lines.push("", "比較対象:");
  for (const t of p.targets) {
    lines.push(`  ${t.repo}  ${t.kind === "range" ? `${t.range!.baseSpec}..${t.range!.headSpec}（merge-base ${t.range!.mergeBase.slice(0, 12)}）` : "コミット"}  変更 ${t.changes} 件  出典: ${t.sources.join(", ")}`);
    for (const c of t.commits) lines.push(`    ${c.sha.slice(0, 12)}  ${c.subject}${c.otherTasks.length ? `  ※ほかのタスク ${c.otherTasks.join(", ")}` : ""}`);
  }
  lines.push("", `観点: ${p.viewpoint.source}${p.viewpoint.repo ? `（${p.viewpoint.repo}@${p.viewpoint.sha?.slice(0, 12)}:${p.viewpoint.path}）` : ""}`);
  for (const n of p.notes) lines.push(`  ⚠ ${n.message}`);
  if (p.engineRequired) lines.push("", "※ Preflight の担当が agent なので、Codex で実行するなら --engine codex を付けてください");
  return lines.join("\n");
}

/** review-show の人向けの表示 */
export function formatTaskReview(d: TaskReviewDetail): string {
  const { run, input, result } = d;
  const lines = [`${run.request}/${run.task}/${run.id}  ${STATUS_LABEL[run.status]}  ${run.startedAt}${run.startedBy ? `  ${run.startedBy}` : ""}  (${run.engine}${run.model ? ` ${run.model}` : ""})`];
  if (run.error) lines.push(`  ${run.error}`);
  if (d.owner && d.owner.state !== "local" && d.owner.state !== "alive") {
    lines.push(`  実行しているプロセスを確かめられません（${"reason" in d.owner ? d.owner.reason : ""}）。止まっていると確かめたら p3 review-cancel ${run.request}/${run.task} ${run.id} --acknowledge-stopped`);
  }
  lines.push(`材料: 比較項目 ${input.items.length} 件・ファイル ${input.files.length} 件・観点 ${input.viewpoint.source}（${input.extractedAt}）`);
  for (const t of input.targets) lines.push(`  ${t.repo}: ${t.kind === "range" ? `${t.range!.base.slice(0, 12)}..${t.range!.head.slice(0, 12)}` : t.commits.map((c) => c.sha.slice(0, 12)).join(", ")}`);
  for (const n of input.notes) lines.push(`  ⚠ ${n.message}`);
  if (result) {
    const text = new Map(input.items.map((i) => [i.id, i.text]));
    lines.push("", "全体の所見:", ...result.overall.split("\n").map((l) => `  ${l}`), "");
    for (const i of result.items) {
      lines.push(`■ ${i.item}  ${TASK_REVIEW_VERDICT_LABELS[i.verdict]}  ${(text.get(i.item) ?? "").split("\n")[0]}`);
      lines.push(`  理由: ${i.reason}`);
      if (i.evidence.length) lines.push(`  根拠: ${i.evidence.join(", ")}`);
      for (const g of i.gaps) lines.push(`  不足: ${g}`);
    }
    lines.push("", "意図しない変更の候補:");
    if (!result.unplanned.length) lines.push("  （見つかっていません）");
    for (const u of result.unplanned) lines.push(`  - ${u.text}${u.evidence.length ? `（根拠: ${u.evidence.join(", ")}）` : ""}`);
    if (result.checks.length) lines.push("", "人が確かめる点:", ...result.checks.map((c) => `  - ${c}`));
    lines.push("", `読めた範囲: ${result.coverage.read}`, `読めなかった範囲: ${result.coverage.unread || "（なし）"}`, "", `範囲: ${TASK_REVIEW_SCOPE}`);
  }
  return lines.join("\n");
}
