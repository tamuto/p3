import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { progress } from "../src/core/ops.ts";
import { materialOf } from "../src/core/releaseNotes/material.ts";
import { completeMilestoneRequests, completionPlan, CompletionRejected } from "../src/core/releaseNotes/completeRequests.ts";
import { createRequest, createTask, updateRequest, updateTask } from "../src/core/requestOps.ts";
import { completionCheck, resolvedIssue, StatusRuleError } from "../src/core/requestStatus.ts";
import { parseFrontmatter, stringifyFrontmatter } from "../src/core/store/frontmatter.ts";
import { Workspace } from "../src/core/store/workspace.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

/** 親子の完了の判定・祖先を戻す・進捗・リリースノート（docs/architecture.md の「状態と完了の判定」「進捗とリリースノート」） */
async function setup() {
  const p = await makeProject({ milestones: [{ id: "v1", title: "最初" }, { id: "v2", title: "次" }] });
  /** 要望（と、状態を指定したタスク）を作る。parent は親の ID */
  const add = async (title: string, status: string, tasks: string[] = [], parent?: string, milestone = "v1") => {
    await new Promise((r) => setTimeout(r, 2));
    const r = await newRequest(p.ctx, { title, status: status as never, parent, milestone });
    for (const [i, s] of tasks.entries()) await newTask(p.ctx, r.id, { title: `${title}-${i + 1}`, status: s as never, record: s === "done" ? `${title} の記録` : undefined });
    return r.id;
  };
  const status = async (id: string) => {
    await p.ctx.ws.requests.reload(id);
    return p.ctx.ws.requests.require(id).status;
  };
  const block = async (id: string) => (await completionCheck(p.ctx.ws, id)).blocker;
  return { ...p, add, status, block };
}

describe("親子の対応済の判定", () => {
  it("自分のタスクが無くても、子が全部 対応済・完了済なら親を対応済にできる", async () => {
    const { ctx, add, block } = await setup();
    const parent = await add("親", "active");
    await add("子A", "resolved", ["done"], parent);
    await add("子B", "done", ["done"], parent);
    expect(await block(parent)).toBeUndefined();
    expect((await updateRequest(ctx, parent, { status: "resolved" })).status).toBe("resolved");
  });

  it("自分のタスクと子の混在: どちらかが未完了ならできない", async () => {
    const { add, block } = await setup();
    const parent = await add("親", "active", ["done", "done"]);
    const child = await add("子", "active", ["doing"], parent);
    expect(await block(parent)).toContain(`子 ${child} が未完了（active）`);
    const p2 = await add("親2", "active", ["todo"]);
    await add("子2", "resolved", ["done"], p2);
    expect(await block(p2)).toContain("完了していないタスク");
  });

  it("孫まで見る。対応済の子の下に未完了の孫があればできない", async () => {
    const { add, block } = await setup();
    const parent = await add("親", "active");
    const child = await add("子", "resolved", [], parent);
    const grand = await add("孫", "active", ["todo"], child);
    expect(await block(parent)).toContain(`子 ${grand} が未完了`);
  });

  it("見送りの子は対象外と示す。全部見送りで自分のタスクも無ければ空の要望として断る。単独の空の要望も今までどおり断る", async () => {
    const { add, block, ctx } = await setup();
    const parent = await add("親", "active");
    await add("子A", "resolved", ["done"], parent);
    const rejected = await add("子B", "rejected", ["todo"], parent);
    expect(await completionCheck(ctx.ws, parent)).toEqual({ excluded: [rejected] });
    const empty = await add("全部見送り", "active");
    const r2 = await add("見送り", "rejected", [], empty);
    expect(await block(empty)).toContain(`子の要望が全部見送りです（対象外: ${r2}）`);
    expect(await block(await add("単独", "active"))).toContain("タスクがありません");
  });

  it("外で編集されて、完了済の子に未完了のタスクがあればできない。完了済にするのも断る（子の無い要望の完了済は確かめない）", async () => {
    const { ctx, add, block } = await setup();
    const parent = await add("親", "resolved");
    const child = await add("子", "done", ["done"], parent);
    const file = ctx.ws.tasksOf(child).path("T001");
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    writeFileSync(file, stringifyFrontmatter({ ...data, status: "doing" }, body));
    expect(await block(parent)).toContain(`子 ${child} は done ですが完了していないタスクがあります（T001(doing)）`);
    await expect(updateRequest(ctx, parent, { status: "done" })).rejects.toBeInstanceOf(StatusRuleError);
    expect(resolvedIssue(ctx.ws, ctx.ws.requests.require(parent))).toContain("配下の要望が終わっていません");
    const single = await add("単独", "resolved", ["todo"]);
    await expect(updateRequest(ctx, single, { status: "done" })).resolves.toMatchObject({ status: "done" });
  });

  it("親子の問題（循環）があればできない", async () => {
    const { ctx, add, block } = await setup();
    const a = await add("A", "active", ["done"]);
    const b = await add("B", "resolved", ["done"], a);
    const file = ctx.ws.requests.path(a);
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    writeFileSync(file, stringifyFrontmatter({ ...data, parent: b }, body));
    expect(await block(a)).toContain("親子の問題");
  });
});

