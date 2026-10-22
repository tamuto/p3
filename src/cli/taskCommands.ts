import { relative } from "node:path";
import type { Task } from "../shared/types.ts";
import { listTasks, resolve, resolveRef } from "../core/ops.ts";
import { archiveTask, createTask, updateTask } from "../core/requestOps.ts";
import { supersededMarks } from "../core/supersede.ts";
import { table } from "./format.ts";
import { taskRepo } from "../shared/workTarget.ts";
import { addRepoOutputs, parseRepoOutput, repoArg } from "../core/workTargets.ts";
import { briefTask, formatBriefTask, taskExtras } from "./showView.ts";
import { UsageError } from "./project.ts";
import { parseTaskAssignments, checkStatus, readBody, type CommandEnv } from "./args.ts";
import { dependentsOf, formatEntity, ambiguous, replacedBy, reopenedNote, warn, deps, workHint } from "./output.ts";
import { requestCommand } from "./requestCommands.ts";

/** タスクのコマンド（ls / show / find / impact / new / set / move / check / link / unlink / archive）。変更は server/requestOps.ts を通す。扱わないコマンドは undefined */

const RECORD_REQUIRED =
  "AI が完了にするときは --record で変更の記録を残してください（何を変えたか・なぜ・入れた決まり・やめたもの。Markdown。- で標準入力）\n" +
  "  例: p3 move T003 done --output <成果物（変えたファイルや説明。URL は後から足せます）> --record - < record.md";

