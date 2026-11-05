import { readFile } from "node:fs/promises";
import { basename, relative, resolve as resolvePath } from "node:path";
import { REQUEST_STATUSES, type Attachment, type Milestone, type Request } from "../shared/types.ts";
import { nextGoalId } from "../shared/milestoneGoals.ts";
import { REVIEW_STATUS_LABELS, REVIEW_VERDICT_LABELS, REVIEW_VERDICTS, type ReviewVerdict } from "../shared/milestoneReview.ts";
import type { ReviewDetail } from "../core/milestoneReview/service.ts";
import { type P3Context } from "../core/context.ts";
import { archiveRequest, checkMilestone, checkMilestoneRemoval, createRequest, orderChildren, updateRequest } from "../core/requestOps.ts";
import { hierarchyNow, resolvedIssue } from "../core/requestStatus.ts";
import { hierarchyView } from "../core/hierarchy.ts";
import { resolveRequestId } from "../core/ops.ts";
import { table } from "./format.ts";
import { requestWorkstreams, taskRepo } from "../shared/workTarget.ts";
import { briefRequest, formatBriefRequest, formatFamily } from "./showView.ts";
import { UsageError } from "./project.ts";
import { tagsFrom } from "../shared/tags.ts";
import { sortMilestones } from "../shared/milestoneOrder.ts";
import { parse, splitPair, list, date, readBody, readAttachFiles } from "./args.ts";
import { Output, formatEntity, deps, reopenedNote, warn } from "./output.ts";

/** 要望（p3 request ...）とマイルストーン（p3 milestone ...）のコマンド。変更は server/requestOps.ts を通す */

// --- 要望 -----------------------------------------------------------------

