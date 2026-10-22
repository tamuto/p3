import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Hierarchy } from "../src/shared/hierarchy.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import { HierarchyError, hierarchyOf, hierarchyView } from "../src/core/hierarchy.ts";
import { archiveRequest, createRequest, updateRequest } from "../src/core/requestOps.ts";
import { ConflictError } from "../src/core/store/collection.ts";
import { parseFrontmatter, stringifyFrontmatter } from "../src/core/store/frontmatter.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { makeProject, newRequest, newTask, openTestProject } from "./helpers.ts";

/** 要望の親子（docs/architecture.md の「大きい要望の分割」） */
async function setup() {
  const p = await makeProject({ milestones: [{ id: "v1", title: "最初" }, { id: "v2", title: "次" }] });
  const events: ServerEvent[] = [];
  p.ctx.ws.on((e) => events.push(e));
  return { ...p, events };
}

/** request.md の frontmatter を直接書き換える（外部の編集） */
function editRequest(file: string, patch: Record<string, unknown>) {
  const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
  writeFileSync(file, stringifyFrontmatter({ ...data, ...patch }, body));
}

const rejectsWith = async (p: Promise<unknown>, code: string, reason?: string) => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(HierarchyError);
  expect((e as HierarchyError).code).toBe(code);
  if (reason) expect((e as HierarchyError).detail.reason).toBe(reason);
};

