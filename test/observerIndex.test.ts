import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefinitionStore, type DefinitionListing } from "../packages/observer/src/core/definitionStore.ts";
import { ObservationIndex } from "../packages/app/src/core/observerIndex.ts";
import { singleProjectApp } from "../packages/app/src/server/server.ts";
import { openProject } from "../packages/tasks/src/core/context.ts";
import { PRODUCTS } from "../packages/app/src/core/products.ts";
import { tempDir } from "./helpers.ts";
import { initialized } from "./cliHelpers.ts";

/**
 * 要望の詳細の「この要望で扱った観測」（docs/architecture.md「p3-observer」の観測の候補と表示の速さ）: 観測の履歴の実作業の帰属の逆引き・同じ観測の履歴をまとめる・
 * 推定の経緯を数えない・監視の知らせで作り直し、監視していない・立て直した後は読むたびに作り直す・一覧と要望の詳細の本体は観測を読まない
 */
const W = (task: string) => ({ work: { request: "261121-aaaaa", task } });

afterEach(() => vi.restoreAllMocks());

describe("観測の履歴の逆引きの索引", () => {
  it("実作業の帰属だけを要望ごとにまとめ、監視の知らせ・立て直し・監視なしで作り直す", async () => {
    const store = new DefinitionStore(tempDir("p3-obs-index-"));
    const a = await store.create({ title: "A", description: "a", expected: "1" }, "x", W("T001"));
    await store.update(a.id, 1, { title: "A", description: "a", expected: "2" }, "x", W("T002"));
    await store.create({ title: "B", description: "b" }, "x", { work: { request: "261121-bbbbb", task: "T001" } });
    await store.create({ title: "文脈なし", description: "c" }, "x");
    let reads = 0;
    const list = async (): Promise<DefinitionListing> => (reads++, store.list());
    let listener: (rel: string) => void = () => {};
    const ws = { epoch: 1 as number | undefined, onPath: (l: (rel: string) => void) => ((listener = l), () => {}), get watchEpoch() { return this.epoch; } };
    const index = new ObservationIndex(list, ws);
    expect(await index.forRequest("261121-aaaaa")).toEqual({ observations: [{ id: a.id, title: "A", ended: false, kinds: ["created", "expected"] }], unreadable: 0 });
    expect((await index.forRequest("261121-bbbbb")).observations.map((o) => o.title)).toEqual(["B"]);
    expect((await index.forRequest("261121-zzzzz")).observations).toEqual([]);
    expect(reads).toBe(1);
    listener("requests/261121-aaaaa/request.md");
    await index.forRequest("261121-aaaaa");
    expect(reads).toBe(1);
    await store.end(a.id, 2, { reason: "CI に移した" }, "x", W("T003"));
    listener(`observer/definitions/${a.id}.json`);
    expect((await index.forRequest("261121-aaaaa")).observations[0]).toMatchObject({ ended: true, kinds: ["created", "expected", "ended"] });
    expect(reads).toBe(2);
    ws.epoch = 2; // 監視を立て直した（途切れた間の変更を取りこぼしているかもしれない）
    await index.forRequest("261121-aaaaa");
    expect(reads).toBe(3);
    ws.epoch = undefined; // 監視していない
    await index.forRequest("261121-aaaaa");
    await index.forRequest("261121-aaaaa");
    expect(reads).toBe(5);
  });

  it("推定の経緯は実作業として数えず、読めない観測のファイルは数を出す", async () => {
    const dataDir = tempDir("p3-obs-index-est-");
    const store = new DefinitionStore(dataDir);
    const d = await store.create({ title: "推定だけ", description: "x" }, "x");
    const file = join(dataDir, "observer", "definitions", `${d.id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), estimatedOrigin: { requests: ["261121-aaaaa"], basis: "git log", confirmedAt: "", confirmedBy: "x" } }));
    writeFileSync(join(dataDir, "observer", "definitions", "obs-261121-zzzzz.json"), "{");
    const index = new ObservationIndex(() => store.list(), { onPath: () => () => {}, watchEpoch: undefined });
    expect(await index.forRequest("261121-aaaaa")).toEqual({ observations: [], unreadable: 1 });
  });
});

describe("API", () => {
  it("要望の一覧と詳細の本体は観測を読まず、観測の欄の API だけが索引から返す", async () => {
    const { root, rid } = await initialized();
    const dataDir = join(root, ".p3");
    await new DefinitionStore(dataDir).create({ title: "この要望の観測", description: "x" }, "x", { work: { request: rid, task: "T001" } });
    const ctx = await openProject(dataDir, { projectName: "app" });
    const app = singleProjectApp(ctx, PRODUCTS);
    const lists = vi.spyOn(DefinitionStore.prototype, "list");
    expect((await app.request("/requests")).status).toBe(200);
    expect((await app.request(`/requests/${rid}`)).status).toBe(200);
    expect(lists).not.toHaveBeenCalled();
    const r = (await (await app.request(`/requests/${rid}/observations`)).json()) as { observations: { title: string }[] };
    expect(r.observations.map((o) => o.title)).toEqual(["この要望の観測"]);
    expect(lists).toHaveBeenCalledTimes(1);
    ctx.ws.close();
  });
});
