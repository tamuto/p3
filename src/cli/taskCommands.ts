import { readFileSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { relationRole, type ArchivedTask, type ProposedTask, type Task } from "../shared/types.ts";
import { normalizeTaskId } from "../shared/refs.ts";
import { getArchivedTask, listArchivedTasks } from "../core/store/archivedTasks.ts";
import { listTasks, resolve, resolveRef, resolveRequestId } from "../core/ops.ts";
import { archiveTask, createTask, updateTask } from "../core/requestOps.ts";
import { supersededMarks } from "../core/supersede.ts";
import { table } from "./format.ts";
import { taskRepo } from "../shared/workTarget.ts";
import { addRepoOutputs, parseRepoOutput, repoArg } from "../core/workTargets.ts";
import { briefTask, formatAcceptance, formatBlock, formatBriefTask, taskExtras } from "./showView.ts";
import { UsageError } from "./project.ts";
import { NotFoundError } from "../core/store/collection.ts";
import { parseTaskAssignments, checkStatus, evidenceOps, readBody, type CommandEnv } from "./args.ts";
import { ACCEPTANCE_RESULTS, acceptanceStatus, applyAcceptanceOps, isAcceptanceResult, type AcceptanceOp } from "../shared/acceptance.ts";
import type { BlockOp } from "../shared/taskBlock.ts";
import { dependentsOf, formatEntity, indent, ambiguous, replacedBy, reopenedNote, warn, deps, workHint } from "./output.ts";
import { requestCommand } from "./requestCommands.ts";
import { pickRun } from "./preflightCommands.ts";

/** タスクのコマンド（ls / show / find / impact / new / set / move / check / criteria / evidence / archive）。変更は server/requestOps.ts を通す。扱わないコマンドは undefined */

const RECORD_REQUIRED =
  "AI が完了にするときは --record で変更の記録を残してください（何を変えたか・なぜ・入れた決まり・やめたもの。Markdown。- で標準入力）\n" +
  "  例: p3 move T003 done --output <成果物（変えたファイルや説明。URL は後から足せます）> --record - < record.md";

export async function taskCommand(cmd: string, env: CommandEnv): Promise<number | undefined> {
  const { ctx, out, args, o, actor, current, expectedRev, requestArg, taskArg, split, cwd } = env;
  switch (cmd) {
    // --- タスク -------------------------------------------------------------
    case "ls":
    case "list": {
      if (o.archived) return listArchived(env);
      if (o.repo !== undefined && o.repo !== "none" && !ctx.ws.project.repos.some((r) => r.name === o.repo)) {
        throw new UsageError(`参照先「${o.repo}」は登録されていません（p3 repo ls）`);
      }
      const filter = { status: o.status?.split(","), area: o.area?.[0], q: o.q, repo: o.repo, blocked: o.blocked };
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
            [t.block ? `⏸停止 ${t.block.since.slice(0, 10)}: ${t.block.reason.split("\n")[0]}` : "", deps(t), replacedBy(t, marks)].filter(Boolean).join("  "),
          ]),
        ) || (o.blocked ? "止まっているタスクはありません" : "タスクはありません"),
      );
    }

    case "show": {
      if (o.archived) return showArchived(env);
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
      const acceptance = acceptanceStatus(item) ?? null;
      return out.result({ item, file, superseded, dependencies, dependents, warnings, acceptance }, () =>
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
          ...(o.criterion?.length ? { criteria: o.criterion } : {}),
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
      // 受け入れ基準を足す（--criterion）・証拠を残す（--evidence / --evidence-file）
      const acceptance: AcceptanceOp[] = [...(o.criterion ?? []).map((text): AcceptanceOp => ({ op: "add", text })), ...evidenceOps(o)];
      if (!Object.keys(patch).length && !acceptance.length) throw new UsageError("キー=値 を指定してください（受け入れ基準は --criterion、証拠は --evidence / --evidence-file）");
      const r = await updateTask(ctx, ref.split("/")[0], tid, { ...patch, ...(acceptance.length ? { acceptance } : {}) }, { expectedRev, actor });
      const { task: next, warnings } = r;
      warn(warnings);
      checkClearedNote(r.checkCleared);
      const reopened = reopenedNote(r.reopened, r.reopenedAncestors);
      const keys = [...Object.keys(patch), ...(acceptance.length ? ["acceptance"] : [])];
      return out.result({ ...next, ...(warnings.length ? { warnings } : {}), ...(reopened ? { reopened } : {}), ...(r.reopenedAncestors ? { reopenedAncestors: r.reopenedAncestors } : {}), ...(r.checkCleared ? { checkCleared: r.checkCleared } : {}) }, () =>
        [`更新: ${next.ref} (rev ${next.rev})  ${keys.join(", ")}`, "repo" in patch ? workHint(ctx, next) : ""].filter(Boolean).join("\n"),
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
      // 完了と同時に項目ごとの証拠を残す（--evidence / --evidence-file。不足があっても完了は拒まない）
      const acceptance = evidenceOps(o);
      const r = await updateTask(ctx, cur.request, tid, { ...patch, ...(acceptance.length ? { acceptance } : {}) }, { expectedRev, actor });
      const { task: next, warnings } = r;
      warn(warnings);
      checkClearedNote(r.checkCleared);
      const reopened = reopenedNote(r.reopened, r.reopenedAncestors);
      const short = status === "done" ? acceptanceStatus(next)?.shortfalls : undefined;
      if (short?.length) process.stderr.write(`受け入れ基準の不足（完了はしました。人が確かめます）: ${short.join(" / ")}\n`);
      return out.result({ ...next, ...(warnings.length ? { warnings } : {}), ...(reopened ? { reopened } : {}), ...(r.reopenedAncestors ? { reopenedAncestors: r.reopenedAncestors } : {}), ...(r.checkCleared ? { checkCleared: r.checkCleared } : {}) }, () =>
        `${next.ref} → ${status}${[...(o.output ?? []), ...(o["repo-output"] ?? [])].length ? `  (${[...(o.output ?? []), ...(o["repo-output"] ?? [])].join(", ")})` : ""}`,
      );
    }

    case "check": {
      const ref = taskArg(args[0]);
      const { tid } = split(ref);
      const { task: next } = await updateTask(ctx, ref.split("/")[0], tid, { checked: !o.off }, { expectedRev, actor });
      return out.result(next, () => `${next.ref} ${o.off ? "の済みを外しました" : "を済みにしました"}`);
    }

    case "block":
    case "unblock":
      return blockCommand(cmd, env);

    case "criteria":
      return criteriaCommand(env);

    case "evidence":
      return evidenceCommand(env);

    case "archive": {
      const ref = taskArg(args[0]);
      const { tid } = split(ref);
      await archiveTask(ctx, ref.split("/")[0], tid);
      return out.result({ archived: ref }, () => `アーカイブ: ${ref}`);
    }

  }
  return undefined;
}