describe("親子の保存と読み込み", () => {
  it("親の無い今までのファイルはそのまま読め、parent を書かない", async () => {
    const { ctx } = await setup();
    const r = await createRequest(ctx, { title: "単独" });
    expect(r.parent).toBeUndefined();
    expect(readFileSync(ctx.ws.requests.path(r.id), "utf8")).not.toContain("parent");
    expect(await hierarchyView(ctx.ws, r.id)).toEqual({ parent: null, ancestors: [], children: [], hierarchyIssues: [] });
  });

  it("子を作ると親を書き、指定していない期限・マイルストーン・タグを親から写す（作った後は別々）", async () => {
    const { ctx, events } = await setup();
    const parent = await createRequest(ctx, { title: "親", due: "2026-12-01", milestone: "v1", tags: ["feature"] });
    await updateRequest(ctx, parent.id, { workstreams: { main: { branch: "req/parent" } } });
    const child = await createRequest(ctx, { title: "子", parent: parent.id });
    expect(child).toMatchObject({ parent: parent.id, due: "2026-12-01", milestone: "v1", tags: ["feature"], status: "draft" });
    expect(child.workstreams).toBeUndefined();
    const own = await createRequest(ctx, { title: "子2", parent: parent.id, milestone: "v2", tags: ["infra"] });
    expect(own).toMatchObject({ milestone: "v2", tags: ["infra"], due: "2026-12-01" });
    // frontmatter のキーの順は status の後
    expect(readFileSync(ctx.ws.requests.path(child.id), "utf8")).toMatch(/status: draft\nparent: /);
    await updateRequest(ctx, parent.id, { milestone: "v2" });
    expect(ctx.ws.requests.require(child.id).milestone).toBe("v1");
    // 親の子の一覧も変わったことを知らせる
    expect(events).toContainEqual({ type: "changed", kind: "request", request: parent.id, ref: undefined });
    const view = await hierarchyView(ctx.ws, parent.id);
    expect(view.children.map((c) => c.id)).toEqual([child.id, own.id]);
    expect(view.children[0]).toMatchObject({ title: "子", status: "draft", tasks: { total: 0, done: 0 } });
  });

  it("付け替え・外すことができ、深い祖先は根から順に返す", async () => {
    const { ctx } = await setup();
    const a = await createRequest(ctx, { title: "A" });
    const b = await createRequest(ctx, { title: "B", parent: a.id });
    const c = await createRequest(ctx, { title: "C", parent: b.id });
    const d = await createRequest(ctx, { title: "D", parent: c.id });
    await newTask(ctx, d.id, { title: "t", status: "done" });
    expect((await hierarchyView(ctx.ws, d.id)).ancestors.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect((await hierarchyView(ctx.ws, c.id)).children).toEqual([{ id: d.id, title: "D", status: "draft", tasks: { total: 1, done: 1 } }]);
    // 付け替え: D を A の直下へ
    await updateRequest(ctx, d.id, { parent: a.id });
    expect((await hierarchyView(ctx.ws, d.id)).ancestors.map((x) => x.id)).toEqual([a.id]);
    // 外す
    const freed = await updateRequest(ctx, d.id, { parent: undefined });
    expect(freed.parent).toBeUndefined();
    expect(readFileSync(ctx.ws.requests.path(d.id), "utf8")).not.toContain("parent:");
  });

  it("無い・形の違う・自分・子孫・アーカイブ済みの親は何も書かずに断る", async () => {
    const { ctx } = await setup();
    const a = await createRequest(ctx, { title: "A" });
    const b = await createRequest(ctx, { title: "B", parent: a.id });
    const c = await createRequest(ctx, { title: "C", parent: b.id });
    const gone = await createRequest(ctx, { title: "消す" });
    await archiveRequest(ctx, gone.id);
    await rejectsWith(createRequest(ctx, { title: "x", parent: "261001-zzzzz" }), "hierarchy_invalid", "not_found");
    await rejectsWith(createRequest(ctx, { title: "x", parent: "other:261001-zzzzz" }), "hierarchy_invalid", "invalid_id");
    await rejectsWith(createRequest(ctx, { title: "x", parent: gone.id }), "hierarchy_invalid", "archived");
    await rejectsWith(updateRequest(ctx, a.id, { parent: a.id }), "hierarchy_invalid", "self");
    await rejectsWith(updateRequest(ctx, a.id, { parent: c.id }), "hierarchy_invalid", "cycle");
    expect(ctx.ws.requests.list().map((r) => r.title).sort()).toEqual(["A", "B", "C"]);
    expect(ctx.ws.requests.require(a.id).rev).toBe(1);
  });

  it("付け替えも rev で楽観ロックする", async () => {
    const { ctx } = await setup();
    const a = await createRequest(ctx, { title: "A" });
    const b = await createRequest(ctx, { title: "B" });
    await expect(updateRequest(ctx, b.id, { parent: a.id }, { expectedRev: 9 })).rejects.toBeInstanceOf(ConflictError);
    expect(ctx.ws.requests.require(b.id).parent).toBeUndefined();
  });

  it("2つのプロセスが同時に逆向きに付け替えても循環にならない（片方だけが通る）", async () => {
    const { ctx, dataDir } = await setup();
    const a = await createRequest(ctx, { title: "A" });
    const b = await createRequest(ctx, { title: "B" });
    const other = await openTestProject(dataDir);
    const results = await Promise.allSettled([updateRequest(ctx, a.id, { parent: b.id }), updateRequest(other, b.id, { parent: a.id })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(HierarchyError);
    await ctx.ws.reloadAll();
    expect((await hierarchyOf(ctx.ws)).issues()).toEqual([]);
  });

  it("直接編集でできた循環・孤児・自分・形の違う親は問題として出し、辿っても止まる", async () => {
    const { ctx } = await setup();
    const a = await createRequest(ctx, { title: "A" });
    const b = await createRequest(ctx, { title: "B", parent: a.id });
    const self = await createRequest(ctx, { title: "自分" });
    const orphan = await createRequest(ctx, { title: "孤児" });
    const odd = await createRequest(ctx, { title: "形" });
    editRequest(ctx.ws.requests.path(a.id), { parent: b.id });
    editRequest(ctx.ws.requests.path(self.id), { parent: self.id });
    editRequest(ctx.ws.requests.path(orphan.id), { parent: "261001-zzzzz" });
    editRequest(ctx.ws.requests.path(odd.id), { parent: "nope" });
    await ctx.ws.reloadAll();
    const h = await hierarchyOf(ctx.ws);
    const codes = Object.fromEntries(h.issues().map((i) => [i.request, i.code]));
    expect(codes).toEqual({ [a.id]: "parent_cycle", [b.id]: "parent_cycle", [self.id]: "parent_cycle", [orphan.id]: "parent_missing", [odd.id]: "parent_invalid" });
    expect(h.ancestors(a.id).map((r) => r.id)).toEqual([b.id]);
    expect(h.descendants(a.id).map((r) => r.id)).toEqual([b.id]);
    expect((await hierarchyView(ctx.ws, a.id)).hierarchyIssues.length).toBeGreaterThan(0);
    // 循環の中へは付けない
    const c = await createRequest(ctx, { title: "C" });
    await rejectsWith(updateRequest(ctx, c.id, { parent: a.id }), "hierarchy_invalid", "cycle");
  });

  it("読めない親・アーカイブした親は種類を分けて出す", () => {
    const req = (id: string, parent?: string) => ({ id, title: id, status: "active" as const, parent, areas: [], tags: [], rev: 1, createdAt: "", updatedAt: "", body: "" });
    const h = new Hierarchy({ requests: [req("261001-aaaaa", "261001-bbbbb"), req("261001-ccccc", "261001-ddddd")], unreadable: ["261001-bbbbb"], archived: ["261001-ddddd"] });
    expect(h.issues().map((i) => i.code)).toEqual(["parent_unreadable", "parent_archived"]);
  });

  it("外のプロセスが付けた親は再読み込みで取り込む", async () => {
    const { ctx, dataDir } = await setup();
    const a = await createRequest(ctx, { title: "A" });
    const other = await openTestProject(dataDir);
    const b = await createRequest(other, { title: "B", parent: a.id });
    await ctx.ws.reloadAll();
    expect((await hierarchyView(ctx.ws, a.id)).children.map((c) => c.id)).toEqual([b.id]);
  });
});

describe("アーカイブ", () => {
  it("子のある要望・親のある要望はアーカイブを断り、外せばアーカイブできる。ファイルもタスクも動かさない", async () => {
    const { ctx } = await setup();
    const a = await createRequest(ctx, { title: "A" });
    const b = await createRequest(ctx, { title: "B", parent: a.id });
    await newTask(ctx, a.id, { title: "親のタスク" });
    await rejectsWith(archiveRequest(ctx, a.id), "has_children");
    await rejectsWith(archiveRequest(ctx, b.id), "has_parent");
    expect(ctx.ws.requests.get(a.id)).toBeDefined();
    await updateRequest(ctx, b.id, { parent: undefined });
    await archiveRequest(ctx, b.id);
    await archiveRequest(ctx, a.id);
    expect(ctx.ws.requests.list()).toEqual([]);
  });
});

describe("API", () => {
  async function api() {
    const p = await setup();
    const app = apiRoutes(p.ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    return { ...p, call };
  }

  it("parent で子を作り、詳細に親子を返し、?parent= で直下の子を絞る。null で外す", async () => {
    const { call, ctx } = await api();
    const parent = await newRequest(ctx, { title: "親", milestone: "v1" });
    const child = await call("POST", "/requests", { title: "子", parent: parent.id });
    expect(child.status).toBe(201);
    expect(child.body).toMatchObject({ parent: parent.id, milestone: "v1" });
    const detail = await call("GET", `/requests/${child.body.id}`);
    expect(detail.body).toMatchObject({ parent: parent.id, ancestors: [{ id: parent.id, title: "親" }], children: [], hierarchyIssues: [] });
    expect((await call("GET", `/requests/${parent.id}`)).body.children.map((c: { id: string }) => c.id)).toEqual([child.body.id]);
    const kids = await call("GET", `/requests?parent=${parent.id}`);
    expect(kids.body.map((p: { request: { id: string } }) => p.request.id)).toEqual([child.body.id]);
    const freed = await call("PATCH", `/requests/${child.body.id}`, { parent: null, rev: child.body.rev });
    expect(freed.status).toBe(200);
    expect(freed.body.parent).toBeUndefined();
  });

  it("CLI と同じ規則で断り、409 と code・reason を返す", async () => {
    const { call, ctx } = await api();
    const a = await newRequest(ctx, { title: "A" });
    const b = await call("POST", "/requests", { title: "B", parent: a.id });
    const bad = await call("POST", "/requests", { title: "x", parent: "261001-zzzzz" });
    expect(bad).toMatchObject({ status: 409, body: { code: "hierarchy_invalid", reason: "not_found" } });
    const cycle = await call("PATCH", `/requests/${a.id}`, { parent: b.body.id });
    expect(cycle).toMatchObject({ status: 409, body: { code: "hierarchy_invalid", reason: "cycle" } });
  });
});
