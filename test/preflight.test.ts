import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { DEFAULT_IMAGE, dockerCommand } from "@llmcs/codex-workspace";
import { CodexWorkspaceEngine, codexConfigFromEnv, withDataMount } from "../src/server/preflight/codexEngine.ts";
import { writeProjectFile } from "../src/server/store/projectFile.ts";
import { parseAssessment } from "../src/server/preflight/service.ts";
import { makeProject, makeRepo, newRequest, newTask, openTestProject, projectConfig, tempDir } from "./helpers.ts";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

/** 既存の要望（過去の作業）と、これから Preflight する要望 */
async function withRequest(config: Parameters<typeof makeProject>[0] = {}) {
  const p = await makeProject(config);
  const past = await newRequest(p.ctx, { title: "過去の要望", status: "done" });
  const existing = await newTask(p.ctx, past.id, { title: "既存のタスク", areas: ["src/a"] });
  const req = await newRequest(p.ctx, { title: "Add export", status: "draft", areas: ["src/a"], body: "- CSV を書き出す\n- 画面にボタンを置く" });
  return { ...p, req, past, existing };
}

describe("parseAssessment", () => {
  it("LLM の出力の揺れを正規化する（点数は 0〜100、未知の判定は clarify、不正な関係は捨てる）", () => {
    const a = parseAssessment(
      JSON.stringify({
        verdict: "maybe",
        validity: { score: 120, reasons: ["x"] },
        feasibility: { score: "abc" },
        impacts: [{ target: "261001-abcde/T001", type: "impacts", confidence: 3 }, { target: "261001-abcde", type: "nope" }, { type: "impacts" }],
      }),
    );
    expect(a.verdict).toBe("clarify");
    expect(a.validity.score).toBe(100);
    expect(a.feasibility.score).toBe(0);
    expect(a.impacts).toEqual([{ target: "261001-abcde/T001", type: "impacts", reason: "", confidence: 1 }]);
  });

  it("JSON として読めなければ分かるエラーにする", () => {
    expect(() => parseAssessment("{")).toThrow("assessment.json");
  });
});