// --- 止まっている理由（停止） ---------------------------------------------------------

/**
 * block <T> --reason 理由|- [--decision 決めてほしいこと|-]   作業中のタスクに停止を付ける・内容を直す（止まった時刻は変えない）
 * unblock <T> --resolution 回答・解決の内容|-                 解除する（状態は変えない。自動では再開しない）
 * - は標準入力（どれか1つだけ）
 */
async function blockCommand(cmd: "block" | "unblock", { ctx, out, args, o, actor, expectedRev, taskArg, split }: CommandEnv): Promise<number> {
  const ref = taskArg(args[0]);
  const stdin = [o.reason, o.decision, o.resolution].filter((v) => v === "-").length;
  if (stdin > 1) throw new UsageError("標準入力（-）は --reason / --decision / --resolution のどれか1つだけに使えます");
  let op: BlockOp;
  if (cmd === "block") {
    if (o.reason === undefined) throw new UsageError(`使い方: p3 block ${args[0] ?? "<T>"} --reason "止まっている理由" [--decision "決めてほしいこと"]`);
    op = { op: "set", reason: readBody(o.reason), ...(o.decision !== undefined ? { decision: readBody(o.decision) } : {}) };
  } else {
    if (o.resolution === undefined) throw new UsageError(`使い方: p3 unblock ${args[0] ?? "<T>"} --resolution "回答・解決の内容"`);
    op = { op: "clear", resolution: readBody(o.resolution) };
  }
  const { tid } = split(ref);
  const before = ctx.ws.requireTask(ref);
  const r = await updateTask(ctx, ref.split("/")[0], tid, { blockOp: op }, { expectedRev, actor });
  const t = r.task;
  const changed = t.rev !== before.rev;
  return out.result({ ...t, changed }, () =>
    !changed
      ? cmd === "block"
        ? `${t.ref} は同じ内容で止まっています（変えていません）`
        : `${t.ref} は止まっていません（変えていません）`
      : t.block
        ? `${t.ref} を止めました（${t.block.since} から）: ${t.block.reason}${t.block.decision ? `\n  決めてほしいこと: ${t.block.decision}` : ""}`
        : `${t.ref} の停止を解除しました（状態は ${t.status} のまま。自動では再開しません）`,
  );
}

