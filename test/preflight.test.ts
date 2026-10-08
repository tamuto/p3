import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexWorkspaceEngine, codexConfigFromEnv } from "../src/server/preflight/codexEngine.ts";
import { parseAssessment } from "../src/server/preflight/service.ts";
import { makeProject, makeRepo, newTask, openTestProject, tempDir } from "./helpers.ts";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

async function withRequest(config: Parameters<typeof makeProject>[0] = {}) {
  const p = await makeProject(config);
  await newTask(p.ctx, { title: "既存のタスク", areas: ["src/a"] });
  const req = await p.ctx.ws.requests.create(
    { title: "Add export", status: "draft", areas: ["src/a"], relations: [], body: "- CSV を書き出す\n- 画面にボタンを置く" },
    "t",
  );
  return { ...p, req };
}

describe("parseAssessment", () => {
  it("LLM の出力の揺れを正規化する（点数は 0〜100、未知の判定は clarify、不正な関係は捨てる）", () => {
    const a = parseAssessment(
      JSON.stringify({
        verdict: "maybe",
        validity: { score: 120, reasons: ["x"] },
        feasibility: { score: "abc" },
        impacts: [
          { target: "TASK-0001", type: "impacts", confidence: 3 },
          { target: "TASK-0002", type: "nope" },
          { type: "impacts" },
        ],
      }),
    );
    expect(a.verdict).toBe("clarify");
    expect(a.validity.score).toBe(100);
    expect(a.feasibility.score).toBe(0);
    expect(a.impacts).toEqual([{ target: "TASK-0001", type: "impacts", reason: "", confidence: 1 }]);
  });

  it("JSON として読めなければ分かるエラーにする", () => {
    expect(() => parseAssessment("{")).toThrow("assessment.json");
  });
});