export async function taskCommand(cmd: string, env: CommandEnv): Promise<number | undefined> {
  const { ctx, out, args, o, actor, current, expectedRev, requestArg, taskArg, split, cwd } = env;
  switch (cmd) {
    // --- タスク -------------------------------------------------------------
    case "ls":
    case "list": {
      if (o.repo !== undefined && o.repo !== "none" && !ctx.ws.project.repos.some((r) => r.name === o.repo)) {
        throw new UsageError(`参照先「${o.repo}」は登録されていません（p3 repo ls）`);
      }
      const filter = { status: o.status?.split(","), area: o.area?.[0], q: o.q, repo: o.repo };
      const tasks = listTasks(ctx, { ...filter, request: o.all ? undefined : requestArg(undefined) });
      const marks = supersededMarks(ctx.ws);
      const items = tasks.map((t) => (marks.has(t.ref) ? { ...t, superseded: marks.get(t.ref) } : t));
      // 共有の参照先があるときは作業先の列を出す
      const multi = ctx.ws.project.repos.length > 0;
      return out.result(items, () =>
        table(
          tasks.map((t) => [
            o.all ? t.ref : t.id,
            t.status,
            ...(multi ? [taskRepo(t) ?? "（なし）"] : []),
            t.title,
            [deps(t), replacedBy(t, marks)].filter(Boolean).join("  "),
          ]),
        ) || "タスクはありません",
      );
    }

    case "show": {
      const query = args.join(" ");
      const ref = resolveRef(ctx, query, current) ?? resolve(ctx, query, current).match;
      if (!ref) return ambiguous(out, ctx, query, current);
      if (!ref.includes("/")) return requestCommand(ctx, out, ["show", ref], o, actor, requestArg, expectedRev);
      const item = ctx.ws.requireTask(ref);
      const marks = supersededMarks(ctx.ws);
      if (o.brief) {
        const view = briefTask(ctx, item, marks);
        return out.result(view, () => formatBriefTask(view));
      }
      const file = relative(cwd, split(ref).col.path(item.id));
      const { superseded, dependencies, warnings } = taskExtras(ctx, item, marks);
      const dependents = dependentsOf(ctx, item).map((t) => ({ ref: t.ref, title: t.title, status: t.status }));
      return out.result({ item, file, superseded, dependencies, dependents, warnings }, () =>
        [superseded.length ? `※ 置き換えられています: ${superseded.map((m) => `${m.from}${m.note ? `（${m.note}）` : ""}`).join(" / ")}\n` : "", formatEntity(ctx, item, file)].join(""),
      );
    }

    case "find":
    case "resolve": {
      const r = resolve(ctx, args.join(" "), current);
      return out.result(r, () => table(r.candidates.map((c) => [c.ref, c.score.toFixed(2), c.title, c.reasons.join(" / ")])) || "見つかりません");
    }

    case "new":
    case "add": {
      // 互換: new task <タイトル> / new request <タイトル>
      if (args[0] === "request" || args[0] === "req") return requestCommand(ctx, out, ["new", ...args.slice(1)], o, actor, requestArg, expectedRev);
      const title = (args[0] === "task" ? args.slice(1) : args).join(" ").trim();
      if (!title) throw new UsageError("タイトルを指定してください");
      const rid = requestArg(undefined);
      const status = o.status ?? "todo";
      checkStatus(status);
      // 作業先（--repo <名前>|none）。作業先にできるものだけ。書く前に確かめる
      const repo = repoArg(o.repo);
      const repoOutputs = (o["repo-output"] ?? []).map((x) => parseRepoOutput(ctx.ws, x));
      const r = await createTask(
        ctx,
        rid,
        {
          title,
          status,
          ...(repo !== undefined ? { repo } : {}),
          labels: o.label ?? [],
          areas: o.area ?? [],
          outputs: o.output ?? [],
          ...(repoOutputs.length ? { repoOutputs: addRepoOutputs([], repoOutputs) } : {}),
          body: readBody(o.body),
        },
        actor,
      );
      const t = r.task;
      warn(r.warnings);
      const reopened = reopenedNote(r.reopened, r.reopenedAncestors);
      return out.result({ ...t, ...(reopened ? { reopened } : {}), ...(r.reopenedAncestors ? { reopenedAncestors: r.reopenedAncestors } : {}), ...(r.warnings.length ? { warnings: r.warnings } : {}) }, () => [`作成: ${t.ref}  ${t.title}`, workHint(ctx, t)].filter(Boolean).join("\n"));
    }

    case "set": {
      const ref = taskArg(args[0]);
      const patch = parseTaskAssignments(args.slice(1));
      if (o.body !== undefined) patch.body = readBody(o.body);
      if (o.record !== undefined) patch.record = readBody(o.record).trim() || undefined;
      const { col, tid } = split(ref);
      if (patch.status === "done" && actor.startsWith("ai:") && !patch.record && !col.require(tid).record) throw new UsageError(RECORD_REQUIRED);
      if (o["repo-output"]?.length) {
        const add = o["repo-output"].map((x) => parseRepoOutput(ctx.ws, x));
        patch.repoOutputs = addRepoOutputs(patch.repoOutputs ?? col.require(tid).repoOutputs ?? [], add);
      }
      if (!Object.keys(patch).length) throw new UsageError("キー=値 を指定してください");
      const r = await updateTask(ctx, ref.split("/")[0], tid, patch, { expectedRev, actor });
      const { task: next, warnings } = r;
      warn(warnings);
      const reopened = reopenedNote(r.reopened, r.reopenedAncestors);
      return out.result({ ...next, ...(warnings.length ? { warnings } : {}), ...(reopened ? { reopened } : {}), ...(r.reopenedAncestors ? { reopenedAncestors: r.reopenedAncestors } : {}) }, () =>
        [`更新: ${next.ref} (rev ${next.rev})  ${Object.keys(patch).join(", ")}`, "repo" in patch ? workHint(ctx, next) : ""].filter(Boolean).join("\n"),
      );
    }

    case "move": {
      const ref = taskArg(args[0]);
      const status = args[1];
      if (!status) throw new UsageError("移動先のステータスを指定してください");
      checkStatus(status);
      const { col, tid } = split(ref);
      const cur = col.require(tid);
      const patch: Partial<Task> = { status };
      if (o.record !== undefined) patch.record = readBody(o.record).trim() || undefined;
      // AI が完了にするときは変更の記録を残す（後の Preflight・タスク解析・リリースノートが読む）
      if (status === "done" && actor.startsWith("ai:") && !patch.record && !cur.record) throw new UsageError(RECORD_REQUIRED);
      if (o.output?.length) patch.outputs = [...new Set([...cur.outputs, ...o.output])];
      // リポジトリごとの成果物（最後のタスクに、関係するリポジトリの PR を全部残せる）
      if (o["repo-output"]?.length) patch.repoOutputs = addRepoOutputs(cur.repoOutputs ?? [], o["repo-output"].map((x) => parseRepoOutput(ctx.ws, x)));
      const r = await updateTask(ctx, cur.request, tid, patch, { expectedRev, actor });
      const { task: next, warnings } = r;
      warn(warnings);
      const reopened = reopenedNote(r.reopened, r.reopenedAncestors);
      return out.result({ ...next, ...(warnings.length ? { warnings } : {}), ...(reopened ? { reopened } : {}), ...(r.reopenedAncestors ? { reopenedAncestors: r.reopenedAncestors } : {}) }, () =>
        `${next.ref} → ${status}${[...(o.output ?? []), ...(o["repo-output"] ?? [])].length ? `  (${[...(o.output ?? []), ...(o["repo-output"] ?? [])].join(", ")})` : ""}`,
      );
    }

    case "check": {
      const ref = taskArg(args[0]);
      const { tid } = split(ref);
      const { task: next } = await updateTask(ctx, ref.split("/")[0], tid, { checked: !o.off }, { expectedRev, actor });
      return out.result(next, () => `${next.ref} ${o.off ? "の済みを外しました" : "を済みにしました"}`);
    }

    case "archive": {
      const ref = taskArg(args[0]);
      const { tid } = split(ref);
      await archiveTask(ctx, ref.split("/")[0], tid);
      return out.result({ archived: ref }, () => `アーカイブ: ${ref}`);
    }

  }
  return undefined;
}