// --- 受け入れ基準と証拠 -------------------------------------------------------------

function checkClearedNote(msg: string | undefined) {
  if (msg) process.stderr.write(`${msg}\n`);
}

/** 基準・証拠の操作を当てて、今の基準と不足を出す */
async function applyAcceptance({ ctx, out, actor, expectedRev, split }: CommandEnv, ref: string, acceptance: AcceptanceOp[]): Promise<number> {
  const { tid } = split(ref);
  const r = await updateTask(ctx, ref.split("/")[0], tid, { acceptance }, { expectedRev, actor });
  checkClearedNote(r.checkCleared);
  const acc = acceptanceStatus(r.task);
  return out.result({ ...r.task, acceptance: acc ?? null, ...(r.checkCleared ? { checkCleared: r.checkCleared } : {}) }, () =>
    [`更新: ${r.task.ref} (rev ${r.task.rev})`, ...formatAcceptance(r.task)].join("\n"),
  );
}

/**
 * criteria <タスク>                     基準と証拠・不足を出す
 * criteria <タスク> add <文> [<文> ...]  足す（ID は A1, A2, ... を振る）
 * criteria <タスク> edit <ID> <文>       文を変える（記録済みの証拠は再確認が必要になる）
 * criteria <タスク> rm <ID> [...]        消す（証拠は対応する基準のない証拠として残る）
 * criteria <タスク> order <ID> ...       並べ替える（今の ID を全部）
 */
async function criteriaCommand(env: CommandEnv): Promise<number> {
  const { ctx, out, args, taskArg } = env;
  // タスク案（D1。--run で run、省くと最新）の基準はタスク化の前に直す
  const draft = /^(?:([^/]+)\/)?(D\d+)$/i.exec(args[0] ?? "");
  if (draft) return draftCriteriaCommand(env, draft[1], draft[2].toUpperCase());
  const ref = taskArg(args[0]);
  const [sub, ...rest] = args.slice(1);
  if (sub === undefined || sub === "ls" || sub === "show") {
    const task = ctx.ws.requireTask(ref);
    const acc = acceptanceStatus(task);
    return out.result({ ref: task.ref, rev: task.rev, criteria: task.acceptanceCriteria ?? [], evidence: task.acceptanceEvidence ?? [], acceptance: acc ?? null }, () => formatAcceptance(task).join("\n"));
  }
  const need = (n: number, usage: string) => {
    if (rest.length < n) throw new UsageError(`使い方: p3 criteria <タスク> ${usage}`);
  };
  switch (sub) {
    case "add":
      need(1, "add <文> [<文> ...]");
      return applyAcceptance(env, ref, rest.map((text) => ({ op: "add", text })));
    case "edit":
    case "set":
      need(2, "edit <ID> <文>");
      return applyAcceptance(env, ref, [{ op: "edit", id: rest[0], text: rest.slice(1).join(" ") }]);
    case "rm":
    case "remove":
      need(1, "rm <ID> [<ID> ...]");
      return applyAcceptance(env, ref, rest.map((id) => ({ op: "remove", id })));
    case "order":
      need(1, "order <ID> <ID> ...（今の ID を全部）");
      return applyAcceptance(env, ref, [{ op: "order", ids: rest }]);
  }
  throw new UsageError(`criteria の操作は add / edit / rm / order です: ${sub}`);
}

/**
 * criteria <D1> [add|edit|rm|order] --req <要望> [--run <run>]: タスク案の基準（タスク化すると ID ごとタスクに写る）。
 * 案のファイルを読み直し、読んだときの基準と比べてから書く（他で変わっていれば競合）。読めなかった項目は、直すと消える
 */
