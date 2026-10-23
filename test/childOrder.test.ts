import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Hierarchy, orderSiblings } from "../src/shared/hierarchy.ts";
import type { Request } from "../src/shared/types.ts";
import { HierarchyError, hierarchyView } from "../src/core/hierarchy.ts";
import { createRequest, orderChildren, updateRequest } from "../src/core/requestOps.ts";
import { ConflictError } from "../src/core/store/collection.ts";
import { parseFrontmatter, stringifyFrontmatter } from "../src/core/store/frontmatter.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { progress } from "../src/core/ops.ts";
import { progressTree } from "../src/web/lib/progressTree.ts";
import { makeProject, newTask, openTestProject } from "./helpers.ts";

/** 子の表示順（docs/architecture.md の「子の表示順」）: 親の childOrder と、そこに無い子の作成順 */

const req = (id: string, createdAt: string, extra: Partial<Request> = {}): Request => ({
  id,
  title: id,
  status: "active",
  areas: [],
  tags: [],
  rev: 1,
  createdAt,
  updatedAt: createdAt,
  body: "",
  ...extra,
});
const ids = (rs: { id: string }[]) => rs.map((r) => r.id);

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
  return e as HierarchyError;
};

describe("兄弟の並び（orderSiblings）", () => {
  const kids = [req("261001-b10", "2026-10-02T00:00:00Z"), req("261001-b2", "2026-10-02T00:00:00Z"), req("261001-a", "2026-10-01T00:00:00Z")];

  it("保存した順が無い（今までのデータ）なら作成日時の古い順、同じ日時は数を考えた ID の順", () => {
    expect(ids(orderSiblings(kids, undefined))).toEqual(["261001-a", "261001-b2", "261001-b10"]);
  });

  it("保存した順にある子を先に、無い子は作成順で後ろに。重複・今は子でない ID・形の違う値は無視する", () => {
    expect(ids(orderSiblings(kids, ["261001-b10", "261001-b10", "gone", "", "261001-a"]))).toEqual(["261001-b10", "261001-a", "261001-b2"]);
  });

  it("Hierarchy は親ごとの順を孫以下にも使い、詳細の子も同じ順", () => {
    const h = new Hierarchy({
      requests: [
        req("p", "2026-10-01T00:00:00Z", { childOrder: ["c2", "c1"] }),
        req("c1", "2026-10-02T00:00:00Z", { parent: "p", childOrder: ["g2"] }),
        req("c2", "2026-10-03T00:00:00Z", { parent: "p" }),
        req("g1", "2026-10-04T00:00:00Z", { parent: "c1" }),
        req("g2", "2026-10-05T00:00:00Z", { parent: "c1" }),
      ],
    });
    expect(ids(h.children("p"))).toEqual(["c2", "c1"]);
    expect(ids(h.children("c1"))).toEqual(["g2", "g1"]);
    expect(ids(h.descendants("p"))).toEqual(["c2", "c1", "g2", "g1"]);
    expect(ids(h.view("p").children)).toEqual(["c2", "c1"]);
  });
});

describe("進捗の木の兄弟", () => {
  const row = (r: Request) => ({
    request: r,
    tasks: [],
    counts: { todo: 0, doing: 0, done: 0 },
    total: 0,
    done: 0,
    updatedAt: r.updatedAt,
    children: [],
    subtree: { counts: { todo: 0, doing: 0, done: 0 }, total: 0, done: 0, requests: { draft: 0, preflight: 0, reviewed: 0, active: 0, resolved: 0, done: 0, rejected: 0 } },
    hierarchyIssues: [],
  });
  const shape = (rows: ReturnType<typeof progressTree>) => rows.map((r) => `${"  ".repeat(r.depth)}${r.p.request.id}${r.context ? "（文脈）" : ""}`);
  // 渡す順は更新の新しい順（後ろの子 c3 を最後に更新した）。根の p と q は渡された順（q が先）
  const all = [
    row(req("c3", "2026-10-04T00:00:00Z", { parent: "p" })),
    row(req("q", "2026-10-01T00:00:00Z")),
    row(req("c1", "2026-10-02T00:00:00Z", { parent: "p", childOrder: ["g2", "g1"] })),
    row(req("g1", "2026-10-05T00:00:00Z", { parent: "c1" })),
    row(req("p", "2026-10-01T00:00:00Z", { childOrder: ["c1", "c2", "c3"] })),
    row(req("c2", "2026-10-03T00:00:00Z", { parent: "p" })),
    row(req("g2", "2026-10-06T00:00:00Z", { parent: "c1" })),
  ];

  it("根は渡された順のまま、兄弟は親の表示順（子を更新しても兄弟の位置は変わらない）。孫以下も各親の順", () => {
    expect(shape(progressTree(all, all, new Set()))).toEqual(["q", "p", "  c1", "    g2", "    g1", "  c2", "  c3"]);
  });

  it("絞り込みで子が減っても、残った子の前後は変えない", () => {
    const matched = all.filter((r) => ["c3", "g1"].includes(r.request.id));
    expect(shape(progressTree(all, matched, new Set()))).toEqual(["p（文脈）", "  c1（文脈）", "    g1", "  c3"]);
  });

  it("循環している要望は根に出し、止まる", () => {
    const cyc = [row(req("x", "2026-10-01T00:00:00Z", { parent: "y", childOrder: ["y"] })), row(req("y", "2026-10-02T00:00:00Z", { parent: "x", childOrder: ["x"] }))];
    expect(shape(progressTree(cyc, cyc, new Set())).sort()).toEqual(["x", "y"]);
  });
});

