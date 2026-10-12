import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ChatGptAccount } from "../src/server/chatgpt/account.ts";
import { CodexWorkspaceEngine } from "../src/server/preflight/codexEngine.ts";
import { parseAssessment } from "../src/server/preflight/service.ts";
import { writeRepoEntry } from "../src/server/store/projectFile.ts";
import { makeProject, makeRepo, newRequest, openTestProject, tempDir } from "./helpers.ts";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

async function setup() {
  const repo = await makeRepo();
  await mkdir(join(repo.root, "src", "server"), { recursive: true });
  await writeFile(join(repo.root, "src", "server", "main.ts"), "export {}\n");
  const docs = tempDir("docs-");
  const file = join(repo.dataDir, "project.yaml");
  const base = { role: "", readFirst: false, writable: false, map: [] };
  await writeRepoEntry(file, "app", { ...base, name: "app" });
  await writeRepoEntry(file, "docs", { ...base, name: "docs" });
  await writeRepoEntry(file, "gone", { ...base, name: "gone" });
  let evidence: unknown[] | undefined;
  const codex = new CodexWorkspaceEngine({
    authVolume: "vol",
    account: new ChatGptAccount(join(tempDir(), "none.json")),
    pathMap: [],
    ensureImage: false,
    command: () => [
      "env",
      `FAKE_REPO=${repo.root}`,
      `FAKE_DATA=${repo.dataDir}`,
      "FAKE_LOG=/dev/null",
      ...(evidence ? [`FAKE_EVIDENCE=${JSON.stringify(evidence)}`] : []),
      process.execPath,
      FAKE_CODEX,
    ],
  });
  const ctx = await openTestProject(repo.dataDir, { codex }, { repos: { app: repo.root, docs } });
  const req = await newRequest(ctx, { title: "x", status: "draft", body: "本文" });
  const run = async (ev?: unknown[]) => {
    evidence = ev;
    const { id } = await ctx.preflight.start(req.id);
    return (await ctx.preflight.wait(req.id, id))!;
  };
  return { ctx, req, run, repo };
}

describe("判断の根拠（assessment.json の evidence）", () => {
  it("確かめた根拠は、読めた参照先の中にあるファイルを指すときだけ認める。ほかは推測に直して理由を残す（項目は消さない）", async () => {
    const { run, ctx, req } = await setup();
    const r = await run([
      { claim: "実現可能性: 入口は main.ts", kind: "verified", repo: "app", file: "src/server/main.ts", location: "L1" },
      { claim: "無いファイル", kind: "verified", repo: "docs", file: "nope.md" },
      { claim: "見ていない参照先", kind: "verified", repo: "gone", file: "x.md" },
      { claim: "登録の無い参照先", kind: "verified", repo: "unknown", file: "x.md" },
      { claim: "外へ出るパス", kind: "verified", repo: "app", file: "../../etc/passwd" },
      { claim: "場所なし", kind: "verified" },
      { claim: "推測: 既存の CLI で足りるはず", kind: "assumed" },
      { kind: "assumed" },
      "文字列は捨てる",
    ]);
    expect(r.status).toBe("completed");
    const ev = r.assessment!.evidence!;
    expect(ev.map((e) => [e.claim, e.kind, e.note ?? ""])).toEqual([
      ["実現可能性: 入口は main.ts", "verified", ""],
      ["無いファイル", "assumed", "docs:nope.md がありません"],
      ["見ていない参照先", "assumed", "参照先 gone はこの評価で見ていません"],
      ["登録の無い参照先", "assumed", "参照先「unknown」は登録されていません"],
      ["外へ出るパス", "assumed", "参照先の中の相対パスではありません"],
      ["場所なし", "assumed", "参照先とファイルが書かれていないので、確かめた根拠として扱いません"],
      ["推測: 既存の CLI で足りるはず", "assumed", ""],
      ["（判断の説明がありません）", "assumed", ""],
    ]);
    expect(ev[0]).toMatchObject({ repo: "app", file: "src/server/main.ts", location: "L1" });
    // 保存して読み直しても同じ。見ていない参照先は記録（scope）でも見ていない
    const again = (await ctx.ws.preflight.get(req.id, r.id))!;
    expect(again.assessment!.evidence).toEqual(ev);
    expect(again.scope!.find((s) => s.name === "gone")!.status).toBe("unregistered");
  });

  it("再評価では前回の根拠を「前回の時点のもの」として渡し、今回の確かめた根拠に写さない。タスク化はそのまま", async () => {
    const { run, ctx, req } = await setup();
    const first = await run([{ claim: "前回確かめた", kind: "verified", repo: "app", file: "src/server/main.ts" }]);
    const second = await run(); // 今回は evidence を書かなかった
    expect(second.previous).toBe(first.id);
    const carry = await readFile(join(ctx.ws.preflight.runDir(req.id, second.id), "carryover.md"), "utf8");
    expect(carry).toContain("### 前回の根拠（前回の時点のもの。使うなら今回あらためて確かめ、確かめていなければ assumed にする）");
    expect(carry).toContain("- 確かめた: 前回確かめた（app:src/server/main.ts）");
    expect(second.assessment!.evidence).toBeUndefined(); // 記録なし（前回の根拠を写さない）
    const { tasks } = await ctx.preflight.materialize(req.id, second.id);
    expect(tasks.length).toBe(2);
  });

  it("以前の結果（evidence が無い）は記録なしのまま読む。Mock の根拠は推測", async () => {
    expect(parseAssessment(JSON.stringify({ summary: "古い", verdict: "go" })).evidence).toBeUndefined();
    expect(parseAssessment(JSON.stringify({ evidence: "壊れた" })).evidence).toBeUndefined();
    // 参照先を渡さなければ（以前の run の読み直しなど）kind はそのまま
    expect(parseAssessment(JSON.stringify({ evidence: [{ claim: "a", kind: "verified", repo: "x", file: "y" }] })).evidence).toEqual([
      { claim: "a", kind: "verified", repo: "x", file: "y" },
    ]);
    const { ctx } = await makeProject();
    const req = await newRequest(ctx, { title: "m", status: "draft", body: "- a\n- b" });
    const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
    const r = (await ctx.preflight.wait(req.id, id))!;
    expect(r.assessment!.evidence!.every((e) => e.kind === "assumed")).toBe(true);
  });
});
