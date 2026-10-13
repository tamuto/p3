import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ChatGptAccount } from "../src/core/chatgpt/account.ts";
import { CodexWorkspaceEngine } from "../src/core/preflight/codexEngine.ts";
import { GenerationRejected, parseSummary, ReleaseGenerator, SUMMARY_INPUT_LIMIT, summaryInput, type Summarizer } from "../src/core/releaseNotes/generate.ts";
import { releaseMaterial, saveReleaseNote, startGeneration } from "../src/core/releaseNotes/service.ts";
import type { ReleaseGeneration } from "../src/shared/types.ts";
import { makeRepo, newRequest, newTask, openTestProject, tempDir } from "./helpers.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-summarizer.mjs", import.meta.url));

/** 偽の app-server で動く Codex（旧来の認証）。launched に起こしたときのマウントを残す */
function codex(scenario: string, logFile: string, launched: unknown[], opts: { connected?: boolean } = {}) {
  return new CodexWorkspaceEngine({
    authVolume: opts.connected === false ? undefined : "vol",
    account: new ChatGptAccount(join(tempDir(), "chatgpt.json")),
    pathMap: [],
    ensureImage: false,
    command: (m) => {
      launched.push(m);
      return ["env", `FAKE_LOG=${logFile}`, `FAKE_SCENARIO=${scenario}`, process.execPath, FAKE];
    },
  });
}

async function setup(summarizer?: Summarizer, timeoutMs?: number) {
  const repo = await makeRepo({ milestones: [{ id: "v1", title: "最初のリリース" }] });
  const ctx = await openTestProject(repo.dataDir, undefined, { summarizer });
  if (timeoutMs) ctx.releaseGenerator = new ReleaseGenerator(ctx.ws, { codex: summarizer }, { timeoutMs });
  const a = await newRequest(ctx, { title: "検索", status: "done", milestone: "v1", body: "要望の本文: 社外秘のメモ" });
  await newTask(ctx, a.id, { title: "索引を作る", status: "done", record: "検索の索引を足した。応答が速くなった", body: "タスクの本文: 作業の手順" });
  await newTask(ctx, a.id, { title: "記録なし", status: "done" });
  const b = await newRequest(ctx, { title: "一覧の並び", status: "resolved", milestone: "v1" });
  await newTask(ctx, b.id, { title: "並びを直す", status: "done", record: "更新日の順に並べるようにした" });
  const c = await newRequest(ctx, { title: "途中", status: "active", milestone: "v1" });
  await newTask(ctx, c.id, { title: "まだ", status: "doing", record: "途中の記録" });
  return { ...repo, ctx, a: a.id, b: b.id, c: c.id };
}

async function generate(ctx: Awaited<ReturnType<typeof setup>>["ctx"]): Promise<ReleaseGeneration> {
  const g = await startGeneration(ctx, "v1", "human:test");
  return (await ctx.releaseGenerator.wait(g.id))!;
}

