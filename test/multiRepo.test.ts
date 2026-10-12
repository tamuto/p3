import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ChatGptAccount } from "../src/core/chatgpt/account.ts";
import { CodexWorkspaceEngine, type HostMount } from "../src/core/preflight/codexEngine.ts";
import { writeRepoEntry } from "../src/core/store/projectFile.ts";
import { gitInit, makeRepo, newRequest, openTestProject, tempDir } from "./helpers.ts";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

/**
 * 参照先が3つ（git のリポジトリ・別のリポジトリの中のサブフォルダ・git でないフォルダ）と、このマシンのパスが無いもの1つ。
 * 偽の app-server で、マウント・指示文・記録を確かめる
 */
async function setup(opts: { missingAll?: boolean } = {}) {
  const repo = await makeRepo({ repos: [] });
  await mkdir(join(repo.root, "src", "server"), { recursive: true });
  await writeFile(join(repo.root, "src", "server", "main.ts"), "");
  const docsRepo = tempDir("docsrepo-");
  gitInit(docsRepo);
  await mkdir(join(docsRepo, "guide"));
  await writeFile(join(docsRepo, "guide", "intro.md"), "# ガイド\n");
  const infra = tempDir("infrarepo-");
  await mkdir(join(infra, "terraform"));
  const file = join(repo.dataDir, "project.yaml");
  const base = { readFirst: false, writable: false, map: [] };
  await writeRepoEntry(file, "app", { ...base, name: "app", role: "システム本体", readFirst: true, writable: true, map: [{ path: "src/server", role: "API", entry: "src/server/main.ts" }] });
  await writeRepoEntry(file, "docs", { ...base, name: "docs", role: "ドキュメント", map: [{ path: "chapters", role: "章", entry: "MAP.md" }] });
  await writeRepoEntry(file, "infra", { ...base, name: "infra", role: "基盤", map: [{ path: "terraform", role: "環境の定義" }] });
  await writeRepoEntry(file, "gone", { ...base, name: "gone", role: "誰も登録していない" });
  const local = opts.missingAll ? { app: "/nonexistent/a", docs: "/nonexistent/b", infra: join(repo.dataDir, "project.yaml") } : { app: repo.root, docs: join(docsRepo, "guide"), infra };
  const logFile = join(tempDir(), "codex.jsonl");
  const launched: { repos: HostMount[]; data: string }[] = [];
  const codex = new CodexWorkspaceEngine({
    authVolume: "vol",
    account: new ChatGptAccount(join(tempDir(), "none.json")),
    pathMap: [[repo.root, "/host/app"], [docsRepo, "/host/docsrepo"]],
    ensureImage: false,
    command: ({ repos, data }) => {
      launched.push({ repos, data });
      return ["env", `FAKE_REPO=${repo.root}`, `FAKE_DATA=${repo.dataDir}`, `FAKE_LOG=${logFile}`, process.execPath, FAKE_CODEX];
    },
  });
  const ctx = await openTestProject(repo.dataDir, { codex }, { repos: local });
  const req = await newRequest(ctx, { title: "x", status: "draft", body: "本文" });
  const { id } = await ctx.preflight.start(req.id);
  const run = (await ctx.preflight.wait(req.id, id))!;
  const sent = (await readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const instructions = sent.find((m) => m.method === "thread/start").params.developerInstructions as string;
  const prompt = sent.find((m) => m.method === "turn/start").params.input[0].text as string;
  const saved = await readFile(join(ctx.ws.preflight.runDir(req.id, id), "run.json"), "utf8");
  return { repo, docsRepo, infra, run, launched, instructions, prompt, saved, log: run.log.map((l) => l.text).join("\n") };
}

describe("複数の参照先を Preflight に渡す", () => {
  it("読める参照先を全部 /workspace/<名前> に読むだけでマウントし（パスの対応も効かせる）、見ていないものを記録する", async () => {
    const s = await setup();
    expect(s.run.status).toBe("completed");
    expect(s.launched[0].repos).toEqual([
      { name: "app", host: "/host/app", container: "/workspace/app" },
      { name: "docs", host: "/host/docsrepo/guide", container: "/workspace/docs" },
      { name: "infra", host: s.infra, container: "/workspace/infra" },
    ]);
    expect(s.launched[0].data).toBe("/host/app/.p3");
    // 調べた範囲は P3 が決めて残す（このマシンのパスは入れない）
    expect(s.run.scope).toEqual([
      { name: "app", mount: "app", role: "システム本体", readFirst: true, status: "ok" },
      { name: "docs", mount: "docs", role: "ドキュメント", readFirst: false, status: "ok" },
      { name: "infra", mount: "infra", role: "基盤", readFirst: false, status: "ok" },
      { name: "gone", mount: "gone", role: "誰も登録していない", readFirst: false, status: "unregistered", reason: "このマシンのパスが登録されていません（p3 repo path gone <パス>）" },
    ]);
    expect(JSON.stringify(JSON.parse(s.saved).scope)).not.toContain(s.infra);
    expect(s.log).toContain("見ていない参照先: gone（このマシンのパスが登録されていません（p3 repo path gone <パス>））");
    expect(s.log).toContain("入口のファイルがありません: docs:MAP.md");
    expect(s.log).not.toContain("入口のファイルがありません: app:");
  });

  it("指示文に参照先の名前・役割・コンテナの中のパス・最初に読むもの、見ていないもの、主なフォルダ（入口）を入れる", async () => {
    const { instructions, prompt } = await setup();
    expect(instructions).toContain("- /workspace/app — app（システム本体）［最初に読む］");
    expect(instructions).toContain("- /workspace/docs — docs（ドキュメント）");
    expect(instructions).toContain("読むだけで、書き込めません");
    expect(instructions).toContain("見ていない参照先: gone（");
    expect(instructions).toContain("［最初に読む］の参照先から調べ始めてください");
    // 最初に読む参照先の主なフォルダは評価の前に読むもの、ほかの参照先のものは案内（全部読む指示ではない）
    const first = prompt.indexOf("## 最初に読むもの");
    const guide = prompt.indexOf("## 主なフォルダ（どこから読むかの案内。全部を読む必要はありません。入口があればそこから）");
    expect(first).toBeGreaterThan(-1);
    expect(guide).toBeGreaterThan(first);
    expect(prompt).toContain("評価の前に、必要な範囲で読んでください（入口があればそこから）。");
    const appLine = prompt.indexOf("- /workspace/app/src/server — API（入口 /workspace/app/src/server/main.ts）");
    expect(appLine).toBeGreaterThan(first);
    expect(appLine).toBeLessThan(guide);
    expect(prompt.indexOf("- /workspace/infra/terraform")).toBeGreaterThan(guide);
    expect(prompt).toContain("- /workspace/docs/chapters — 章（入口 /workspace/docs/MAP.md。ファイルがありません）");
    expect(prompt).toContain("- /workspace/infra/terraform — 環境の定義");
  });

  it("どの参照先も読めなくても、資料だけで評価する（制約を伝える）", async () => {
    const s = await setup({ missingAll: true });
    expect(s.run.status).toBe("completed");
    expect(s.launched[0].repos).toEqual([]);
    expect(s.run.scope!.map((x) => x.status)).toEqual(["missing", "missing", "notdir", "unregistered"]);
    expect(s.instructions).toContain("読める参照先（リポジトリ・フォルダ）はありません");
    expect(s.log).toContain("読める参照先がありません。要望と P3 のデータだけで評価します");
  });

  it("本体だけのプロジェクト", async () => {
    const repo = await makeRepo();
    const launched: HostMount[][] = [];
    const codex = new CodexWorkspaceEngine({
      authVolume: "vol",
      account: new ChatGptAccount(join(tempDir(), "none.json")),
      pathMap: [],
      ensureImage: false,
      command: ({ repos }) => {
        launched.push(repos);
        return ["env", `FAKE_REPO=${repo.root}`, `FAKE_DATA=${repo.dataDir}`, "FAKE_LOG=/dev/null", process.execPath, FAKE_CODEX];
      },
    });
    const ctx = await openTestProject(repo.dataDir, { codex });
    const req = await newRequest(ctx, { title: "x", status: "draft" });
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.status).toBe("completed");
    expect(launched[0]).toEqual([{ name: "main", host: repo.root, container: "/workspace/main" }]);
    expect(run.scope).toEqual([{ name: "main", mount: "main", role: "本体", readFirst: true, status: "ok" }]);
  });
});
