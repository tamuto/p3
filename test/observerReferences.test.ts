import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefinitionStore, PreparationStore } from "../packages/observer/src/core/definitionStore.ts";
import { observerRoutes } from "../packages/observer/src/server/api/routes.ts";
import { tempDir } from "./helpers.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * 観測の前提の観測と使う準備（docs/architecture.md「p3-observer」の前提の観測と準備）: 名前から ID への解決・自分自身・循環・存在しない参照の拒否・
 * 準備の削除と参照元・同時の更新で循環や参照切れが残らないこと・形の版 1・2 の読み込み・CLI と API の表示
 */
const obs = (title: string, extra: Record<string, unknown> = {}) => ({ title, description: `${title}を確かめる`, ...extra });

function stores() {
  const dataDir = tempDir("p3-obs-refs-");
  return { dataDir, defs: new DefinitionStore(dataDir), preps: new PreparationStore(dataDir) };
}

describe("前提の観測と使う準備の保存", () => {
  it("準備は名前でも ID でも指定でき、ID で保存する（改名しても参照は切れない）。タイトルと観測内容だけでも登録できる", async () => {
    const { defs, preps } = stores();
    const p = await preps.create({ name: "サインイン済み" }, "a");
    const signIn = await defs.create(obs("サインイン"), "a");
    expect(signIn).not.toHaveProperty("prerequisites");
    const d = await defs.create(obs("業務画面", { prerequisites: [signIn.id], preparations: [" サインイン済み "] }), "a");
    expect(d).toMatchObject({ format: 4, prerequisites: [signIn.id], preparations: [p.id] });
    await preps.update(p.id, 1, { name: "利用者でサインイン済み" }, "a");
    expect(await defs.references(await defs.get(d.id))).toEqual({ prerequisites: [{ id: signIn.id, title: "サインイン" }], preparations: [{ id: p.id, name: "利用者でサインイン済み" }] });
    expect((await defs.update(d.id, 1, obs("業務画面", { preparations: [p.id] }), "a")).preparations).toEqual([p.id]);
  });

  it("自分自身・直接と間接の循環・存在しない観測と準備は、該当する欄のメッセージを返して保存しない", async () => {
    const { defs } = stores();
    const a = await defs.create(obs("A"), "a");
    const b = await defs.create(obs("B", { prerequisites: [a.id] }), "a");
    const c = await defs.create(obs("C", { prerequisites: [b.id] }), "a");
    const fails = async (id: string, input: unknown) => {
      const e = await defs.update(id, 1, input, "a").catch((x: { code: string; problems: unknown[] }) => x);
      expect((await defs.get(id)).rev).toBe(1);
      return e;
    };
    expect(await fails(a.id, obs("A", { prerequisites: [a.id] }))).toMatchObject({ code: "invalid", problems: [{ path: "prerequisites[0]", message: "自分自身は前提にできません" }] });
    expect(await fails(a.id, obs("A", { prerequisites: [b.id] }))).toMatchObject({ problems: [{ path: "prerequisites[0]", message: expect.stringContaining("循環") }] });
    expect(await fails(a.id, obs("A", { prerequisites: [c.id] }))).toMatchObject({ problems: [{ path: "prerequisites[0]", message: expect.stringContaining("循環") }] });
    expect(await fails(a.id, obs("A", { prerequisites: ["obs-261121-zzzzz", "x"], preparations: ["無い準備"] }))).toMatchObject({
      problems: expect.arrayContaining([
        { path: "prerequisites[1]", message: expect.stringContaining("観測の ID") },
      ]),
    });
    expect(await fails(a.id, obs("A", { prerequisites: ["obs-261121-zzzzz"], preparations: ["無い準備"] }))).toMatchObject({
      problems: [
        { path: "preparations[0]", message: "準備がありません: 無い準備" },
        { path: "prerequisites[0]", message: "観測がありません: obs-261121-zzzzz" },
      ],
    });
    await expect(defs.create(obs("D", { prerequisites: ["obs-261121-zzzzz"] }), "a")).rejects.toMatchObject({ problems: [{ path: "prerequisites[0]" }] });
    expect((await defs.list()).definitions).toHaveLength(3);
  });

  it("使っている準備は消せず参照元を示す。観測のファイルが読めないときも消さない。使われていない準備は今の版を添えて消せる", async () => {
    const { dataDir, defs, preps } = stores();
    const p = await preps.create({ name: "注文1件" }, "a");
    const d = await defs.create(obs("注文の一覧", { preparations: [p.id] }), "a");
    await expect(preps.remove(p.id, 1)).rejects.toMatchObject({ code: "in_use", message: expect.stringContaining(`${d.id} 注文の一覧`) });
    await defs.update(d.id, 1, obs("注文の一覧"), "a");
    writeFileSync(join(dataDir, "observer", "definitions", "obs-261121-bbbbb.json"), "{ 壊れた");
    await expect(preps.remove(p.id, 1)).rejects.toMatchObject({ code: "unreadable", message: expect.stringContaining("obs-261121-bbbbb.json") });
    unlinkSync(join(dataDir, "observer", "definitions", "obs-261121-bbbbb.json"));
    await expect(preps.remove(p.id, 2)).rejects.toMatchObject({ code: "conflict" });
    await preps.remove(p.id, 1);
    expect((await preps.list()).items).toEqual([]);
  });

  it("同時の更新: 準備の削除と参照の追加、互いを前提にする2つの更新を競合させても、参照切れや循環が残らない", async () => {
    for (let i = 0; i < 5; i++) {
      const { defs, preps } = stores();
      const p = await preps.create({ name: "共有の準備" }, "a");
      const d = await defs.create(obs("観測"), "a");
      await Promise.allSettled([preps.remove(p.id, 1), defs.update(d.id, 1, obs("観測", { preparations: [p.id] }), "a")]);
      const left = await preps.list();
      const now = await defs.get(d.id);
      expect(left.items.length === 1 ? now.preparations : now.preparations ?? []).toEqual(left.items.length === 1 ? [p.id] : []);

      const a = await defs.create(obs("A"), "a");
      const b = await defs.create(obs("B"), "a");
      const rs = await Promise.allSettled([defs.update(a.id, 1, obs("A", { prerequisites: [b.id] }), "a"), defs.update(b.id, 1, obs("B", { prerequisites: [a.id] }), "a")]);
      expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const [na, nb] = [await defs.get(a.id), await defs.get(b.id)];
      expect([na.prerequisites?.includes(b.id), nb.prerequisites?.includes(a.id)].filter(Boolean)).toHaveLength(1);
    }
  });

  it("形の版 1・2 の観測は参照の無い定義として読み、更新・切り替えで今の形の版（4）を書く", async () => {
    const { dataDir, defs } = stores();
    const d = await defs.create(obs("古い形", { procedures: [{ title: "見る", run: { kind: "ai-instruction", target: "画面", steps: ["開く"], judge: "出る", record: "なし" }, replacement: { kind: "script", repo: "app", path: "x.mjs", operation: "o", output: "o", compare: "c", switchWhen: "s" } }] }), "a");
    const file = join(dataDir, "observer", "definitions", `${d.id}.json`);
    writeFileSync(file, JSON.stringify({ ...d, format: 2 }));
    const read = await defs.get(d.id);
    expect(read).toMatchObject({ format: 4 });
    expect(read).not.toHaveProperty("prerequisites");
    expect(JSON.parse(readFileSync(file, "utf8")).format).toBe(2);
    await defs.update(d.id, 1, obs("古い形", { procedures: read.procedures }), "a");
    expect(JSON.parse(readFileSync(file, "utf8")).format).toBe(4);
    writeFileSync(file, JSON.stringify({ ...(await defs.get(d.id)), format: 2 }));
    const files = (repo: string) => (repo === "app" ? ("exists" as const) : ("unverified" as const));
    await new DefinitionStore(dataDir, files).switchProcedure(d.id, 2, "P1", { invoke: "node x.mjs", evidence: "同じ結果" }, "a");
    expect(JSON.parse(readFileSync(file, "utf8")).format).toBe(4);
  });
});

