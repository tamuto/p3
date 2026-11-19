import { daysUntil, localToday } from "../shared/dates.ts";
import { openProject } from "../core/context.ts";
import { progress, resolveRef, resolveRequestId, titleOf } from "../core/ops.ts";
import { requirementCommand } from "./requirementCommands.ts";
import { revisitCommand } from "./revisitCommands.ts";
import { retroCommand } from "./retroCommands.ts";
import { metricsCommand } from "./metricsCommands.ts";
import type { RequestProgress } from "../shared/types.ts";
import { taskReviewCommand } from "./taskReviewCommands.ts";
import { qualityCommand } from "./qualityCommands.ts";
import { NotFoundError } from "../core/store/collection.ts";
import { VIA_LABEL } from "../core/store/locate.ts";
import { table } from "./format.ts";
import { cliExit } from "../core/errorOutcome.ts";
import { config, currentRequest, locateHere, repoCommand, resolveActor, runnerText } from "./projectSettings.ts";
import { UsageError } from "@infodb/p3-kit/usage.ts";
import { sortMilestones } from "../shared/milestoneOrder.ts";
import { runnerView } from "../shared/preflightRunner.ts";
import type { CommandEnv } from "./args.ts";
import { Output, bar } from "./output.ts";
import { requestCommand, milestoneCommand } from "./requestCommands.ts";
import { taskCommand } from "./taskCommands.ts";
import { preflightCommand } from "./preflightCommands.ts";
import { releaseNotesCommand } from "./releaseNotesCommands.ts";
import type { ResolvedProject } from "../core/store/locate.ts";
import type { MachineSettings } from "../core/machineSettings.ts";

/**
 * tasks の CLI: プロジェクトを開いた後のコマンドの振り分け（要望・タスク・Preflight・レビュー・品質・マイルストーン・リリースノート・
 * 振り返り・指標・設定・参照先）と、エラーから終了コードへの対応。引数の解釈・プロジェクトの決定・登録が1つだけのときの抑止・serve・
 * help・guide・init・join・agents は入口（main.ts）が受け持ち、ここを呼ぶ
 */

/** 進捗の行の見直し候補の印（要望自身・自分のタスク・配下を分ける。無ければ空） */
function reviewMark(p: RequestProgress): string {
  const r = p.review;
  if (!r) return "";
  const parts = [r.self?.state === "candidate" ? "要望" : "", r.tasks ? `タスク ${r.tasks}` : "", r.below ? `配下 ${r.below}` : ""].filter(Boolean);
  return parts.length ? `  ※見直し候補（${parts.join("・")}）` : "";
}

/** 入口から渡すもの（tasks からは入口を読み込まない） */
export interface TasksRun {
  cmd: string;
  args: string[];
  o: CommandEnv["o"];
  cwd: string;
  out: Output;
  target: ResolvedProject;
  settings: MachineSettings;
  /** 置いた AI 向けの入口の状態（whoami。入口が診断する） */
  agents: () => { status: unknown; lines: string[] };
}