async function draftCriteriaCommand({ ctx, out, args, o, requestArg }: CommandEnv, head: string | undefined, key: string): Promise<number> {
  const rid = head ? resolveRequestId(ctx, head) : requestArg(undefined);
  if (!rid) throw new NotFoundError(head ?? "要望");
  const run = await pickRun(ctx, rid, o.run);
  const d = run.drafts.find((x) => x.key === key);
  if (!d) throw new NotFoundError(`${run.id}/${key}`);
  const [sub, ...rest] = args.slice(1);
  const show = (x: ProposedTask) =>
    [
      `${rid} / ${run.id} / ${x.key}  ${x.title}`,
      ...(x.acceptanceCriteria?.length ? x.acceptanceCriteria.map((c) => `  ${c.id}  ${c.text}`) : ["  受け入れ基準なし"]),
      ...(x.acceptanceProblems ?? []).map((p) => `  ※読めない: ${p}（直すと消えます）`),
    ].join("\n");
  if (sub === undefined || sub === "ls" || sub === "show") return out.result({ request: rid, run: run.id, key, criteria: d.acceptanceCriteria ?? [], problems: d.acceptanceProblems ?? [] }, () => show(d));
  if (run.materialized?.length || run.children) throw new UsageError(`${run.id} はタスク化済みか子の要望の案の run です（タスクの基準は p3 criteria <T>）`);
  const ops: AcceptanceOp[] =
    sub === "add" ? rest.map((text) => ({ op: "add", text }))
    : sub === "edit" || sub === "set" ? [{ op: "edit", id: rest[0] ?? "", text: rest.slice(1).join(" ") }]
    : sub === "rm" || sub === "remove" ? rest.map((id) => ({ op: "remove", id }))
    : sub === "order" ? [{ op: "order", ids: rest }]
    : [];
  if (!ops.length) throw new UsageError("使い方: p3 criteria <D1> add <文>... / edit <ID> <文> / rm <ID>... / order <ID>... --req <要望> [--run <run>]");
  // 案は採番を持たないので、操作は今の基準だけに当てる（読めなかった項目は除いたまま書き直す）
  const next = applyAcceptanceOps({ acceptanceCriteria: d.acceptanceCriteria }, ops, { now: new Date().toISOString() });
  const saved = await ctx.preflight.updateDraft(rid, run.id, key, { acceptanceCriteria: next.acceptanceCriteria ?? [] }, { expectedCriteria: d.acceptanceCriteria ?? [] });
  return out.result({ request: rid, run: run.id, key, criteria: saved.acceptanceCriteria ?? [], problems: [] }, () => show(saved));
}

/**
 * evidence <タスク> <ID> <結果> [--body 本文|- | --file 本文.md]  1項目の証拠を残す（再記録は置き換え）
 * evidence <タスク> --file 証拠.md|-                            見出し「## <ID> <結果>」ごとにまとめて残す
 * evidence <タスク> rm <ID> [...]                              証拠を消す
 */
async function evidenceCommand(env: CommandEnv): Promise<number> {
  const { args, o, taskArg } = env;
  const ref = taskArg(args[0]);
  const [first, ...rest] = args.slice(1);
  if (first === "rm" || first === "remove") {
    if (!rest.length) throw new UsageError("使い方: p3 evidence <タスク> rm <ID> [<ID> ...]");
    return applyAcceptance(env, ref, rest.map((id) => ({ op: "unrecord", id })));
  }
  if (first === undefined) {
    if (o.file === undefined) throw new UsageError("使い方: p3 evidence <タスク> <ID> <結果> [--body 本文|- | --file 本文.md]（まとめてなら --file 証拠.md）");
    return applyAcceptance(env, ref, evidenceOps({ "evidence-file": o.file }));
  }
  const result = rest[0];
  if (!isAcceptanceResult(result)) throw new UsageError(`結果は ${ACCEPTANCE_RESULTS.join(" / ")} のどれかです: p3 evidence <タスク> ${first} <結果>`);
  if (o.body !== undefined && o.file !== undefined) throw new UsageError("--body と --file はどちらか一方です");
  let evidence = rest.slice(1).join(" ");
  if (o.body !== undefined) evidence = readBody(o.body);
  else if (o.file !== undefined) {
    try {
      evidence = readFileSync(resolvePath(process.cwd(), o.file), "utf8");
    } catch {
      throw new UsageError(`証拠のファイルが読めません: ${o.file}`);
    }
  }
  return applyAcceptance(env, ref, [{ op: "record", id: first, result, evidence }]);
}

