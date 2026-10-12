import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { DEFAULT_IMAGE, dockerCommand } from "@infodb/codex-workspace";
import { progress } from "../src/core/ops.ts";
import { ChatGptAccount } from "../src/core/chatgpt/account.ts";
import { OPENAI_ENDPOINTS } from "../src/core/chatgpt/oauth.ts";
import { saveConnection } from "../src/core/chatgpt/store.ts";
import { redact } from "../src/core/redact.ts";
import { CodexWorkspaceEngine, codexConfig, withMounts } from "../src/core/preflight/codexEngine.ts";
import { resolveMachineSettings } from "../src/core/machineSettings.ts";
import { supersededMarks } from "../src/core/supersede.ts";
import { parseAssessment } from "../src/core/preflight/service.ts";
import type { Renderer } from "../src/core/preflight/uiRender.ts";
import { RenderError } from "../src/core/preflight/render.ts";
import { wireframePng } from "../src/core/preflight/wireframe.ts";
import { makeProject, MAIN_REF, makeRepo, newRequest, newTask, openTestProject, tempDir, writeTestProject } from "./helpers.ts";

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

    const { tasks } = await ctx.preflight.materialize(req.id, id, "human:a");
    expect(tasks.map((t) => [t.id, t.title, t.request])).toEqual([
      ["T001", "CSV を書き出す", req.id],
      ["T002", "ボタン（直した）", req.id],
    ]);
    expect(tasks[1].relations).toEqual([{ type: "depends_on", target: "T001", origin: "preflight" }]);
    const r = ctx.ws.requests.get(req.id)!;
    expect(r.status).toBe("active");
    expect(r.workstreams).toEqual({ main: { branch: `req/${req.id}-add-export` } });
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
    const { tasks } = await ctx.preflight.materialize(req.id, id);
    expect(tasks.map((t) => [t.id, t.title])).toEqual([["T001", "受ける"]]);
    // D1 を採用しなかったので、D2 → D1 の依存は張られない
    expect(tasks[0].relations).toEqual([]);
    expect(ctx.ws.requests.get(req.id)?.workstreams?.main.branch).toBe(`req/${req.id}`);
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
    const { tasks } = await ctx.preflight.materialize(req.id, id);
    expect(tasks.map((t) => t.id)).toEqual(["T002", "T003"]);
    expect(tasks[1].relations).toEqual([{ type: "depends_on", target: "T002", origin: "preflight" }]);
  });
});