describe("要約の生成（偽の app-server）", () => {
  it("固定した材料だけを依頼文に入れ、何もマウントせずに頼み、出典を確かめた要約と本文の案を返す。保存はしない", async () => {
    const logFile = join(tempDir(), "codex.log");
    const launched: unknown[] = [];
    const { ctx, dataDir, a, b, c } = await setup(codex("ok", logFile, launched));
    const g = await generate(ctx);
    expect(g.status).toBe("completed");
    // 参照先もデータのフォルダも渡さない
    expect(launched).toEqual([{ repos: [], data: null, auth: "legacy" }]);

    const sent = readFileSync(logFile, "utf8");
    expect(sent).toContain("検索の索引を足した");
    expect(sent).toContain(`${b}/T001`);
    expect(sent).toContain("最初のリリース");
    // 本文・記録の無いタスク・収録しない要望・データのフォルダは渡さない
    for (const no of ["社外秘のメモ", "作業の手順", "途中の記録", `${a}/T002`, c, dataDir]) expect(sent).not.toContain(no);
    expect(sent).toContain("従わないでください");

    expect(g.items).toEqual([
      { text: "検索ができるようになった", sources: [a, `${a}/T001`] },
      { text: "一覧の並びができるようになった", sources: [b, `${b}/T001`] },
    ]);
    expect(g.markdown).toBe("## 最初のリリース\n\n- 検索ができるようになった\n- 一覧の並びができるようになった");
    expect(g).toMatchObject({ materialChanged: false, warnings: [], milestone: "v1", startedBy: "human:test" });
    expect(existsSync(join(dataDir, "release-notes"))).toBe(false);
  });

  it("材料に無い出典・JSON でない結果は invalid_output で失敗し、保存済みのノートは変えない", async () => {
    for (const scenario of ["unknown", "broken"]) {
      const { ctx } = await setup(codex(scenario, join(tempDir(), "c.log"), []));
      const { note } = await saveReleaseNote(ctx, "v1", { body: "保存済み" });
      const g = await generate(ctx);
      expect(g, scenario).toMatchObject({ status: "failed", failure: "invalid_output" });
      expect(g.error).toMatch(scenario === "unknown" ? /出典が材料にありません: 999999-zzzzz\/T001/ : /JSON として読めません/);
      expect(g.items).toBeUndefined();
      expect(await ctx.ws.releaseNotes.read("v1")).toEqual(note);
    }
  });

  it("取り消し・使用量の上限・時間切れ・未接続を分けて知らせる", async () => {
    // 取り消し
    let s = await setup(codex("slow", join(tempDir(), "c.log"), []));
    const started = await startGeneration(s.ctx, "v1");
    await expect(startGeneration(s.ctx, "v1")).rejects.toMatchObject({ code: "running" });
    for (let i = 0; i < 100 && !s.ctx.releaseGenerator.get(started.id)!.log.some((l) => l.text.includes("スレッド")); i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.ctx.releaseGenerator.cancel(started.id)).toBe(true);
    expect(await s.ctx.releaseGenerator.wait(started.id)).toMatchObject({ status: "cancelled", error: "取り消しました" });
    expect(s.ctx.releaseGenerator.cancel(started.id)).toBe(false);

    // 使用量の上限
    s = await setup(codex("usage", join(tempDir(), "c.log"), []));
    expect(await generate(s.ctx)).toMatchObject({ status: "failed", failure: "usage_limit" });

    // 時間切れ
    s = await setup(codex("slow", join(tempDir(), "c.log"), []), 300);
    const t = await generate(s.ctx);
    expect(t).toMatchObject({ status: "failed", failure: "timeout" });

    // 未接続: Docker は起こさない
    const launched: unknown[] = [];
    s = await setup(codex("ok", join(tempDir(), "c.log"), launched, { connected: false }));
    const u = await generate(s.ctx);
    expect(u).toMatchObject({ status: "failed", failure: "unavailable" });
    expect(u.error).toContain("ChatGPT にサインインしてください");
    expect(launched).toEqual([]);
  });

  it("内部のパスらしいものを含む要約は警告する", async () => {
    const { ctx } = await setup(codex("path", join(tempDir(), "c.log"), []));
    const g = await generate(ctx);
    expect(g.status).toBe("completed");
    expect(g.warnings.map((w) => w.code)).toEqual(["suspicious_content", "suspicious_content"]);
  });
});