export async function requestCommand(
  ctx: P3Context,
  out: Output,
  args: string[],
  o: ReturnType<typeof parse>["values"],
  actor: string,
  requestArg: (raw: string | undefined) => string,
  expectedRev: number | undefined,
): Promise<number> {
  const [sub, ...rest] = args;
  // 親は短い書き方（k7m3x）でもよい。解けなければそのまま渡し、規則（無い・形が違う）で断る
  const parentArg = (raw: string) => resolveRequestId(ctx, raw) ?? raw;
  switch (sub) {
    case "new":
    case "add": {
      const title = rest.join(" ").trim();
      if (!title) throw new UsageError("タイトルを指定してください");
      checkMilestone(ctx, o.milestone);
      const files = await readAttachFiles(o.attach ?? []);
      const r = await createRequest(
        ctx,
        { title, body: readBody(o.body), areas: o.area ?? [], tags: tagsFrom(o.tag ?? []), due: o.due && date(o.due), milestone: o.milestone, ...(o.parent ? { parent: parentArg(o.parent) } : {}) },
        actor,
      );
      warn(r.warnings ?? []);
      reopenedNote(undefined, r.reopenedAncestors);
      const head = `作成: ${r.id}  ${r.title}${r.parent ? `（${r.parent} の子）` : ""}\n  ${relative(process.cwd(), ctx.ws.requests.path(r.id))}`;
      if (!files.length) return out.result(r, () => head);
      // 確かめ済みなので通常は失敗しない。失敗しても要望は残し、付け直す方法を出す
      const attachments: Attachment[] = [];
      const failed: { file: string; error: string }[] = [];
      for (const f of files) {
        try {
          attachments.push(await ctx.preflight.addAttachment(r.id, { data: f.data, name: basename(f.path) }, actor));
        } catch (e) {
          failed.push({ file: f.path, error: (e as Error).message });
        }
      }
      out.result({ ...r, attachments, ...(failed.length ? { failedAttachments: failed } : {}) }, () =>
        [
          head,
          ...attachments.map((a) => `  添付: ${a.id}  ${a.name}`),
          ...failed.map((f) => `  添付できませんでした: ${f.file}（${f.error}）→ p3 attach add ${f.file} --req ${r.id}`),
        ].join("\n"),
      );
      return failed.length ? 1 : 0;
    }
    case undefined:
    case "ls":
    case "list": {
      const status = o.status?.split(",");
      // --parent: 直下の子だけを、親の表示順（子の一覧・詳細・画面と同じ）で
      const parent = o.parent === undefined ? undefined : parentArg(o.parent);
      const reqs = (parent === undefined ? ctx.ws.requests.list() : hierarchyNow(ctx.ws).children(parent))
        .filter((r) => !status || status.includes(r.status))
        .filter((r) => !o.milestone || r.milestone === o.milestone)
        .filter((r) => !o.tag?.length || o.tag.some((t) => r.tags.includes(t)));
      return out.result(reqs, () =>
        table(reqs.map((r) => [r.id, r.status, r.title, r.milestone ?? "", r.due ?? "", r.tags.map((t) => `#${t}`).join(" "), r.parent ? `↑${r.parent}` : ""])) || "要望はありません",
      );
    }
    case "show": {
      const rid = requestArg(rest[0]);
      const r = ctx.ws.requests.require(rid);
      const family = await hierarchyView(ctx.ws, rid);
      if (o.brief) {
        const view = { ...briefRequest(ctx, r, resolvedIssue(ctx.ws, r)), ...family };
        return out.result(view, () => formatBriefRequest(view));
      }
      const file = relative(process.cwd(), ctx.ws.requests.path(rid));
      const issue = resolvedIssue(ctx.ws, r);
      const branches = requestWorkstreams(r);
      const multi = ctx.ws.project.repos.length > 0;
      return out.result({ item: r, workstreams: branches, tasks: ctx.ws.tasksOf(rid).list(), file, ...family, ...(issue ? { issue } : {}) }, () => {
        const tasks = ctx.ws.tasksOf(rid).list();
        return [
          issue ? `※ ${issue}\n` : "",
          ...family.hierarchyIssues.map((i) => `※ ${i.message}\n`),
          formatEntity(ctx, r, file),
          ...formatFamily(family),
          ...(Object.keys(branches).length
            ? ["", "ブランチ（作業先のリポジトリごと）:", ...Object.entries(branches).map(([name, w]) => `  ${name}  ${w.branch}`)]
            : []),
          "",
          `タスク (${tasks.length}):`,
          table(tasks.map((t) => [`  ${t.id}`, t.status, ...(multi ? [taskRepo(t) ?? "（なし）"] : []), t.title, deps(t)])) || "  （なし）",
        ].join("\n");
      });
    }
    case "set": {
      // 1つ目が要望の参照なら対象、キー=値なら今の要望
      const explicit = rest[0] && !rest[0].includes("=") ? rest.shift() : undefined;
      const rid = requestArg(explicit);
      const patch: Partial<Request> = {};
      for (const pair of rest) {
        const [key, value] = splitPair(pair);
        if (key === "title") patch.title = value;
        else if (key === "areas") patch.areas = list(value);
        else if (key === "tags") patch.tags = list(value);
        else if (key === "due") patch.due = value ? date(value) : undefined;
        else if (key === "milestone") patch.milestone = value || undefined;
        else if (key === "parent") patch.parent = value ? parentArg(value) : undefined;
        else if (key === "status") {
          if (!REQUEST_STATUSES.includes(value as Request["status"])) throw new UsageError(`要望のステータスは ${REQUEST_STATUSES.join(", ")}`);
          patch.status = value as Request["status"];
        } else throw new UsageError("変更できるキー: title status due milestone tags areas parent");
      }
      if (o.body !== undefined) patch.body = readBody(o.body);
      if (o.tag) {
        if (patch.tags) throw new UsageError("tags= と --tag は一緒に使えません（カンマを含む値は --tag で）");
        patch.tags = tagsFrom(o.tag);
      }
      if (!Object.keys(patch).length) throw new UsageError("キー=値 を指定してください");
      const next = await updateRequest(ctx, rid, patch, { expectedRev, actor });
      warn(next.warnings ?? []);
      reopenedNote(undefined, next.reopenedAncestors);
      return out.result(next, () => `更新: ${next.id} (rev ${next.rev})  ${Object.keys(patch).join(", ")}`);
    }
    case "order": {
      // p3 request order <親> <子...>: 直下の子の表示順を保存する（全部の子を並べる）。子を省くと今の並びを出す
      const [head, ...kids] = rest;
      const rid = requestArg(head);
      if (!kids.length) {
        const now = hierarchyNow(ctx.ws).children(rid);
        return out.result({ id: rid, children: now.map((c) => c.id) }, () => (now.length ? now.map((c, i) => `${i + 1}. ${c.id}  ${c.title}`).join("\n") : `${rid} には子の要望がありません`));
      }
      const r = await orderChildren(ctx, rid, kids.map((k) => resolveRequestId(ctx, k) ?? k), { expectedRev, actor });
      const now = hierarchyNow(ctx.ws).children(rid);
      return out.result({ id: r.id, rev: r.rev, children: now.map((c) => c.id) }, () =>
        [`子の表示順を保存しました: ${r.id} (rev ${r.rev})`, ...now.map((c, i) => `  ${i + 1}. ${c.id}  ${c.title}`)].join("\n"),
      );
    }
    case "archive": {
      const rid = requestArg(rest[0]);
      await archiveRequest(ctx, rid);
      return out.result({ archived: rid }, () => `アーカイブ: ${rid}（requests/.archive/ へ）`);
    }
    default:
      throw new UsageError("p3 request [new | ls | show | set | order | archive]");
  }
}