async function family(n = 3) {
  const p = await makeProject();
  const parent = await createRequest(p.ctx, { title: "親" });
  const kids: Request[] = [];
  for (let i = 0; i < n; i++) kids.push(await createRequest(p.ctx, { title: `子${i + 1}`, parent: parent.id }));
  return { ...p, parent: p.ctx.ws.requests.require(parent.id), kids };
}
const childIds = async (ctx: Awaited<ReturnType<typeof makeProject>>["ctx"], id: string) => (await hierarchyView(ctx.ws, id)).children.map((c) => c.id);

describe("子の表示順の保存（orderChildren）", () => {
  it("親の childOrder だけを書き、別の読み込み・CLI・API の親で絞った一覧・進捗の木で同じ順になる。後ろの子を更新しても変わらない", async () => {
    const { ctx, dataDir, root, parent, kids } = await family();
    const [a, b, c] = kids.map((k) => k.id);
    const before = kids.map((k) => readFileSync(ctx.ws.requests.path(k.id), "utf8"));
    const saved = await orderChildren(ctx, parent.id, [c, a, b], { expectedRev: parent.rev, actor: "human:test" });
    expect(saved).toMatchObject({ childOrder: [c, a, b], rev: parent.rev + 1 });
    expect(readFileSync(ctx.ws.requests.path(parent.id), "utf8")).toMatch(/status: draft\nchildOrder:\n {2}- /);
    // 子のファイルは変えない
    expect(kids.map((k) => readFileSync(ctx.ws.requests.path(k.id), "utf8"))).toEqual(before);
    // 後ろの子の本文・タスクを変えても兄弟の順は変わらない
    await updateRequest(ctx, b, { body: "更新した" });
    await newTask(ctx, b, { title: "作業", status: "doing" });
    const other = await openTestProject(dataDir);
    expect(await childIds(other, parent.id)).toEqual([c, a, b]);
    // API の ?parent= と詳細
    const app = apiRoutes(ctx);
    const get = async (path: string) => (await app.request(path)).json();
    expect((await get(`/requests?parent=${parent.id}`)).map((p: { request: { id: string } }) => p.request.id)).toEqual([c, a, b]);
    expect((await get(`/requests/${parent.id}`)).children.map((x: { id: string }) => x.id)).toEqual([c, a, b]);
    // CLI の request ls --parent
    const cli = JSON.parse(
      execFileSync(process.execPath, [join(process.cwd(), "bin/p3.mjs"), "request", "ls", "--parent", parent.id, "--json"], {
        cwd: root,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), INIT_CWD: root, XDG_CONFIG_HOME: join(root, ".xdg") },
        encoding: "utf8",
      }),
    ) as { id: string }[];
    expect(ids(cli)).toEqual([c, a, b]);
    // 進捗の木（根は更新順のまま）
    const rows = progress(ctx);
    expect(progressTree(rows, rows, new Set()).filter((r) => r.depth === 1).map((r) => r.p.request.id)).toEqual([c, a, b]);
  });

  it("重複・無い要望・ほかの親の子・足りない・子の無い親は何も書かずに断り、今の並びを返す", async () => {
    const { ctx, parent, kids } = await family();
    const [a, b, c] = kids.map((k) => k.id);
    const stranger = await createRequest(ctx, { title: "別の親" });
    const theirs = await createRequest(ctx, { title: "別の子", parent: stranger.id });
    const file = readFileSync(ctx.ws.requests.path(parent.id), "utf8");
    const e = await rejectsWith(orderChildren(ctx, parent.id, [a, a, b, c]), "child_order_invalid", "duplicate");
    expect(e.detail).toMatchObject({ ids: [a], children: [a, b, c] });
    await rejectsWith(orderChildren(ctx, parent.id, [a, b, c, "261001-zzzzz"]), "child_order_invalid", "not_found");
    await rejectsWith(orderChildren(ctx, parent.id, [a, b, c, theirs.id]), "child_order_invalid", "not_child");
    await rejectsWith(orderChildren(ctx, parent.id, [c, a]), "child_order_invalid", "missing");
    await rejectsWith(orderChildren(ctx, a, [a]), "child_order_invalid", "no_children");
    expect(readFileSync(ctx.ws.requests.path(parent.id), "utf8")).toBe(file);
    expect(ctx.ws.requests.require(theirs.id).parent).toBe(stranger.id);
  });

  it("親の rev が違えば ConflictError、読んだ後に子が増えたら missing で、どちらも書かない", async () => {
    const { ctx, parent, kids } = await family(2);
    const [a, b] = kids.map((k) => k.id);
    await updateRequest(ctx, parent.id, { body: "外で変えた" });
    await expect(orderChildren(ctx, parent.id, [b, a], { expectedRev: parent.rev })).rejects.toBeInstanceOf(ConflictError);
    // 画面が [a, b] を読んだ後に子が増えた
    const late = await createRequest(ctx, { title: "後から", parent: parent.id });
    const e = await rejectsWith(orderChildren(ctx, parent.id, [b, a]), "child_order_invalid", "missing");
    expect(e.detail.children).toEqual([a, b, late.id]);
    expect(ctx.ws.requests.require(parent.id).childOrder).toBeUndefined();
  });

  it("新しい子は末尾、外した・付け替えた子は読むときに除き、同じ親に戻すと前の位置に戻る（配列に残るため）", async () => {
    const { ctx, parent, kids } = await family();
    const [a, b, c] = kids.map((k) => k.id);
    await orderChildren(ctx, parent.id, [c, b, a]);
    const d = (await createRequest(ctx, { title: "子4", parent: parent.id })).id;
    expect(await childIds(ctx, parent.id)).toEqual([c, b, a, d]);
    const other = await createRequest(ctx, { title: "別の親" });
    await updateRequest(ctx, b, { parent: other.id });
    await updateRequest(ctx, c, { parent: undefined });
    expect(await childIds(ctx, parent.id)).toEqual([a, d]);
    // 親の childOrder は書き換えない
    expect(ctx.ws.requests.require(parent.id).childOrder).toEqual([c, b, a]);
    await updateRequest(ctx, b, { parent: parent.id });
    expect(await childIds(ctx, parent.id)).toEqual([b, a, d]);
    // 保存し直すと今の子だけが残る
    await orderChildren(ctx, parent.id, [d, a, b]);
    expect(ctx.ws.requests.require(parent.id).childOrder).toEqual([d, a, b]);
  });

  it("直接編集でできた重複・形の違う値・今は子でない ID は、有効な子を1回ずつにして読む", async () => {
    const { ctx, dataDir, parent, kids } = await family();
    const [a, b, c] = kids.map((k) => k.id);
    editRequest(ctx.ws.requests.path(parent.id), { childOrder: [b, 3, b, null, "261001-zzzzz", a, { x: 1 }] });
    const other = await openTestProject(dataDir);
    expect(other.ws.requests.require(parent.id).childOrder).toEqual([b, b, "261001-zzzzz", a]);
    expect(await childIds(other, parent.id)).toEqual([b, a, c]);
    editRequest(ctx.ws.requests.path(parent.id), { childOrder: "壊れた値" });
    expect(await childIds(await openTestProject(dataDir), parent.id)).toEqual([a, b, c]);
  });

  it("API: PUT /requests/:rid/child-order は同じ操作で保存し、断るときは 409 と code・reason・今の並び", async () => {
    const { ctx, parent, kids } = await family(2);
    const [a, b] = kids.map((k) => k.id);
    const app = apiRoutes(ctx);
    const put = async (body: unknown) => {
      const res = await app.request(`/requests/${parent.id}/child-order`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const ok = await put({ children: [b, a], rev: parent.rev });
    expect(ok).toMatchObject({ status: 200, body: { request: { childOrder: [b, a] }, children: [b, a] } });
    expect(await put({ children: [a, b], rev: parent.rev })).toMatchObject({ status: 409, body: { code: "rev_conflict" } });
    expect(await put({ children: [a] })).toMatchObject({ status: 409, body: { code: "child_order_invalid", reason: "missing", children: [b, a] } });
    expect((await put({ children: "x" })).status).toBe(400);
  });
});