describe("PreflightService（mock エンジン）", () => {
  it("文脈を選び、評価とタスク案をファイルに残し、要望を評価済みにする", async () => {
    const { ctx, dataDir, req } = await withRequest();
    const started = await ctx.preflight.start(req.id, { engine: "mock" });
    expect(ctx.ws.requests.get(req.id)?.status).toBe("preflight");
    await expect(ctx.preflight.start(req.id, { engine: "mock" })).rejects.toThrow("実行中");

    const run = (await ctx.preflight.wait(req.id, started.id))!;
    expect(run.status).toBe("completed");
    expect(run.context.map((c) => c.id)).toContain("TASK-0001");
    expect(run.drafts.map((d) => d.title)).toEqual(["CSV を書き出す", "画面にボタンを置く"]);
    const dir = join(dataDir, "preflight", req.id, run.id);
    for (const f of ["run.json", "request.md", "context.md", "assessment.json", "drafts/T1.md"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(ctx.ws.requests.get(req.id)).toMatchObject({ status: "reviewed", lastPreflight: run.id });
  });

  it("タスク案を直してからタスク化すると、依存・影響の関係とブランチ名が付く", async () => {
    const { ctx, req } = await withRequest();
    const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
    await ctx.preflight.wait(req.id, id);
    await ctx.preflight.updateDraft(req.id, id, "T2", { title: "ボタン（直した）", estimateDays: 0.5 });

    const tasks = await ctx.preflight.materialize(req.id, id, "human:a");
    expect(tasks.map((t) => [t.title, t.estimate, t.request])).toEqual([
      ["CSV を書き出す", 1, req.id],
      ["ボタン（直した）", 0.5, req.id],
    ]);
    expect(tasks[1].relations).toEqual([{ type: "depends_on", target: tasks[0].id, origin: "preflight" }]);
    const r = ctx.ws.requests.get(req.id)!;
    expect(r.status).toBe("accepted");
    expect(r.workstream).toEqual({ branch: "req/REQ-0001-add-export", worktree: `.worktrees/${req.id}` });
    expect(r.relations).toEqual([expect.objectContaining({ type: "impacts", target: "TASK-0001", origin: "preflight" })]);
    await expect(ctx.preflight.materialize(req.id, id)).rejects.toThrow("タスク化済み");
  });

  it("採用しない案は飛ばし、日本語だけのタイトルはブランチ名を ID だけにする", async () => {
    const { ctx } = await withRequest();
    const req = await ctx.ws.requests.create({ title: "通知", status: "draft", areas: [], relations: [], body: "- 送る\n- 受ける" }, "t");
    const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
    await ctx.preflight.wait(req.id, id);
    await ctx.preflight.updateDraft(req.id, id, "T1", { include: false });
    const tasks = await ctx.preflight.materialize(req.id, id);
    expect(tasks.map((t) => t.title)).toEqual(["受ける"]);
    // T1 を採用しなかったので、T2 → T1 の依存は張られない
    expect(tasks[0].relations).toEqual([]);
    expect(ctx.ws.requests.get(req.id)?.workstream?.branch).toBe(`req/${req.id}`);
  });
});

describe("CodexWorkspaceEngine（偽の app-server）", () => {
  function engine(repo: string, logFile: string, scenario = "") {
    return new CodexWorkspaceEngine({
      pathMap: [[repo, "/host/repo"]],
      ensureImage: false,
      command: (workspace) => {
        expect(workspace).toBe("/host/repo"); // Docker デーモンから見たパスに変換されている
        return ["env", `FAKE_REPO=${repo}`, `FAKE_LOG=${logFile}`, `FAKE_SCENARIO=${scenario}`, process.execPath, FAKE_CODEX];
      },
    });
  }

  async function setup(scenario = "") {
    const repo = await makeRepo({
      docs: ["docs/design.md", "README.md"],
      preflight: { instructions: "外部 SaaS の追加は要相談" },
    });
    const logFile = join(tempDir(), "codex.jsonl");
    const ctx = await openTestProject(repo.dataDir, { codex: engine(repo.root, logFile, scenario) });
    await newTask(ctx, { title: "既存", areas: ["src/a"] });
    const req = await ctx.ws.requests.create({ title: "x", status: "draft", areas: ["src/a"], relations: [], body: "本文" }, "t");
    const sent = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { ctx, req, sent };
  }

  it("ドキュメントと評価の観点を指示に含め、Codex が書いたファイルを取り込む", async () => {
    const { ctx, req, sent } = await setup();
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.engine).toBe("codex");
    expect(run.status).toBe("completed");
    expect(run.assessment?.feasibility.score).toBe(100);
    expect(run.assessment?.impacts).toHaveLength(1);
    expect(run.drafts.map((d) => [d.key, d.dependsOn])).toEqual([["T1", []], ["T2", ["T1"]]]);
    expect(run.log.map((l) => l.text)).toEqual(expect.arrayContaining(["$ rg -l foo", "書きました", "使用量: 5h窓 10% / 168h窓 20%"]));

    const messages = sent();
    const thread = messages.find((m) => m.method === "thread/start").params;
    expect(thread).toMatchObject({ cwd: "/workspace", sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(thread.developerInstructions).toContain("外部 SaaS の追加は要相談");
    expect(thread.developerInstructions).toContain(`.pcube/preflight/${req.id}/${id}/`);
    const prompt = messages.find((m) => m.method === "turn/start").params.input[0].text;
    expect(prompt).toContain("## 最初に読むドキュメント");
    expect(prompt).toContain("- docs/design.md");
    expect(prompt).toContain("TASK-0001"); // 文脈として選ばれた既存タスク
  });

  it("run ディレクトリの外の変更は警告としてログに残す", async () => {
    const { ctx, req } = await setup("stray");
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.status).toBe("completed");
    expect(run.log).toContainEqual(expect.objectContaining({ kind: "error", text: expect.stringContaining("想定外の変更: src/main.ts") }));
  });

  it("使用量の上限に当たっていれば頼まずに失敗させ、要望を下書きに戻す", async () => {
    const { ctx, req, sent } = await setup("usage");
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("使用量上限");
    expect(sent().some((m) => m.method === "turn/start")).toBe(false);
    expect(ctx.ws.requests.get(req.id)?.status).toBe("draft");
  });

  it("評価のファイルが壊れていれば失敗にする", async () => {
    const { ctx, req } = await setup("broken");
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("assessment.json");
  });

  it("データディレクトリがリポジトリの外にあれば始めない", async () => {
    const dataDir = (await makeRepo({ repo: "../../somewhere-else" })).dataDir;
    const ctx = await openTestProject(dataDir, { codex: engine("/nowhere", "/dev/null") });
    const req = await ctx.ws.requests.create({ title: "x", status: "draft", areas: [], relations: [], body: "" }, "t");
    const { id } = await ctx.preflight.start(req.id);
    const run = await ctx.preflight.wait(req.id, id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("リポジトリの外");
  });

  it("認証の設定が無ければ Codex エンジンを有効にしない。パス対応を読む", () => {
    const keep = { ...process.env };
    try {
      delete process.env.PCUBE_CODEX_AUTH_VOLUME;
      delete process.env.PCUBE_CODEX_AUTH_FILE;
      expect(codexConfigFromEnv()).toBeUndefined();
      process.env.PCUBE_CODEX_AUTH_VOLUME = "vol";
      process.env.PCUBE_CODEX_PATH_MAP = "/workspaces=/root/workspaces,/a=/b";
      const cfg = codexConfigFromEnv()!;
      expect(cfg.pathMap).toEqual([["/workspaces", "/root/workspaces"], ["/a", "/b"]]);
      const e = new CodexWorkspaceEngine(cfg);
      expect(e.hostPath("/workspaces/pcube")).toBe("/root/workspaces/pcube");
      expect(e.hostPath("/workspacesX")).toBe("/workspacesX");
    } finally {
      process.env = keep;
    }
  });
});