// --- マイルストーン -----------------------------------------------------------

/** マイルストーン（リリース）。複数の要望をまとめる単位で、project.yaml に書く */
const MILESTONE_USAGE =
  "p3 milestone [ls | show <id> | add <id> | set <id> | rm <id> | purpose <id> (--body 本文|- | --file ファイル | --off) | goal add <id> <文> | goal set <id> <G番号> <文> | goal rm <id> <G番号> | review <id> | reviews <id> | review-show <id> <run> | review-cancel <id> <run>]";

/**
 * マイルストーンの操作。保存はロックの中で読んだ最新の並びから作り直す（Workspace.updateMilestones。指定した項目のほかを巻き戻さない）。
 * --version（show --json の milestonesVersion）を付けると、その版から変わっていれば競合（終了コード 3）で何も書かない
 */
export async function milestoneCommand(ctx: P3Context, out: Output, args: string[], o: ReturnType<typeof parse>["values"], actor?: string): Promise<number> {
  const [sub, id] = args;
  if (sub === "review" || sub === "reviews" || sub === "review-show" || sub === "review-cancel") return reviewCommand(ctx, out, args, o, actor);
  const ms = ctx.ws.project.milestones;
  const count = (mid: string) => ctx.ws.requests.list().filter((r) => r.milestone === mid).length;
  const save = { milestonesVersion: o.version };
  /** 最新の並びの中で id のマイルストーンを変える（無ければ使い方の誤り） */
  const change = async (mid: string, fn: (m: Milestone) => Milestone): Promise<Milestone> => {
    const p = await ctx.ws.updateMilestones((cur) => {
      if (!cur.some((m) => m.id === mid)) throw new UsageError(`マイルストーンがありません: ${mid}`);
      return cur.map((m) => (m.id === mid ? fn(m) : m));
    }, save);
    return p.milestones.find((m) => m.id === mid)!;
  };
  const needId = (cmd: string) => {
    if (!id) throw new UsageError(`p3 milestone ${cmd} <id>`);
    return id;
  };
  if (sub === "add" || sub === "set") {
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new UsageError(`p3 milestone ${sub} <id>（英数字と . _ -）`);
    const make = (cur: Milestone | undefined): Milestone => ({
      ...cur,
      id,
      title: o.title ?? cur?.title ?? id,
      due: o.due !== undefined ? (o.due ? date(o.due) : undefined) : cur?.due,
      done: o.done ?? cur?.done,
    });
    let existed = false;
    const p = await ctx.ws.updateMilestones((cur) => {
      const was = cur.find((m) => m.id === id);
      existed = !!was;
      if (sub === "add" && was) throw new UsageError(`既にあります: ${id}（変えるなら p3 milestone set）`);
      if (sub === "set" && !was) throw new UsageError(`マイルストーンがありません: ${id}`);
      return was ? cur.map((m) => (m.id === id ? make(m) : m)) : [...cur, make(undefined)];
    }, save);
    const next = p.milestones.find((m) => m.id === id)!;
    return out.result(next, () => `${existed ? "更新" : "追加"}しました: ${next.title}（${id}${next.due ? ` · ${next.due}` : ""}）`);
  }
  if (sub === "rm" || sub === "remove") {
    if (!id || !ms.some((m) => m.id === id)) throw new UsageError(`マイルストーンがありません: ${id ?? ""}`);
    await checkMilestoneRemoval(ctx, ms.filter((m) => m.id !== id).map((m) => m.id));
    await ctx.ws.updateMilestones((cur) => cur.filter((m) => m.id !== id), save);
    return out.result({ removed: id }, () => `外しました: ${id}`);
  }
  if (sub === "show") {
    const mid = needId("show");
    const m = ms.find((x) => x.id === mid);
    if (!m) throw new UsageError(`マイルストーンがありません: ${mid}`);
    return out.result({ ...m, requests: count(mid), milestonesVersion: ctx.ws.milestonesVersion }, () => formatMilestone(m, count(mid)));
  }
  if (sub === "purpose") {
    const mid = needId("purpose");
    const given = [o.off, o.body !== undefined, o.file !== undefined].filter(Boolean).length;
    if (given !== 1) throw new UsageError(`p3 milestone purpose ${mid} --body 本文|- か --file ファイル か --off（どれか1つ）`);
    const text = o.off ? "" : o.file !== undefined ? await readFile(resolvePath(process.cwd(), o.file), "utf8") : readBody(o.body);
    const m = await change(mid, (x) => ({ ...x, purpose: text }));
    return out.result(m, () => (m.purpose ? `目的を保存しました: ${mid}` : `目的を外しました: ${mid}`));
  }
  if (sub === "goal") {
    const [, op, mid, a, b] = args;
    if (!mid || !["add", "set", "rm", "remove"].includes(op ?? "")) throw new UsageError("p3 milestone goal add <id> <文> | goal set <id> <G番号> <文> | goal rm <id> <G番号>");
    if (op === "add") {
      if (a === undefined) throw new UsageError(`p3 milestone goal add ${mid} <文>`);
      let gid = "";
      const m = await change(mid, (x) => {
        gid = nextGoalId(x.goals ?? []);
        return { ...x, goals: [...(x.goals ?? []), { id: gid, text: a }] };
      });
      return out.result({ ...m, added: gid }, () => `予定機能を追加しました: ${mid} ${gid}`);
    }
    if (!a) throw new UsageError(`p3 milestone goal ${op} ${mid} <G番号>`);
    const exists = (x: Milestone) => {
      if (!(x.goals ?? []).some((g) => g.id === a)) throw new UsageError(`予定機能がありません: ${mid} ${a}`);
    };
    if (op === "set") {
      if (b === undefined) throw new UsageError(`p3 milestone goal set ${mid} ${a} <文>`);
      const m = await change(mid, (x) => (exists(x), { ...x, goals: (x.goals ?? []).map((g) => (g.id === a ? { ...g, text: b } : g)) }));
      return out.result(m, () => `予定機能を更新しました: ${mid} ${a}`);
    }
    const m = await change(mid, (x) => (exists(x), { ...x, goals: (x.goals ?? []).filter((g) => g.id !== a) }));
    return out.result({ ...m, removed: a }, () => `予定機能を外しました: ${mid} ${a}`);
  }
  if (sub && sub !== "ls" && sub !== "list") throw new UsageError(MILESTONE_USAGE);
  const shown = sortMilestones(ms);
  return out.result(
    shown,
    () =>
      table(shown.map((m) => [m.id, m.title, m.due ?? "", m.done ? "済" : "", `要望 ${count(m.id)}`, m.purpose ? "目的あり" : "", m.goals?.length ? `予定機能 ${m.goals.length}` : ""])) ||
      "マイルストーンはありません（p3 milestone add v0.1 --title 最初のリリース --due 2026-11-30）",
  );
}