describe("祖先を戻す", () => {
  it("子にタスクを足すと、子と対応済の祖先を進行中に戻す。完了済の祖先は変えずに警告を返す", async () => {
    const { ctx, add, status } = await setup();
    const root = await add("根", "done");
    const parent = await add("親", "resolved", [], root);
    const child = await add("子", "resolved", ["done"], parent);
    const r = await createTask(ctx, child, { title: "追加" });
    expect(r.reopened).toBe(child);
    expect(r.reopenedAncestors).toEqual([parent]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: "ancestor_done", target: root, from: child })]);
    expect(await status(parent)).toBe("active");
    expect(await status(root)).toBe("done");
  });

  it("完了から戻す・子を進行中に戻す・対応済の親に未完了の子を足す・付け替えても祖先を戻す。自動で対応済にはしない", async () => {
    const { ctx, add, status } = await setup();
    const parent = await add("親", "resolved");
    const child = await add("子", "resolved", ["done"], parent);
    await updateTask(ctx, child, "T001", { status: "doing" });
    expect(await status(parent)).toBe("active");
    await updateTask(ctx, child, "T001", { status: "done" });
    expect(await status(parent)).toBe("active"); // 自動では対応済にしない
    await updateRequest(ctx, child, { status: "resolved" });
    await updateRequest(ctx, parent, { status: "resolved" });
    const back = await updateRequest(ctx, child, { status: "active" });
    expect(back.reopenedAncestors).toEqual([parent]);
    await updateRequest(ctx, child, { status: "resolved" });
    await updateRequest(ctx, parent, { status: "resolved" });
    const added = await createRequest(ctx, { title: "新しい子", parent });
    expect(added.reopenedAncestors).toEqual([parent]);
    const other = await add("別の親", "resolved", ["done"]);
    const moved = await updateRequest(ctx, added.id, { parent: other });
    expect(moved.reopenedAncestors).toEqual([other]);
  });

  it("見送りの子の下が未完了になっても祖先は戻さない", async () => {
    const { ctx, add, status } = await setup();
    const parent = await add("親", "resolved", ["done"]);
    const rejected = await add("見送り", "rejected", [], parent);
    const grand = await add("孫", "resolved", ["done"], rejected);
    await createTask(ctx, grand, { title: "追加" });
    expect(await status(parent)).toBe("resolved");
  });

  it("祖先を戻すのに失敗したら、戻したものと直し方が分かるエラーにする", async () => {
    const { ctx, add } = await setup();
    const root = await add("根", "resolved");
    const parent = await add("親", "resolved", [], root);
    const child = await add("子", "resolved", ["done"], parent);
    // 根のファイルを読めなくする（更新で失敗させる）
    writeFileSync(ctx.ws.requests.path(root), "---\n: [broken\n---\n");
    await expect(createTask(ctx, child, { title: "追加" })).rejects.toThrow(new RegExp(`${parent} は進行中に戻しましたが、祖先の ${root} を進行中に戻せませんでした.*status=active`));
    expect(ctx.ws.requests.require(parent).status).toBe("active");
  });
});

describe("進捗", () => {
  it("自分の値と配下の集計を分け、全体の合計は各タスクを1回だけ数える。親の最終更新は配下も見る", async () => {
    const { ctx, add } = await setup();
    const parent = await add("親", "active", ["done"]);
    const child = await add("子", "active", ["done", "todo"], parent);
    await add("孫", "active", ["doing"], child);
    await new Promise((r) => setTimeout(r, 5));
    const last = await createTask(ctx, child, { title: "最後" });
    const rows = progress(ctx);
    const p = rows.find((r) => r.request.id === parent)!;
    expect(p).toMatchObject({ total: 1, done: 1, children: [child] });
    expect(p.subtree).toMatchObject({ total: 5, done: 2, counts: { todo: 2, doing: 1, done: 2 } });
    expect(p.subtree.requests.active).toBe(2);
    // 子の要望の更新（タスクを足してブランチを割り当てた）も配下の更新
    expect(p.updatedAt >= last.task.updatedAt).toBe(true);
    expect(p.updatedAt).toBe(rows.find((r) => r.request.id === child)!.updatedAt);
    expect(rows.reduce((n, r) => n + r.total, 0)).toBe(5);
  });

  it("循環しても止まり、問題として返す", async () => {
    const { ctx, add } = await setup();
    const a = await add("A", "active", ["done"]);
    const b = await add("B", "active", ["todo"], a);
    const file = ctx.ws.requests.path(a);
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    writeFileSync(file, stringifyFrontmatter({ ...data, parent: b }, body));
    await ctx.ws.reloadAll();
    const p = progress(ctx).find((r) => r.request.id === a)!;
    expect(p.subtree.total).toBe(2);
    expect(p.hierarchyIssues.map((i) => i.code)).toContain("parent_cycle");
  });
});