describe("CodexWorkspaceEngine（偽の app-server）", () => {
  function engine(repo: string, data: string, logFile: string, scenario = "", target = "", render?: Renderer) {
    return new CodexWorkspaceEngine({
      render,
      authVolume: "vol", // 旧来の auth.json（ChatGPT には接続していない）
      account: new ChatGptAccount(join(tempDir(), "chatgpt.json")),
      pathMap: [
        [repo, "/host/repo"],
        [data, "/host/data"],
      ],
      ensureImage: false,
      command: ({ repos, data: hostData }) => {
        // Docker デーモンから見たパスに変換されている（データディレクトリがリポジトリの中なら、その下）
        expect(repos).toEqual([{ name: "main", host: "/host/repo", container: "/workspace/main" }]);
        expect(hostData).toBe(data.startsWith(`${repo}/`) ? `/host/repo${data.slice(repo.length)}` : "/host/data");
        return ["env", `FAKE_REPO=${repo}`, `FAKE_DATA=${data}`, `FAKE_LOG=${logFile}`, `FAKE_SCENARIO=${scenario}`, `FAKE_TARGET=${target}`, process.execPath, FAKE_CODEX];
      },
    });
  }

  /** outside: データディレクトリをリポジトリの外に置く（project.yaml の repo は絶対パス） */
  async function setup(scenario = "", { outside = false, render }: { outside?: boolean; render?: Renderer } = {}) {
    const config = { repos: [{ ...MAIN_REF, map: [{ path: "docs", role: "設計", entry: "docs/design.md" }, { path: "README.md", role: "README" }] }], preflight: { instructions: "外部 SaaS の追加は要相談" } };
    const repo = await makeRepo(config);
    if (outside) {
      repo.dataDir = tempDir("p3-data-");
      await mkdir(join(repo.dataDir, "requests"));
      await writeTestProject(repo.dataDir, config);
    }
    const local = { main: repo.root };
    const logFile = join(tempDir(), "codex.jsonl");
    // 既存のタスクは engine を作る前に用意する（偽サーバが参照として書く）
    const pre = await openTestProject(repo.dataDir, undefined, { repos: local });
    const past = await newRequest(pre, { title: "過去", status: "done" });
    const existing = await newTask(pre, past.id, { title: "既存", areas: ["src/a"] });
    const ctx = await openTestProject(repo.dataDir, { codex: engine(repo.root, repo.dataDir, logFile, scenario, existing.ref, render) }, { repos: local });
    const req = await newRequest(ctx, { title: "x", status: "draft", areas: ["src/a"], body: "本文" });
    const sent = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { ctx, req, existing, sent };
  }

  /** 描画の代わり: 受け取った原稿を記録し、幅に合わせた PNG を書く */
  function fakeRender(calls: { id: string; html: string; width: number }[] = []): Renderer {
    return async (jobs, _work, outDir) => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(outDir, { recursive: true });
      calls.push(...jobs);
      return Promise.all(
        jobs.map(async (j) => {
          await writeFile(join(outDir, `${j.id}.png`), wireframePng(j.width, 300, [[0, 0, 100, 20, 0x334155]]));
          return { id: j.id, ok: true, file: join(outDir, `${j.id}.png`), blocked: [] };
        }),
      );
    };
  }

  it("画面資料: 原稿の書き方を指示し、Codex の後に P3 が描画して取り込む（Codex は画像を見ていない）", async () => {
    const calls: { id: string; html: string; width: number }[] = [];
    const { ctx, req, sent } = await setup("ui", { render: fakeRender(calls) });
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    const prompt = sent().find((m) => m.method === "turn/start").params.input[0].text as string;
    expect(prompt).toContain(`/data/requests/${req.id}/preflight/${id}/ui/index.json`);
    expect(prompt).toContain("画像を見たとも書かないでください");
    expect(prompt).toContain("スクリプト・onclick などの属性・外のファイルや URL の参照");
    expect(calls).toEqual([{ id: "U1", html: expect.stringContaining("絞り込む"), width: 1024 }]);
    expect(run.ui).toMatchObject({ status: "ready", targets: ["D2"], items: [{ id: "U1", file: "U1.png", html: "src/U1.html", drafts: ["D2"], width: 1024, rendered: { by: "p3" } }] });
    expect(run.assessment!.verdict).toBe("go");
    // 原稿と画像を照合できる（同じ run の ui/）
    const runDir = ctx.ws.preflight.runDir(req.id, id);
    expect(readFileSync(join(runDir, "ui", "src", "U1.html"), "utf8")).toContain("絞り込む");
    expect((await ctx.preflight.uiImage(req.id, id, "U1")).type).toBe("image/png");
    // run の中だけを書いたので、想定外の変更の警告は出ない
    expect(run.log.some((l) => l.text.startsWith("想定外の変更"))).toBe(false);
  });

  it("画面資料: 画面を伴わなければ不要の理由を残し、描画しない", async () => {
    const calls: { id: string; html: string; width: number }[] = [];
    const { ctx, req } = await setup("nonui", { render: fakeRender(calls) });
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.ui).toMatchObject({ status: "not_needed", reason: "CLI だけの変更で画面は変わらない" });
    expect(calls).toEqual([]);
  });

  it("画面資料: 描画に失敗しても評価は残し、足りないとして clarify にする", async () => {
    const { ctx, req } = await setup("ui", {
      render: async () => {
        throw new RenderError("Docker デーモンにつながりません", "docker");
      },
    });
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.status).toBe("completed");
    expect(run.drafts).toHaveLength(2);
    expect(run.assessment!.verdict).toBe("clarify");
    expect(run.ui).toMatchObject({ status: "missing", needed: true, verdictAdjusted: { from: "go", to: "clarify" } });
    expect(run.ui!.problems.join("\n")).toContain("U1: 画像がありません（描画できませんでした: Docker デーモンにつながりません）");
  });

  it("画面資料: 描画中に取り消しても評価は残し、画像は足りないとする", async () => {
    let started!: () => void;
    const rendering = new Promise<void>((r) => (started = r));
    const { ctx, req } = await setup("ui", {
      render: (_jobs, _w, _o, opts) =>
        new Promise((_, reject) => {
          started();
          opts?.signal?.addEventListener("abort", () => reject(new RenderError("描画を取り消しました", "cancel")));
        }),
    });
    const { id } = await ctx.preflight.start(req.id);
    await rendering;
    ctx.preflight.cancel(id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.status).toBe("completed");
    expect(run.assessment).toBeDefined();
    expect(run.ui?.status).toBe("missing");
    expect(run.ui!.problems.join("\n")).toContain("描画を取り消しました");
  });

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
    // 最初に読む参照先の主なフォルダは、以前のプロジェクトの docs と同じく評価の前に読ませる（入口は任意）
    expect(prompt).toContain("## 最初に読むもの\nプロジェクトの方針・用語・設計などが書かれています。評価の前に、必要な範囲で読んでください（入口があればそこから）。");
    expect(prompt).toContain("- /workspace/main/docs — 設計（入口 /workspace/main/docs/design.md");
    expect(prompt).toContain("- /workspace/main/README.md — README\n");
    expect(prompt).not.toContain("## 主なフォルダ"); // 案内だけの参照先は無い
    expect(prompt).toContain(existing.ref); // 文脈として選ばれた既存タスク
    expect(prompt).toContain("drafts/D1.md");

    // タスク化: 存在しない相手への関係・影響は捨てる
    const { tasks } = await ctx.preflight.materialize(req.id, id);
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

  it("再評価から置き換えまで: 前回とメモを引き継ぎ、置き換えられるタスクを選んでアーカイブし、番号は再利用しない", async () => {
    // データはリポジトリの外。置き換えの参照は2回目の評価からだけ書かせる
    const repo = await makeRepo();
    const dataDir = tempDir("p3-data-");
    await mkdir(join(dataDir, "requests"));
    await writeTestProject(dataDir);
    let supersede = "";
    const codex = new CodexWorkspaceEngine({
      authVolume: "vol",
      account: new ChatGptAccount(join(tempDir(), "chatgpt.json")),
      pathMap: [],
      ensureImage: false,
      command: () => ["env", `FAKE_REPO=${repo.root}`, `FAKE_DATA=${dataDir}`, "FAKE_LOG=/dev/null", `FAKE_SUPERSEDE=${supersede}`, process.execPath, FAKE_CODEX],
    });
    const ctx = await openTestProject(dataDir, { codex }, { repos: { main: repo.root } });
    const req = await newRequest(ctx, { title: "x", status: "draft", body: "本文" });
    const run = async () => {
      const { id } = await ctx.preflight.start(req.id, { actor: "human:a" });
      return (await ctx.preflight.wait(req.id, id))!;
    };

    const first = await run();
    expect((await ctx.preflight.materialize(req.id, first.id)).tasks.map((t) => t.id)).toEqual(["T001", "T002"]);
    const doneTask = await ctx.ws.tasksOf(req.id).update("T002", { status: "done", outputs: ["https://example.com/pull/1"] });

    supersede = `${req.id}/T001`;
    await ctx.preflight.addNote(req.id, "T001 は新しい方式にする", "human:a");
    const second = await run();
    expect(second).toMatchObject({ status: "completed", previous: first.id, notes: [expect.any(String)] });
    const preview = await ctx.preflight.previewMaterialize(req.id, second.id);
    expect(preview.candidates.map((c) => [c.id, c.reasons.map((r) => r.source)])).toEqual([["T001", ["impact", "draft"]]]); // 完了した T002 は候補にしない

    const r = await ctx.preflight.materialize(req.id, second.id, "human:a", { archive: [{ id: "T001", rev: preview.candidates[0].rev }] });
    expect(r).toMatchObject({ archived: ["T001"], kept: [] });
    expect(r.tasks.map((t) => t.id)).toEqual(["T003", "T004"]);
    // アーカイブしたタスクには印を付けず、進捗にも数えない。完了したタスクの成果物と rev は変わらない
    expect(supersededMarks(ctx.ws).size).toBe(0);
    expect(progress(ctx).find((p) => p.request.id === req.id)).toMatchObject({ total: 3, done: 1 });
    expect(ctx.ws.tasksOf(req.id).get("T002")).toMatchObject({ rev: doneTask.rev, outputs: ["https://example.com/pull/1"] });

    // 最大番号をアーカイブしても、次の番号は重ならない
    await ctx.ws.tasksOf(req.id).archive("T004");
    expect((await ctx.ws.tasksOf(req.id).create({ title: "追加" })).id).toBe("T005");
  });

  it("run ディレクトリの外の変更は警告としてログに残す", async () => {
    const { ctx, req } = await setup("stray");
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.status).toBe("completed");
    expect(run.log).toContainEqual(expect.objectContaining({ kind: "error", text: expect.stringContaining("想定外の変更: main:src/main.ts") }));
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
    expect(run.log.filter((l) => l.text.startsWith("想定外の変更")).map((l) => l.text)).toEqual([expect.stringContaining("想定外の変更: main:src/main.ts")]);
  });

  it("codex-workspace の docker run を、/workspace は tmpfs・参照先は /workspace/<名前> に読むだけ・データは /data にする", () => {
    const repos = [
      { name: "app", host: "/host/app", container: "/workspace/app" },
      { name: "docs", host: "/host/docsrepo/guide", container: "/workspace/docs" },
      { name: "infra", host: "/host/infra", container: "/workspace/infra" },
    ];
    const command = withMounts(dockerCommand("/p3-placeholder", { authVolume: "vol" }), repos, "/host/data");
    const mounts = command.flatMap((a: string, i: number) => (command[i - 1] === "--mount" ? [a] : []));
    expect(mounts).toEqual([
      "type=tmpfs,dst=/workspace",
      "type=bind,src=/host/app,dst=/workspace/app,readonly",
      "type=bind,src=/host/docsrepo/guide,dst=/workspace/docs,readonly",
      "type=bind,src=/host/infra,dst=/workspace/infra,readonly",
      "type=bind,src=/host/data,dst=/data",
      expect.stringContaining("volume"),
    ]);
    expect(command.join(" ")).not.toContain("p3-placeholder");
    expect(command.indexOf("type=bind,src=/host/data,dst=/data")).toBeLessThan(command.indexOf(DEFAULT_IMAGE));
    expect(withMounts(dockerCommand("/p3-placeholder", { authVolume: "vol" }), [], "/host/data")).toContain("type=tmpfs,dst=/workspace");
  });

  it("マシンの設定から旧来の認証・旧来の明示・パス対応を読む", () => {
    const settings = (env: Record<string, string>) => resolveMachineSettings({ settings: {} }, env);
    expect(codexConfig(settings({}))).toMatchObject({ authVolume: undefined, authFile: undefined, forceLegacy: false, ensureImage: true });
    expect(codexConfig(settings({ P3_CODEX_AUTH: "legacy" })).forceLegacy).toBe(true);
    const cfg = codexConfig(settings({ P3_CODEX_AUTH_VOLUME: "vol", P3_CODEX_PATH_MAP: "/workspaces=/root/workspaces,/a=/b" }));
    expect(cfg.authVolume).toBe("vol");
    expect(cfg.pathMap).toEqual([
      ["/workspaces", "/root/workspaces"],
      ["/a", "/b"],
    ]);
    const e = new CodexWorkspaceEngine(cfg);
    expect(e.hostPath("/workspaces/p3")).toBe("/root/workspaces/p3");
    expect(e.hostPath("/workspacesX")).toBe("/workspacesX");
  });
});