describe("PreflightService（mock エンジン）", () => {
  it("文脈を選び、評価とタスク案を要望のフォルダに残し、要望を評価済みにする", async () => {
    const { ctx, dataDir, req, existing } = await withRequest();
    const started = await ctx.preflight.start(req.id, { engine: "mock" });
    expect(ctx.ws.requests.get(req.id)?.status).toBe("preflight");
    await expect(ctx.preflight.start(req.id, { engine: "mock" })).rejects.toThrow("実行中");

    const run = (await ctx.preflight.wait(req.id, started.id))!;
    expect(run.status).toBe("completed");
    expect(run.context.map((c) => c.ref)).toContain(existing.ref);
    expect(run.drafts.map((d) => [d.key, d.title])).toEqual([
      ["D1", "CSV を書き出す"],
      ["D2", "画面にボタンを置く"],
    ]);
    const dir = join(dataDir, "requests", req.id, "preflight", run.id);
    for (const f of ["run.json", "request.md", "context.md", "assessment.json", "drafts/D1.md"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(ctx.ws.requests.get(req.id)).toMatchObject({ status: "reviewed", lastPreflight: run.id });
  });

  it("タスク案を直してからタスク化すると、要望の中に連番で作られ、依存・影響の関係とブランチ名が付く", async () => {
    const { ctx, req, existing } = await withRequest();
    const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
    await ctx.preflight.wait(req.id, id);
    await ctx.preflight.updateDraft(req.id, id, "D2", { title: "ボタン（直した）" });

    const tasks = await ctx.preflight.materialize(req.id, id, "human:a");
    expect(tasks.map((t) => [t.id, t.title, t.request])).toEqual([
      ["T001", "CSV を書き出す", req.id],
      ["T002", "ボタン（直した）", req.id],
    ]);
    expect(tasks[1].relations).toEqual([{ type: "depends_on", target: "T001", origin: "preflight" }]);
    const r = ctx.ws.requests.get(req.id)!;
    expect(r.status).toBe("active");
    expect(r.workstream).toEqual({ branch: `req/${req.id}-add-export`, worktree: `.worktrees/${req.id}` });
    // 別の要望のタスクへの影響は絶対参照で要望に記録する
    expect(r.relations).toEqual([expect.objectContaining({ type: "impacts", target: existing.ref, origin: "preflight" })]);
    await expect(ctx.preflight.materialize(req.id, id)).rejects.toThrow("タスク化済み");
  });

  it("採用しない案は飛ばし、日本語だけのタイトルはブランチ名を ID だけにする", async () => {
    const { ctx } = await withRequest();
    const req = await newRequest(ctx, { title: "通知", status: "draft", body: "- 送る\n- 受ける" });
    const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
    await ctx.preflight.wait(req.id, id);
    await ctx.preflight.updateDraft(req.id, id, "D1", { include: false });
    const tasks = await ctx.preflight.materialize(req.id, id);
    expect(tasks.map((t) => [t.id, t.title])).toEqual([["T001", "受ける"]]);
    // D1 を採用しなかったので、D2 → D1 の依存は張られない
    expect(tasks[0].relations).toEqual([]);
    expect(ctx.ws.requests.get(req.id)?.workstream?.branch).toBe(`req/${req.id}`);
  });

  it("タスク化済みの要望で再評価しても、要望のステータスは変えない（進行中のまま）", async () => {
    const { ctx, req } = await withRequest();
    const first = await ctx.preflight.start(req.id);
    await ctx.preflight.wait(req.id, first.id);
    await ctx.preflight.materialize(req.id, first.id);
    expect(ctx.ws.requests.get(req.id)?.status).toBe("active");
    const again = await ctx.preflight.start(req.id);
    expect(ctx.ws.requests.get(req.id)?.status).toBe("active");
    await ctx.preflight.wait(req.id, again.id);
    expect(ctx.ws.requests.get(req.id)).toMatchObject({ status: "active", lastPreflight: again.id });
  });

  it("タスクがある要望でも、追加のタスク化は続きの番号になる", async () => {
    const { ctx, req } = await withRequest();
    await newTask(ctx, req.id, { title: "先に AI が作ったタスク" });
    const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
    await ctx.preflight.wait(req.id, id);
    const tasks = await ctx.preflight.materialize(req.id, id);
    expect(tasks.map((t) => t.id)).toEqual(["T002", "T003"]);
    expect(tasks[1].relations).toEqual([{ type: "depends_on", target: "T002", origin: "preflight" }]);
  });
});

describe("CodexWorkspaceEngine（偽の app-server）", () => {
  function engine(repo: string, data: string, logFile: string, scenario = "", target = "") {
    return new CodexWorkspaceEngine({
      pathMap: [
        [repo, "/host/repo"],
        [data, "/host/data"],
      ],
      ensureImage: false,
      command: (workspace, hostData) => {
        // Docker デーモンから見たパスに変換されている（データディレクトリがリポジトリの中なら、その下）
        expect(workspace).toBe("/host/repo");
        expect(hostData).toBe(data.startsWith(`${repo}/`) ? `/host/repo${data.slice(repo.length)}` : "/host/data");
        return ["env", `FAKE_REPO=${repo}`, `FAKE_DATA=${data}`, `FAKE_LOG=${logFile}`, `FAKE_SCENARIO=${scenario}`, `FAKE_TARGET=${target}`, process.execPath, FAKE_CODEX];
      },
    });
  }

  /** outside: データディレクトリをリポジトリの外に置く（project.yaml の repo は絶対パス） */
  async function setup(scenario = "", { outside = false } = {}) {
    const config = { docs: ["docs/design.md", "README.md"], preflight: { instructions: "外部 SaaS の追加は要相談" } };
    const repo = await makeRepo(config);
    if (outside) {
      repo.dataDir = tempDir("pcube-data-");
      await mkdir(join(repo.dataDir, "requests"));
      await writeProjectFile(join(repo.dataDir, "project.yaml"), projectConfig({ ...config, repo: repo.root }));
    }
    const logFile = join(tempDir(), "codex.jsonl");
    // 既存のタスクは engine を作る前に用意する（偽サーバが参照として書く）
    const pre = await openTestProject(repo.dataDir);
    const past = await newRequest(pre, { title: "過去", status: "done" });
    const existing = await newTask(pre, past.id, { title: "既存", areas: ["src/a"] });
    const ctx = await openTestProject(repo.dataDir, { codex: engine(repo.root, repo.dataDir, logFile, scenario, existing.ref) });
    const req = await newRequest(ctx, { title: "x", status: "draft", areas: ["src/a"], body: "本文" });
    const sent = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { ctx, req, existing, sent };
  }

  it("ドキュメントと評価の観点を指示に含め、Codex が書いたファイルを取り込んでタスク化できる", async () => {
    const { ctx, req, existing, sent } = await setup();
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run).toMatchObject({ engine: "codex", status: "completed" });
    expect(run.assessment?.feasibility.score).toBe(100);
    expect(run.assessment?.impacts.map((i) => i.target)).toEqual([existing.ref, "261001-nopee/T009"]);
    expect(run.drafts.map((d) => [d.key, d.dependsOn])).toEqual([
      ["D1", []],
      ["D2", ["D1"]],
    ]);
    expect(run.log.map((l) => l.text)).toEqual(expect.arrayContaining(["$ rg -l foo", "書きました", "使用量: 5h窓 10% / 168h窓 20%"]));

    const messages = sent();
    const thread = messages.find((m) => m.method === "thread/start").params;
    expect(thread).toMatchObject({ cwd: "/workspace", sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(thread.developerInstructions).toContain("外部 SaaS の追加は要相談");
    expect(thread.developerInstructions).toContain(`/data/requests/${req.id}/preflight/${id}/`);
    const prompt = messages.find((m) => m.method === "turn/start").params.input[0].text;
    expect(prompt).toContain("## 最初に読むドキュメント");
    expect(prompt).toContain("- docs/design.md");
    expect(prompt).toContain(existing.ref); // 文脈として選ばれた既存タスク
    expect(prompt).toContain("drafts/D1.md");

    // タスク化: 存在しない相手への関係・影響は捨てる
    const tasks = await ctx.preflight.materialize(req.id, id);
    expect(tasks[1].relations).toEqual(
      expect.arrayContaining([
        { type: "relates_to", target: existing.ref, origin: "preflight" },
        { type: "depends_on", target: "T001", origin: "preflight" },
      ]),
    );
    expect(ctx.ws.requests.get(req.id)?.relations.map((r) => r.target)).toEqual([existing.ref]);
  });

  it("再評価では前回の評価・タスク案とその後のメモをプロンプトに含める", async () => {
    const { ctx, req, sent } = await setup();
    const first = await ctx.preflight.start(req.id);
    await ctx.preflight.wait(req.id, first.id);
    const turns = () => sent().filter((m) => m.method === "turn/start").map((m) => m.params.input[0].text as string);
    expect(turns()[0]).not.toContain("前回からの引き継ぎ");

    await ctx.preflight.updateDraft(req.id, first.id, "D2", { include: false });
    await ctx.preflight.addNote(req.id, "対象は CLI だけでよい", "human:a");
    const second = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, second.id))!;
    expect(run).toMatchObject({ status: "completed", previous: first.id, notes: [expect.any(String)] });
    const prompt = turns()[1];
    expect(prompt).toContain(`## 前回からの引き継ぎ（/data/requests/${req.id}/preflight/${second.id}/carryover.md`);
    expect(prompt).toContain("偽の評価"); // 前回の評価の要約
    expect(prompt).toContain("### D2 本体（不採用 / 依存: D1）"); // 人が外した案
    expect(prompt).toContain("対象は CLI だけでよい");
    expect(prompt).toContain("（human:a, ");
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

  it("データディレクトリがリポジトリの外にあっても、/data に書かせて取り込む", async () => {
    const { ctx, req, sent } = await setup("stray", { outside: true });
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run).toMatchObject({ status: "completed" });
    expect(run.drafts.map((d) => d.key)).toEqual(["D1", "D2"]);
    const prompt = sent().find((m) => m.method === "turn/start").params.input[0].text;
    expect(prompt).toContain(`/data/requests/${req.id}/preflight/${id}/assessment.json`);
    // run ディレクトリの中は想定内、リポジトリの変更だけを警告する
    expect(run.log.filter((l) => l.text.startsWith("想定外の変更")).map((l) => l.text)).toEqual([expect.stringContaining("想定外の変更: src/main.ts")]);
  });

  it("codex-workspace の docker run にデータディレクトリのマウントを足す", () => {
    const command = withDataMount(dockerCommand("/host/repo", { authVolume: "vol" }), "/host/repo", "/host/data");
    const mounts = command.flatMap((a, i) => (command[i - 1] === "--mount" ? [a] : []));
    expect(mounts).toEqual(expect.arrayContaining(["type=bind,src=/host/repo,dst=/workspace", "type=bind,src=/host/data,dst=/data"]));
    expect(command.indexOf("type=bind,src=/host/data,dst=/data")).toBeLessThan(command.indexOf(DEFAULT_IMAGE));
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
      expect(cfg.pathMap).toEqual([
        ["/workspaces", "/root/workspaces"],
        ["/a", "/b"],
      ]);
      const e = new CodexWorkspaceEngine(cfg);
      expect(e.hostPath("/workspaces/pcube")).toBe("/root/workspaces/pcube");
      expect(e.hostPath("/workspacesX")).toBe("/workspacesX");
    } finally {
      process.env = keep;
    }
  });
});