/** 決まったプロジェクトで tasks のコマンドを動かす（知らないコマンドは使い方の誤り） */
export async function runTasksCommand(r: TasksRun): Promise<number> {
  const { cmd, args, o, cwd, out, target, settings } = r;
  const ctx = await openProject(target.dataDir, { repos: target.repos, settings, projectName: target.name });
  const actor = resolveActor(o.actor ?? process.env.P3_ACTOR, cwd);
  const current = currentRequest(ctx, o.req ?? o.request ?? process.env.P3_REQUEST, cwd);
  const expectedRev = o.rev !== undefined ? Number(o.rev) : undefined;

  /** 要望の引数（省略時は今の要望） */
  const requestArg = (raw: string | undefined): string => {
    if (raw) {
      const id = resolveRequestId(ctx, raw);
      if (!id) throw new NotFoundError(raw);
      return id;
    }
    if (!current) throw new UsageError("要望を指定してください（引数か --req。要望の作業ツリーの中なら省略可）");
    return current;
  };
  /** タスクの引数（T003 は今の要望の中） */
  const taskArg = (raw: string | undefined): string => {
    if (!raw) throw new UsageError("タスクを指定してください（T003 / <要望>/T003）");
    const ref = resolveRef(ctx, raw, current);
    if (ref?.includes("/")) return ref;
    if (!ref && !raw.includes("/") && !current) throw new UsageError(`${raw}: 要望を --req で指定してください`);
    throw new NotFoundError(raw);
  };
  const split = (ref: string) => {
    const [rid, tid] = ref.split("/");
    return { col: ctx.ws.tasksOf(rid), rid, tid };
  };

  const env: CommandEnv = { ctx, out, args, o, actor, current, expectedRev, requestArg, taskArg, split, cwd, target };
  const handled = (await taskCommand(cmd, env)) ?? (await taskReviewCommand(cmd, env)) ?? (await preflightCommand(cmd, env)) ?? (await requirementCommand(cmd, env)) ?? (await revisitCommand(cmd, env)) ?? (await retroCommand(cmd, env)) ?? (await metricsCommand(cmd, env));
  if (handled !== undefined) return handled;

  switch (cmd) {
    case "config": {
      const r = await config(ctx.ws, args);
      return out.result(r.data, () => r.text);
    }

    case "repo": {
      const r = await repoCommand(ctx.ws, target.name, cwd, args, { local: o.local });
      return out.result(r.data, () => r.text);
    }

    case "whoami": {
      const here = locateHere(ctx, cwd);
      // Preflight の担当（AI 向けの手順が読む。読めなければ runner: null と problem。agent と推測しない）
      const pf = runnerView(ctx.ws.project.preflight);
      const preflight = { runner: pf.runner, source: pf.source, ...(pf.problem ? { problem: pf.problem } : {}) };
      // 置いた AI 向けの入口の状態（読むだけ。古くても操作は断らない）
      const { status: agents, lines: agentLines } = r.agents();
      return out.result({ project: target.name ?? null, dataDir: target.dataDir, via: target.via, here: here.repos, branch: here.branch ?? null, actor, request: current ?? null, preflight, agents }, () =>
        [
          `プロジェクト  ${target.name ?? "（未登録）"}  ${target.dataDir}`,
          `決まり方      ${target.via}（${VIA_LABEL[target.via]}）`,
          `今いる参照先  ${here.repos.length ? here.repos.join(", ") : "（どの参照先の中でもない。p3 repo ls）"}${here.branch ? `  ブランチ ${here.branch}` : ""}`,
          `変更者        ${actor}`,
          `要望          ${current ? `${current}  ${titleOf(ctx, current)}` : "（なし）"}`,
          `Preflight     ${runnerText(pf)}`,
          ...agentLines.map((l, i) => (i ? `              ${l}` : `AI の入口     ${l}`)),
        ].join("\n"),
      );
    }

    case "progress": {
      const ps = progress(ctx).filter((p) => o.all || !["done", "rejected"].includes(p.request.status));
      const today = localToday();
      return out.result(ps, () => {
        const groups = [
          ...sortMilestones(ctx.ws.project.milestones).map((m) => ({ m, ps: ps.filter((p) => p.request.milestone === m.id) })),
          { m: undefined, ps: ps.filter((p) => !p.request.milestone) },
        ];
        return (
          groups
            .filter((g) => g.ps.length)
            .map((g) => {
              const done = g.ps.reduce((n, p) => n + p.done, 0);
              const total = g.ps.reduce((n, p) => n + p.total, 0);
              const head = g.m
                ? `■ ${g.m.title}（${g.m.id}${g.m.due ? ` · ${g.m.due}` : ""}${g.m.done ? " · リリース済み" : ""}）  タスク ${done}/${total}`
                : "■ マイルストーンなし";
              const rows = g.ps.map((p) => [
                `  ${p.request.id}`,
                p.request.status,
                `${bar(p.total ? p.done / p.total : 0)} ${p.done}/${p.total}`,
                p.request.due
                  ? `${p.request.due}${daysUntil(p.request.due, today) < 0 && !["done", "rejected"].includes(p.request.status) ? " 超過" : ""}`
                  : "",
                p.request.tags.map((t) => `#${t}`).join(" "),
                // 子のある要望は配下の集計（自分の値とは別）、子は親を添える
                `${p.request.title}${p.blocked ? `  ⏸停止 ${p.blocked}` : ""}${p.children.length ? `  [配下 ${p.subtree.done}/${p.subtree.total}・子 ${p.children.length}${p.subtree.blocked > p.blocked ? `・配下の停止 ${p.subtree.blocked - p.blocked}` : ""}]` : ""}${p.request.parent ? `  ↑${p.request.parent}` : ""}${p.hierarchyIssues.length ? "  ※親子の問題" : ""}${reviewMark(p)}`,
              ]);
              return `${head}\n${table(rows)}`;
            })
            .join("\n\n") || "要望はありません"
        );
      });
    }

    case "quality":
      return qualityCommand(env);

    case "milestone":
    case "milestones":
      return milestoneCommand(ctx, out, args, o, actor);

    case "release-notes":
    case "release-note":
      return releaseNotesCommand(env);

    // --- 要望 ---------------------------------------------------------------
    case "request":
    case "req":
      return requestCommand(ctx, out, args, o, actor, requestArg, expectedRev);

    default:
      throw new UsageError(`不明なコマンド: ${cmd}（p3 help）`);
  }
}

/** エラーを標準エラーに出し、終了コードを返す（競合 3・見つからない 2・ほか 1。対応の表は core/errorOutcome.ts） */
export const reportError = (e: unknown): number => cliExit(e, (t) => process.stderr.write(t));