/** milestone show の人向けの表示 */
function formatMilestone(m: Milestone, requests: number): string {
  const lines = [`${m.id}  ${m.title}${m.due ? `  期限 ${m.due}` : ""}${m.done ? "  リリース済み" : ""}  要望 ${requests}`, "", "目的:"];
  lines.push(m.purpose ? m.purpose.split("\n").map((l) => `  ${l}`).join("\n") : `  （なし。p3 milestone purpose ${m.id} --file 目的.md）`);
  lines.push("", "予定している機能・目標:");
  lines.push(m.goals?.length ? m.goals.map((g) => `  ${g.id}  ${g.text}`).join("\n") : `  （なし。p3 milestone goal add ${m.id} "文"）`);
  return lines.join("\n");
}


// --- マイルストーンレビュー ----------------------------------------------------

/**
 * マイルストーンレビュー（core/milestoneReview。画面と同じ規則）。review は終わるまで待ち、進み具合は stderr に出す（Ctrl-C で取り消す）。
 * 結果は参考の記録で、要望の状態・リリースノート・リリース済みは変えない
 */
async function reviewCommand(ctx: P3Context, out: Output, args: string[], o: ReturnType<typeof parse>["values"], actor?: string): Promise<number> {
  const [sub, mid, run] = args;
  if (!mid) throw new UsageError(`p3 milestone ${sub} <id>${sub === "review-show" || sub === "review-cancel" ? " <run>" : ""}`);
  const svc = ctx.milestoneReview;
  if (sub === "reviews") {
    const items = await svc.list(mid);
    return out.result(items, () =>
      items.length
        ? table(
            items.map((x) =>
              x.state === "broken"
                ? [x.id, "読めない", x.error]
                : [x.run.id, REVIEW_STATUS_LABELS[x.run.status], x.run.startedAt.slice(0, 16).replace("T", " "), verdictSummary(x.verdicts), x.run.error ?? ""],
            ),
          )
        : `レビューの履歴はありません（p3 milestone review ${mid}）`,
    );
  }
  if (sub === "review-show" || sub === "review-cancel") {
    if (!run) throw new UsageError(`p3 milestone ${sub} ${mid} <run>`);
    if (sub === "review-show") {
      const d = await svc.get(mid, run);
      return out.result(d, () => formatReview(d));
    }
    const r = await svc.cancel(mid, run, actor, { acknowledgeStopped: o["acknowledge-stopped"] });
    return out.result(r, () =>
      r.requested
        ? `取消を頼みました: ${mid}/${run}（実行しているプロセスが見つけて止めます）`
        : r.run.abandoned
          ? `中断にしました: ${mid}/${run}（記録の上で終わりにしました。ほかの環境で動いているプロセスを止めたとは限りません）`
          : `終わりにしました: ${mid}/${run}（${REVIEW_STATUS_LABELS[r.run.status]}${r.run.error ? `: ${r.run.error}` : ""}）`,
    );
  }
  if (o.engine !== undefined && o.engine !== "codex" && o.engine !== "mock") throw new UsageError("--engine は codex か mock");
  const started = await svc.start(mid, actor, o.engine);
  process.stderr.write(`レビューを始めました: ${mid}/${started.id}（Ctrl-C で取り消す）\n`);
  let shown = 0;
  const tick = setInterval(() => {
    void svc.get(mid, started.id).then((d) => {
      for (const e of d.run.log.slice(shown)) process.stderr.write(`  ${e.text}\n`);
      shown = Math.max(shown, d.run.log.length);
    }, () => undefined);
  }, 500);
  const onInt = () => void svc.cancel(mid, started.id, actor).catch(() => undefined);
  process.on("SIGINT", onInt);
  const d = await svc.wait(mid, started.id);
  clearInterval(tick);
  process.removeListener("SIGINT", onInt);
  for (const e of d.run.log.slice(shown)) process.stderr.write(`  ${e.text}\n`);
  if (d.run.status !== "completed") {
    if (out.json) out.result(d, () => "");
    else process.stderr.write(`${REVIEW_STATUS_LABELS[d.run.status]}: ${d.run.error ?? ""}\n`);
    return 1;
  }
  return out.result(d, () => formatReview(d));
}

