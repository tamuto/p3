import { basename, relative } from "node:path";
import { REQUEST_STATUSES, type Request, type Attachment } from "../shared/types.ts";
import { type P3Context } from "../core/context.ts";
import { archiveRequest, checkMilestone, checkMilestoneRemoval, createRequest, updateRequest } from "../core/requestOps.ts";
import { resolvedIssue } from "../core/requestStatus.ts";
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
      const reqs = ctx.ws.requests
        .list()
        .filter((r) => !status || status.includes(r.status))
        .filter((r) => !o.milestone || r.milestone === o.milestone)
        .filter((r) => !o.tag?.length || o.tag.some((t) => r.tags.includes(t)))
        // --parent: 直下の子だけ
        .filter((r) => o.parent === undefined || r.parent === parentArg(o.parent));
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
    case "archive": {
      const rid = requestArg(rest[0]);
      await archiveRequest(ctx, rid);
      return out.result({ archived: rid }, () => `アーカイブ: ${rid}（requests/.archive/ へ）`);
    }
    default:
      throw new UsageError("p3 request [new | ls | show | set | archive]");
  }
}

// --- マイルストーン -----------------------------------------------------------

/** マイルストーン（リリース）。複数の要望をまとめる単位で、project.yaml に書く */
export async function milestoneCommand(ctx: P3Context, out: Output, args: string[], o: ReturnType<typeof parse>["values"]): Promise<number> {
  const [sub, id] = args;
  const ms = ctx.ws.project.milestones;
  const count = (mid: string) => ctx.ws.requests.list().filter((r) => r.milestone === mid).length;
  if (sub === "add" || sub === "set") {
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new UsageError(`p3 milestone ${sub} <id>（英数字と . _ -）`);
    const cur = ms.find((m) => m.id === id);
    if (sub === "add" && cur) throw new UsageError(`既にあります: ${id}（変えるなら p3 milestone set）`);
    if (sub === "set" && !cur) throw new UsageError(`マイルストーンがありません: ${id}`);
    const next = {
      id,
      title: o.title ?? cur?.title ?? id,
      due: o.due !== undefined ? (o.due ? date(o.due) : undefined) : cur?.due,
      done: o.done ?? cur?.done,
    };
    await ctx.ws.saveProject({ milestones: cur ? ms.map((m) => (m.id === id ? next : m)) : [...ms, next] });
    return out.result(next, () => `${cur ? "更新" : "追加"}しました: ${next.title}（${id}${next.due ? ` · ${next.due}` : ""}）`);
  }
  if (sub === "rm" || sub === "remove") {
    if (!id || !ms.some((m) => m.id === id)) throw new UsageError(`マイルストーンがありません: ${id ?? ""}`);
    await checkMilestoneRemoval(ctx, ms.filter((m) => m.id !== id).map((m) => m.id));
    await ctx.ws.saveProject({ milestones: ms.filter((m) => m.id !== id) });
    return out.result({ removed: id }, () => `外しました: ${id}`);
  }
  if (sub && sub !== "ls" && sub !== "list") throw new UsageError("p3 milestone [ls | add <id> | set <id> | rm <id>]");
  const shown = sortMilestones(ms);
  return out.result(
    shown,
    () =>
      table(shown.map((m) => [m.id, m.title, m.due ?? "", m.done ? "済" : "", `要望 ${count(m.id)}`])) ||
      "マイルストーンはありません（p3 milestone add v0.1 --title 最初のリリース --due 2026-11-30）",
  );
}