describe("分割の採用の初期の並び", () => {
  const bullets = (n: number) => Array.from({ length: n }, (_, i) => `- 項目${i + 1}`).join("\n");
  async function split(n: number, siblings = 0) {
    const p = await makeProject();
    const parent = await createRequest(p.ctx, { title: "大きい要望", body: bullets(n) });
    const before: string[] = [];
    for (let i = 0; i < siblings; i++) before.push((await createRequest(p.ctx, { title: `既存${i + 1}`, parent: parent.id })).id);
    return { ...p, parent, before };
  }
  const run = async (ctx: Awaited<ReturnType<typeof makeProject>>["ctx"], rid: string) => {
    const { id } = await ctx.preflight.start(rid, { engine: "mock" });
    return (await ctx.preflight.wait(rid, id))!;
  };

  it("同じ run の子を C1, C2, C3, C10 の数の順に並べて保存する", async () => {
    const { ctx, parent } = await split(8);
    const r = await run(ctx, parent.id);
    // Mock の案は3件まで。C10 の案を足す（文字の順なら C1, C10, C2, C3 になる）
    const dir = join(ctx.ws.preflight.runDir(parent.id, r.id), "children");
    const { data, body } = parseFrontmatter(readFileSync(join(dir, "C1.md"), "utf8"));
    writeFileSync(join(dir, "C10.md"), stringifyFrontmatter({ ...data, key: "C10", title: "十番目", requires: [] }, body));
    const result = await ctx.preflight.adopt(parent.id, r.id);
    expect(result.failed).toEqual([]);
    const byKey = Object.fromEntries(result.created.map((c) => [c.key, c.id]));
    const keys = ["C1", "C2", "C3", "C10"];
    expect(result.created.map((c) => c.key)).toEqual(keys);
    expect(ctx.ws.requests.require(parent.id).childOrder).toEqual(keys.map((k) => byKey[k]));
    expect(await childIds(ctx, parent.id)).toEqual(keys.map((k) => byKey[k]));
  });

  it("既存の兄弟と人が保存した順は前に残し、途中で落ちてやり直しても重ねず、逆にしない", async () => {
    const { ctx, parent, before } = await split(6, 2);
    const [x, y] = before;
    await orderChildren(ctx, parent.id, [y, x]);
    const r = await run(ctx, parent.id);
    const save = ctx.ws.preflight.save.bind(ctx.ws.preflight);
    let calls = 0;
    // 1回目の save は ID の予約、2回目（C1 を作って並びに足した後の記録）で落ちる
    const spy = vi.spyOn(ctx.ws.preflight, "save").mockImplementation(async (s) => {
      if (++calls === 2) throw new Error("落ちた");
      return save(s);
    });
    const first = await ctx.preflight.adopt(parent.id, r.id);
    spy.mockRestore();
    expect(first.failed).toHaveLength(1);
    const reserved = (await ctx.preflight.get(parent.id, r.id))!.adoption!.reserved;
    expect(ctx.ws.requests.require(parent.id).childOrder).toEqual([y, x, reserved.C1]);
    const again = await ctx.preflight.adopt(parent.id, r.id);
    expect(again.failed).toEqual([]);
    expect(ctx.ws.requests.require(parent.id).childOrder).toEqual([y, x, reserved.C1, reserved.C2]);
    expect(await childIds(ctx, parent.id)).toEqual([y, x, reserved.C1, reserved.C2]);
  });

  it("保存した順の無い既存の子は作成順のまま前に残す", async () => {
    const { ctx, parent, before } = await split(6, 2);
    const r = await run(ctx, parent.id);
    const result = await ctx.preflight.adopt(parent.id, r.id);
    expect(await childIds(ctx, parent.id)).toEqual([...before, ...result.created.map((c) => c.id)]);
  });
});