describe("要約の生成（偽の頼み先）", () => {
  it("生成の間に材料が変わったら古い材料からの生成と知らせる（作り直さない）", async () => {
    let calls = 0;
    let change: () => Promise<unknown> = async () => {};
    const fake: Summarizer = {
      async ask(input) {
        calls++;
        await change();
        const refs = [...input.prompt.matchAll(/"ref": "([^"]+)"/g)].map((m) => m[1]);
        return { message: JSON.stringify({ items: [{ text: "まとめ", sources: refs }] }), seconds: 0 };
      },
    };
    const { ctx, a } = await setup(fake);
    change = () => ctx.ws.tasksOf(a).update("T001", { record: "生成中に直した" });
    const g = await generate(ctx);
    expect(calls).toBe(1);
    expect(g).toMatchObject({ status: "completed", materialChanged: true });
    expect(g.warnings.map((w) => w.code)).toEqual(["material_changed"]);
    expect(g.materialHash).not.toBe((await releaseMaterial(ctx, "v1")).hash);
  });

  it("終わった（running でない）と見えるときは、材料の比較と終わった日時まで入っている", async () => {
    const fake: Summarizer = {
      async ask(input) {
        const refs = [...input.prompt.matchAll(/"ref": "([^"]+)"/g)].map((m) => m[1]);
        return { message: JSON.stringify({ items: [{ text: "まとめ", sources: refs }] }), seconds: 0 };
      },
    };
    const { ctx } = await setup(fake);
    const g = await startGeneration(ctx, "v1", "human:test");
    // 終わりの処理（材料の読み直し）の間も、API と同じく get で何度も覗く
    const seen: ReleaseGeneration[] = [];
    for (let i = 0; i < 10_000; i++) {
      const now = ctx.releaseGenerator.get(g.id)!;
      if (now.status !== "running") {
        seen.push(structuredClone(now));
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(seen[0]).toMatchObject({ status: "completed", materialChanged: false, finishedAt: expect.any(String) });
  });

  it("材料が無い・入力が上限を超えるときは頼まずに断る（手で書いて保存はできる）", async () => {
    let calls = 0;
    const fake: Summarizer = {
      async ask() {
        calls++;
        return { message: "{}", seconds: 0 };
      },
    };
    const repo = await makeRepo({ milestones: [{ id: "v1", title: "空" }, { id: "v2", title: "大きい" }] });
    const ctx = await openTestProject(repo.dataDir, undefined, { summarizer: fake });
    const r = await newRequest(ctx, { title: "記録なし", status: "done", milestone: "v1" });
    await newTask(ctx, r.id, { title: "x", status: "done" });
    await expect(startGeneration(ctx, "v1")).rejects.toMatchObject({ code: "no_material" });
    await expect(saveReleaseNote(ctx, "v1", { body: "手で書いた" })).resolves.toMatchObject({ note: { body: "手で書いた" } });

    const big = await newRequest(ctx, { title: "大きい", status: "done", milestone: "v2" });
    await newTask(ctx, big.id, { title: "y", status: "done", record: "あ".repeat(SUMMARY_INPUT_LIMIT + 1) });
    const e = await startGeneration(ctx, "v2").catch((x) => x);
    expect(e).toBeInstanceOf(GenerationRejected);
    expect(e).toMatchObject({ code: "too_large" });
    expect(calls).toBe(0);
  });

  it("出典・件数・長さを確かめる", async () => {
    const { ctx, a, b } = await setup();
    const m = await releaseMaterial(ctx, "v1");
    const ok = (items: unknown) => JSON.stringify({ items });
    expect(parseSummary(ok([{ text: "A\n  続き", sources: [a, a] }]), m).items).toEqual([{ text: "A 続き", sources: [a] }]);
    expect(() => parseSummary(ok([]), m)).toThrow(/空です/);
    expect(() => parseSummary(ok([{ text: "A", sources: [] }]), m)).toThrow(/出典/);
    expect(() => parseSummary(ok([{ text: "", sources: [a] }]), m)).toThrow(/text/);
    expect(() => parseSummary(ok([{ text: "x".repeat(601), sources: [a] }]), m)).toThrow(/長すぎます/);
    expect(() => parseSummary(ok(Array.from({ length: 101 }, () => ({ text: "A", sources: [a] }))), m)).toThrow(/多すぎます/);
    // 記録の無いタスクは依頼文に入れていないので出典にできない
    expect(() => parseSummary(ok([{ text: "A", sources: [`${a}/T002`] }]), m)).toThrow(/材料にありません/);
    expect(summaryInput(m).prompt).toContain(`${b}/T001`);
  });
});