// --- アーカイブしたタスク（--archived を付けたときだけ。読むだけ） ------------------------------------

/** ls --archived: 今の要望（--req）のアーカイブの一覧。通常の絞り込み・--all とは混ぜない */
async function listArchived({ ctx, out, o, requestArg }: CommandEnv): Promise<number> {
  const mixed = (["all", "status", "area", "q", "repo", "blocked"] as const).filter((k) => o[k] !== undefined && o[k] !== false);
  if (mixed.length) throw new UsageError(`--archived では ${mixed.map((k) => `--${k}`).join(" ")} を使えません（要望は --req で1つ指定）`);
  const list = await listArchivedTasks(ctx.ws, requestArg(undefined));
  return out.result(list, () =>
    [
      table(list.tasks.map((t) => [t.id, t.status, t.updatedAt.slice(0, 10), t.title])) || "アーカイブしたタスクはありません",
      ...list.errors.map((e) => `読めない: ${e.id}  ${e.error}`),
      list.tasks.length || list.errors.length ? "（状態・日付はアーカイブする前の最後の値。進捗・対応済の判定には数えない）" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** show <T003|要望/T003> --archived: アーカイブの1件。通常のタスクは探さない（同じ ID が通常にあってもアーカイブを読む） */
async function showArchived({ ctx, out, args, current, cwd }: CommandEnv): Promise<number> {
  const raw = args.join(" ").trim();
  if (!raw) throw new UsageError("タスクを指定してください（T003 / <要望>/T003）");
  const [head, tail] = raw.split("/", 2);
  const rid = tail !== undefined ? resolveRequestId(ctx, head) : current;
  if (tail === undefined && !current) throw new UsageError(`${raw}: 要望を --req で指定してください`);
  if (!rid) throw new NotFoundError(head);
  const tid = normalizeTaskId(tail ?? head);
  if (!tid) throw new UsageError(`${raw}: タスクの ID（T003）を指定してください`);
  const item = await getArchivedTask(ctx.ws, rid, tid);
  const file = relative(cwd, join(ctx.ws.requestsDir, rid, "tasks", ".archive", `${tid}.md`));
  return out.result({ item, file }, () => formatArchived(item, file));
}

function formatArchived(t: ArchivedTask, file: string): string {
  const lines = [`${t.ref}  ${t.title}`, "  [アーカイブ・閲覧専用] 状態・最終更新はアーカイブする前の最後の値（アーカイブの日時ではない）", ""];
  const fields: [string, unknown][] = [
    ["status", t.status],
    ["repo", t.repo ?? "（なし）"],
    ["labels", t.labels.join(", ")],
    ["areas", t.areas.join(", ")],
    ["outputs", t.outputs.join(" / ")],
    ["repoOutputs", t.repoOutputs?.map((r) => `${r.repo}=${r.output}`).join(" / ")],
    ["createdAt", t.createdAt],
    ["startedAt", t.startedAt],
    ["doneAt", t.doneAt],
    ["checkedAt", t.checkedAt],
    ["updatedAt", t.updatedAt],
    ["updatedBy", t.updatedBy],
  ];
  for (const [k, v] of fields) if (v) lines.push(`  ${k.padEnd(13)} ${String(v)}`);
  if (t.body.trim()) lines.push("", indent(t.body.trim()));
  if (t.record) lines.push("", "変更の記録:", indent(t.record));
  const acc = formatAcceptance(t, { emptyLine: false });
  if (acc.length) lines.push("", ...acc);
  const blk = formatBlock(t, { history: true });
  if (blk.length) lines.push("", ...blk);
  // 保存された関係をそのまま出す（相手が今の通常のタスクかは解かない）
  if (t.relations.length) lines.push("", "保存された関係:", ...t.relations.map((r) => `  → ${relationRole(r.type, "out")} ${r.target}`));
  lines.push("", `ファイル: ${file}`);
  return lines.join("\n");
}