describe("CodexWorkspaceEngine の認証（Sign in with ChatGPT）", () => {
  const PLAN = ["openid", "offline_access", "chatgpt.tokens.use.direct"];
  /** 接続を書いた ChatGptAccount（refresh は fetch で決める） */
  async function account(opts: { scopes?: string[]; expiresInMs?: number; tokens?: boolean; refresh?: () => Response } = {}) {
    const file = join(tempDir(), "chatgpt.json");
    if (opts.tokens !== false) {
      await saveConnection(
        {
          hostId: "urn:uuid:h",
          clientId: "oaiapp_1",
          account: { sub: "u", email: "a@example.com" },
          tokens: {
            accessToken: "at-secret",
            refreshToken: "rt-secret",
            expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)).toISOString(),
            scopes: opts.scopes ?? PLAN,
            savedAt: new Date().toISOString(),
          },
        },
        file,
      );
    }
    const fetch = (async () => opts.refresh?.() ?? new Response("{}", { status: 500 })) as typeof globalThis.fetch;
    return new ChatGptAccount(file, { endpoints: OPENAI_ENDPOINTS, fetch, now: Date.now });
  }

  it("選び方: 旧来の明示 > ChatGPT の接続 > 旧来だけ > 無し（サインインを案内）", async () => {
    const connected = await account();
    const none = await account({ tokens: false });
    expect(await new CodexWorkspaceEngine({ authVolume: "v", forceLegacy: true, account: connected, pathMap: [], ensureImage: false }).auth()).toEqual({ mode: "legacy" });
    expect(await new CodexWorkspaceEngine({ authVolume: "v", account: connected, pathMap: [], ensureImage: false }).auth()).toEqual({ mode: "chatgpt", email: "a@example.com" });
    expect(await new CodexWorkspaceEngine({ authFile: "/f", account: none, pathMap: [], ensureImage: false }).auth()).toEqual({ mode: "legacy" });
    const nothing = await new CodexWorkspaceEngine({ account: none, pathMap: [], ensureImage: false }).auth();
    expect(nothing).toMatchObject({ mode: "none", reason: expect.stringContaining("サインインしてください") });
    const noPlan = await new CodexWorkspaceEngine({ account: await account({ scopes: ["openid"] }), pathMap: [], ensureImage: false }).auth();
    expect(noPlan).toMatchObject({ mode: "none", reason: expect.stringContaining("許可されていません") });
  });

  it("未接続なら状態で理由を出し、接続のファイルが変われば確かめ直す（serve に反映）", async () => {
    const acc = await account({ tokens: false });
    const engine = new CodexWorkspaceEngine({ account: acc, pathMap: [], ensureImage: false });
    expect(await engine.status()).toMatchObject({ ok: false, auth: "none", detail: expect.stringContaining("サインインしてください") });
    // CLI で（プラン利用の同意なしに）サインインした
    const file = (acc as unknown as { file: string }).file;
    await new Promise((r) => setTimeout(r, 20));
    await saveConnection({ hostId: "h", clientId: "c", account: { sub: "u" }, tokens: { accessToken: "a", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: ["openid"], savedAt: "" } }, file);
    expect(await engine.status()).toMatchObject({ ok: false, detail: expect.stringContaining("許可されていません") });
  });

  it("ChatGPT プランでは access token を環境変数で渡し、P3 として名乗り、旧来の使用量の API を呼ばない", async () => {
    const repo = await makeRepo();
    const logFile = join(tempDir(), "codex.jsonl");
    let mode = "";
    const codex = new CodexWorkspaceEngine({
      authVolume: "vol", // 旧来の設定があっても、接続していれば ChatGPT
      account: await account(),
      pathMap: [],
      ensureImage: false,
      command: ({ auth }) => {
        mode = auth;
        return ["env", `FAKE_REPO=${repo.root}`, `FAKE_DATA=${repo.dataDir}`, `FAKE_LOG=${logFile}`, process.execPath, FAKE_CODEX];
      },
    });
    const ctx = await openTestProject(repo.dataDir, { codex });
    const req = await newRequest(ctx, { title: "x", status: "draft", body: "本文" });
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.status).toBe("completed");
    expect(mode).toBe("chatgpt");
    const sent = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(sent.find((m) => "accessToken" in m)).toEqual({ clientInfo: { name: "infodb_p3", title: "infodb p3", version: expect.any(String) }, accessToken: "at-secret" });
    expect(sent.some((m) => m.method === "account/rateLimits/read")).toBe(false);
    expect(run.log.map((l) => l.text)).toEqual(expect.arrayContaining([expect.stringContaining("ChatGPT プラン（a@example.com）"), expect.stringContaining("取得できません")]));
    expect(JSON.stringify(run)).not.toContain("at-secret"); // run の記録にトークンを残さない
  });

  it("Codex のエラーがトークンの一部や全部を含んでも、ログとエラーには残さない", async () => {
    const repo = await makeRepo();
    const codex = new CodexWorkspaceEngine({
      account: await account(),
      pathMap: [],
      ensureImage: false,
      command: () => ["env", `FAKE_REPO=${repo.root}`, `FAKE_DATA=${repo.dataDir}`, "FAKE_LOG=/dev/null", "FAKE_SCENARIO=unauthorized", process.execPath, FAKE_CODEX],
    });
    const ctx = await openTestProject(repo.dataDir, { codex });
    const req = await newRequest(ctx, { title: "x", status: "draft" });
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("401 Unauthorized");
    expect(run.error).toContain("[伏せました]");
    const saved = readFileSync(join(ctx.ws.preflight.runDir(req.id, id), "run.json"), "utf8");
    for (const text of [JSON.stringify(run), saved]) {
      expect(text).not.toContain("at-secret");
      expect(text).not.toContain("at-secre"); // 先頭 8 文字
      expect(text).not.toMatch(/\*\*\*ret/); // 末尾 3 文字
    }
  });

  it("期限切れで更新できなければ失敗させ、Mock に落とさない", async () => {
    const repo = await makeRepo();
    const codex = new CodexWorkspaceEngine({
      account: await account({ expiresInMs: -1000, refresh: () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) }),
      pathMap: [],
      ensureImage: false,
      command: () => {
        throw new Error("起動してはいけない");
      },
    });
    const ctx = await openTestProject(repo.dataDir, { codex });
    const req = await newRequest(ctx, { title: "x", status: "draft" });
    const { id } = await ctx.preflight.start(req.id);
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run).toMatchObject({ status: "failed", engine: "codex", error: expect.stringContaining("サインインし直してください") });
  });
});

describe("トークンらしいものを伏せる", () => {
  it("Codex が一部を見せるキー・JWT・Bearer の値・渡した値を伏せ、ほかは変えない", () => {
    expect(redact("Incorrect API key provided: dummy-to***-123. You can find…")).toBe("Incorrect API key provided: [伏せました]. You can find…");
    expect(redact("id=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl end")).toBe("id=[伏せました] end");
    expect(redact("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [伏せました]");
    expect(redact("token is opaque-value-123", ["opaque-value-123"])).toBe("token is [伏せました]");
    expect(redact("通常のログ: rg -l foo (exit 0) / 5h窓 10%")).toBe("通常のログ: rg -l foo (exit 0) / 5h窓 10%");
  });
});