function verdictSummary(v: Partial<Record<ReviewVerdict, number>> | undefined): string {
  if (!v) return "";
  return REVIEW_VERDICTS.filter((k) => v[k]).map((k) => `${REVIEW_VERDICT_LABELS[k]} ${v[k]}`).join(" · ");
}

/** review-show の人向けの表示 */
function formatReview(d: ReviewDetail): string {
  const { run, input, result } = d;
  const lines = [`${run.milestone}/${run.id}  ${REVIEW_STATUS_LABELS[run.status]}  ${run.startedAt}${run.startedBy ? `  ${run.startedBy}` : ""}  (${run.engine})`];
  if (run.error) lines.push(`  ${run.error}`);
  if (d.owner && d.owner.state !== "local" && d.owner.state !== "alive") {
    lines.push(`  実行しているプロセスを確かめられません（${"reason" in d.owner ? d.owner.reason : ""}）。止まっていると確かめたら p3 milestone review-cancel ${run.milestone} ${run.id} --acknowledge-stopped`);
  }
  if (input) {
    lines.push("", "評価したときの目的:", input.milestone.purpose ? input.milestone.purpose.split("\n").map((l) => `  ${l}`).join("\n") : "  （なし）");
    lines.push(`材料: 要望 ${input.requests.length} 件・文脈 ${input.context.length} 件（${input.extractedAt}）`);
    for (const c of input.code ?? []) {
      lines.push(
        c.status === "ok"
          ? `  参照先 ${c.name}: ${c.head ? `${c.branch ? `${c.branch} ` : ""}${c.head.slice(0, 7)}` : "HEAD なし"}${c.dirty ? `・未コミットの変更 ${c.dirty} 件` : ""}・タスクのコミット ${c.commits.filter((x) => x.found).length} 件`
          : `  参照先 ${c.name}: 読めません（${c.reason ?? c.status}）`,
      );
      for (const x of c.commits) lines.push(`    ${x.sha.slice(0, 12)}  ${x.from}${x.found ? "" : "  （履歴に無い）"}`);
    }
    for (const w of input.warnings) lines.push(`  ⚠ ${w.message}`);
  }
  if (result) {
    const text = new Map(input?.units.map((u) => [u.id, u.text]));
    lines.push("", "全体の所見:", ...result.overall.split("\n").map((l) => `  ${l}`), "");
    for (const u of result.units) {
      lines.push(`■ ${u.unit}  ${REVIEW_VERDICT_LABELS[u.verdict]}  ${(text.get(u.unit) ?? "").split("\n")[0]}`);
      lines.push(`  理由: ${u.reason}`);
      if (u.evidence.length) lines.push(`  根拠: ${u.evidence.join(", ")}`);
      for (const g of u.gaps) lines.push(`  不足: ${g}`);
    }
    if (result.unplanned) {
      lines.push("", "目的・予定機能に無い変更（意図しない変更の候補）:");
      if (!result.unplanned.length) lines.push("  （見つかっていません）");
      for (const u of result.unplanned) lines.push(`  - ${u.text}${u.evidence.length ? `（根拠: ${u.evidence.join(", ")}）` : ""}`);
    }
    lines.push("", `範囲: ${result.scope}`);
  }
  return lines.join("\n");
}
