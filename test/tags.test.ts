import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { Workspace } from "../src/core/store/workspace.ts";
import { addTag, cleanTag, removeTag, sameTags, tagsFrom } from "../src/shared/tags.ts";
import { draftOf, editDraft, syncDraft } from "../src/web/lib/draft.ts";
import { makeProject, newRequest } from "./helpers.ts";

describe("タグの入力（値ごと）", () => {
  it("新しく入れる値は前後の空白を除き、空と完全に同じ値は付けない。値の中身は変えない", () => {
    expect(cleanTag("  jira:PROJ-123 ")).toBe("jira:PROJ-123");
    expect(cleanTag("   ")).toBeNull();
    const base = ["a,b", " 既存の空白 "]; // 既にある値（正規化しない）
    expect(addTag(base, "group:顧客A")).toEqual(["a,b", " 既存の空白 ", "group:顧客A"]);
    expect(addTag(base, "a,b")).toBe(base);
    expect(addTag(base, "")).toBe(base);
    expect(addTag(["A"], "a")).toEqual(["A", "a"]); // 大小文字は別の値
    const long = `${"長い値".repeat(60)}/x:y`;
    expect(addTag([], long)).toEqual([long]);
    expect(removeTag(["a,b", "x", "a,b "], "a,b")).toEqual(["x", "a,b "]);
    expect(tagsFrom(["x", " x ", "", "y, z", "x"])).toEqual(["x", "y, z"]);
    expect(sameTags(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameTags(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("下書き: 取り直しても足しかけ・外しかけのタグは残し、保存は編集を始めたときの rev", () => {
    const d = editDraft(draftOf<string[]>(["x"], 2), ["x", "jira:PROJ-1"]);
    expect(syncDraft(d, ["x"], 2, sameTags)).toBe(d); // 同じ rev の取り直し
    const ext = syncDraft(d, ["外で付けた"], 3, sameTags);
    expect(ext.value).toEqual(["x", "jira:PROJ-1"]);
    expect(ext.baseRev).toBe(2);
    expect(ext.external).toEqual({ value: ["外で付けた"], rev: 3 });
    expect(syncDraft(draftOf<string[]>(["x"], 2), ["x"], 3, sameTags)).toEqual(draftOf(["x"], 3)); // 編集していなければ追従
  });
});

describe("タグの保存（API・ファイル）", () => {
  const values = ["jira:PROJ-123", "group:顧客A", "a,b", "release/2026Q4", "顧客 A: 東京/大阪", `${"x".repeat(300)}`, "#hash", "'quoted' \"double\""];

  it("API で作成・更新した値は、ファイルとの往復でそのまま残る", async () => {
    const p = await makeProject();
    const app = apiRoutes(p.ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const created = await call("POST", "/requests", { title: "外部 ID", tags: values });
    expect(created.status).toBe(201);
    expect(created.body.tags).toEqual(values);
    const updated = await call("PATCH", `/requests/${created.body.id}`, { tags: [...values.slice(1), "追加"], rev: 1 });
    expect(updated.body.tags).toEqual([...values.slice(1), "追加"]);
    // 古い rev では保存しない（入力を残すのは画面の側）
    expect((await call("PATCH", `/requests/${created.body.id}`, { tags: ["古い画面から"], rev: 1 })).status).toBe(409);
    const fresh = new Workspace(p.dataDir);
    await fresh.load();
    expect(fresh.requests.get(created.body.id)!.tags).toEqual([...values.slice(1), "追加"]);
  });

  it("ファイルにあるカンマ入りの値は読み込むだけで分けず、ほかの項目を保存してもそのまま", async () => {
    const p = await makeProject();
    const r = await newRequest(p.ctx, { title: "既存" });
    const file = join(p.dataDir, "requests", r.id, "request.md");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace(/^rev:/m, 'tags:\n  - "a,b"\n  - " 前後に空白 "\n  - group:顧客A\nrev:'));
    await p.ctx.ws.reloadAll();
    expect(p.ctx.ws.requests.get(r.id)!.tags).toEqual(["a,b", " 前後に空白 ", "group:顧客A"]);
    await p.ctx.ws.requests.update(r.id, { title: "既存（題名だけ変える）" });
    const again = new Workspace(p.dataDir);
    await again.load();
    expect(again.requests.get(r.id)!.tags).toEqual(["a,b", " 前後に空白 ", "group:顧客A"]);
  });
});