describe("CLI と API", () => {
  it("show に前提と使う準備の名前、準備の show に使う観測が出る。API は参照の名前・削除の拒否・項目ごとの誤りを返す", async () => {
    const { root } = await initialized();
    const j = (args: string[]) => {
      const r = p3(root, [...args, "--json"]);
      expect(r.code, r.err).toBe(0);
      return r.json();
    };
    const prep = j(["observer", "prep", "add", "--title", "サインイン済み"]);
    const base = j(["observer", "add", "--title", "サインイン", "--body", "サインインできる"]);
    writeFileSync(join(root, "obs.json"), JSON.stringify(obs("業務画面", { prerequisites: [base.id], preparations: ["サインイン済み"] })));
    const d = j(["observer", "add", "--input", "obs.json"]);
    expect(p3(root, ["observer", "show", d.id]).out).toContain(`前提の観測（失敗したらこの観測は未確認）: ${base.id} サインイン`);
    expect(p3(root, ["observer", "show", d.id]).out).toContain(`使う準備: ${prep.id} サインイン済み`);
    expect(p3(root, ["observer", "prep", "show", prep.id]).out).toContain(`使う観測 1 件\n  ${d.id}  業務画面`);
    const rm = p3(root, ["observer", "prep", "rm", prep.id, "--rev", "1"]);
    expect([rm.code, rm.err]).toEqual([3, expect.stringContaining(d.id)]);

    const api = observerRoutes({ target: { project: "app", dataDir: join(root, ".p3") } });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await api.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    expect((await call("GET", `/definitions/${d.id}`)).body.references).toEqual({ prerequisites: [{ id: base.id, title: "サインイン" }], preparations: [{ id: prep.id, name: "サインイン済み" }] });
    const self = await call("PUT", `/definitions/${base.id}`, { rev: 1, definition: obs("サインイン", { prerequisites: [d.id] }) });
    expect([self.status, self.body.problems]).toEqual([400, [{ path: "prerequisites[0]", message: expect.stringContaining("循環") }]]);
    expect((await call("DELETE", `/preparations/${prep.id}?rev=1`)).body).toMatchObject({ code: "in_use" });
    expect((await call("GET", `/preparations/${prep.id}`)).body.usedBy.definitions).toEqual([{ id: d.id, title: "業務画面", rev: 1 }]);
    j(["observer", "update", d.id, "--rev", "1", "--input", "obs.json"]);
    writeFileSync(join(root, "obs.json"), JSON.stringify(obs("業務画面")));
    j(["observer", "update", d.id, "--rev", "2", "--input", "obs.json"]);
    expect((await call("DELETE", `/preparations/${prep.id}?rev=1`)).body).toEqual({ deleted: prep.id });
  });
});