describe("リリースノート", () => {
  const material = async (dataDir: string, mid = "v1") => {
    const ws = new Workspace(dataDir);
    await ws.load();
    return materialOf(ws, mid);
  };

  it("子だけの親は構造の要望として収録し、材料は各要望の自分の記録だけを1回入れる", async () => {
    const { add, dataDir } = await setup();
    const parent = await add("親", "resolved");
    const a = await add("子A", "resolved", ["done"], parent);
    const b = await add("子B", "done", ["done"], parent);
    const m = await material(dataDir);
    const p = m.requests.find((r) => r.id === parent)!;
    expect(p).toMatchObject({ included: true, structural: true, children: [a, b] });
    expect(p.warnings).toEqual([]);
    expect(m.sources.map((s) => s.request)).toEqual([a, b]);
    expect(m.sources.flatMap((s) => s.tasks.map((t) => t.record))).toEqual(["子A の記録", "子B の記録"]);
  });

  it("別のマイルストーンの子の記録は親のマイルストーンに入れず、その子が終わるまで親は収録しない", async () => {
    const { ctx, add, dataDir } = await setup();
    const parent = await add("親", "resolved", ["done"]); // 外の編集で、未完了の子のある親が対応済
    const other = await add("別の子", "active", ["todo"], parent, "v2");
    let m = await material(dataDir);
    expect(m.requests.find((r) => r.id === parent)).toMatchObject({ included: false, reason: "配下の要望が終わっていない" });
    expect(m.requests.map((r) => r.id)).toEqual([parent]);
    await updateTask(ctx, other, "T001", { status: "done", record: "別の記録" });
    await updateRequest(ctx, other, { status: "resolved" });
    // 子の作業で親は進行中に戻っている。子が終わったので親を対応済にする
    await updateRequest(ctx, parent, { status: "resolved" });
    m = await material(dataDir);
    expect(m.requests.find((r) => r.id === parent)).toMatchObject({ included: true });
    expect(m.sources.map((s) => s.request)).toEqual([parent]);
    expect((await material(dataDir, "v2")).sources.map((s) => s.request)).toEqual([other]);
  });

  it("マイルストーンの外の子が変わると hash が変わり、古い basedOn の一括完了を断る。親子の無いものは今までの hash のまま", async () => {
    const { ctx, add } = await setup();
    const parent = await add("親", "resolved", ["done"]);
    const child = await add("子", "resolved", ["done"], parent, "v2");
    const before = await completionPlan(ctx, "v1");
    expect(before.ready).toBe(true);
    await updateRequest(ctx, child, { title: "題だけ変えても", status: "resolved" });
    expect((await completionPlan(ctx, "v1")).basedOn).toBe(before.basedOn); // 完了を左右しない変更では変わらない
    await createTask(ctx, child, { title: "追加" });
    const after = await completionPlan(ctx, "v1");
    expect(after.basedOn).not.toBe(before.basedOn);
    expect(after.ready).toBe(false);
    await expect(completeMilestoneRequests(ctx, "v1", before.basedOn)).rejects.toBeInstanceOf(CompletionRejected);
  });

  it("一括完了は子から親の順に完了済にする（同じマイルストーンの親子）", async () => {
    const { ctx, add, status } = await setup();
    const parent = await add("親", "resolved");
    const child = await add("子", "resolved", ["done"], parent);
    const grand = await add("孫", "resolved", ["done"], child);
    const plan = await completionPlan(ctx, "v1");
    expect(plan.ready).toBe(true);
    const result = await completeMilestoneRequests(ctx, "v1", plan.basedOn);
    expect(result.completed.map((t) => t.id)).toEqual([grand, child, parent]);
    expect(await status(parent)).toBe("done");
  });
});

describe("API", () => {
  it("詳細に completion（できない理由・対象外の子）を返し、タスクの作成で戻した祖先を返す", async () => {
    const { ctx, add } = await setup();
    const app = apiRoutes(ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const parent = await add("親", "resolved");
    const child = await add("子", "resolved", ["done"], parent);
    const rejected = await add("見送り", "rejected", [], parent);
    expect((await call("GET", `/requests/${parent}`)).body.completion).toEqual({ excluded: [rejected] });
    const created = await call("POST", `/requests/${child}/tasks`, { title: "追加" });
    expect(created.body).toMatchObject({ reopened: child, reopenedAncestors: [parent] });
    expect((await call("GET", `/requests/${parent}`)).body.completion.blocker).toContain(child);
    expect(await newRequest(ctx, { title: "x" })).toBeDefined();
  });
});
