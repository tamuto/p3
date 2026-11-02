import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PreflightEngine } from "../src/core/preflight/engine.ts";
import { LOCAL_INSTRUCTIONS_FILE } from "../src/core/preflight/instructions.ts";
import { RenderError } from "../src/core/preflight/render.ts";
import { LocalResultError, LocalRunError, PreflightBusyError, PreflightService } from "../src/core/preflight/service.ts";
import type { Renderer } from "../src/core/preflight/uiRender.ts";
import { wireframePng } from "../src/core/preflight/wireframe.ts";
import { stringifyFrontmatter } from "../src/core/store/frontmatter.ts";
import { NotFoundError } from "../src/core/store/collection.ts";
import { PREFLIGHT_CANCELLED } from "../src/shared/directTask.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { gitInit, makeRepo, newRequest, openTestProject, tempDir } from "./helpers.ts";

/** 呼ばれたら失敗するエンジン（手元の経路はモデルを呼ばない） */
const forbidden = (name: PreflightEngine["name"]): PreflightEngine => ({
  name,
  status: async () => ({ name, ok: true, detail: "" }),
  run: async () => {
    throw new Error(`${name} を呼びました`);
  },
});

async function setup(render?: Renderer) {
  const { dataDir } = await makeRepo();
  const ctx = await openTestProject(dataDir);
  const calls: string[] = [];
  const service = new PreflightService(ctx.ws, { codex: forbidden("codex"), mock: forbidden("mock") }, "codex", {
    pathMap: async () => [],
    render: render ?? (async () => {
      calls.push("render");
      throw new Error("描画を呼びました");
    }),
  });
  const req = await newRequest(ctx, { title: "通知", status: "draft", body: "通知を送る" });
  return { ctx, service, req, calls };
}

function writeResult(runDir: string, opts: { assessment?: string; drafts?: Record<string, Record<string, unknown>>; ui?: unknown } = {}) {
  writeFileSync(
    join(runDir, "assessment.json"),
    opts.assessment ??
      JSON.stringify({ summary: "通知を足す", verdict: "go", validity: { score: 80, reasons: ["r"] }, feasibility: { score: 70, reasons: ["f"] }, risks: [], questions: [], areas: ["src"] }),
  );
  mkdirSync(join(runDir, "drafts"), { recursive: true });
  const drafts = opts.drafts ?? {
    D1: { key: "D1", title: "送信基盤", repo: "main", areas: ["src"], dependsOn: [] },
    D2: { key: "D2", title: "設定", repo: "main", areas: ["src"], dependsOn: ["D1"] },
  };
  for (const [k, d] of Object.entries(drafts)) writeFileSync(join(runDir, "drafts", `${k}.md`), stringifyFrontmatter({ include: true, ...d }, "作業内容"));
  mkdirSync(join(runDir, "ui"), { recursive: true });
  writeFileSync(join(runDir, "ui", "index.json"), JSON.stringify(opts.ui ?? { needed: false, reason: "CLI だけの変更" }));
}

describe("手元のエージェントの Preflight（prepare → complete）", () => {
  it("prepare は評価対象を固定して指示を書き、モデルを呼ばずに待つ。complete で取り込み、タスク化できる", async () => {
    const { ctx, service, req, calls } = await setup();
    await ctx.preflight.addNote(req.id, "通知はメールだけ");
    const p = await service.prepare(req.id, { actor: "ai:claude" });
    expect(p.run).toMatchObject({ engine: "local", status: "running", local: { before: "draft" }, startedBy: "ai:claude" });
    expect(p.instructions).toBe(join(p.runDir, LOCAL_INSTRUCTIONS_FILE));
    const text = readFileSync(p.instructions, "utf8");
    expect(text).toContain("## 制約");
    expect(text).toContain(`${p.runDir}/assessment.json`);
    expect(text).toContain("通知はメールだけ");
    expect(p.outputs).toContain(join(p.runDir, "drafts/"));
    expect(existsSync(join(p.runDir, "request.md"))).toBe(true);
    expect(ctx.ws.requests.get(req.id)).toMatchObject({ status: "preflight", lastPreflight: p.run.id });

    writeResult(p.runDir);
    const r = await service.complete(req.id, p.run.id);
    expect(r.already).toBe(false);
    expect(r.run).toMatchObject({ status: "completed", engine: "local", assessment: { verdict: "go" }, ui: { status: "not_needed" } });
    expect(r.run.drafts.map((d) => d.key)).toEqual(["D1", "D2"]);
    expect(calls).toEqual([]);
    expect(ctx.ws.requests.get(req.id)!.status).toBe("reviewed");
    // 取り込んだ run は通常の run と同じに読め、人がタスク化できる
    const read = (await service.list(req.id))[0];
    expect(read.id).toBe(p.run.id);
    const m = await service.materialize(req.id, p.run.id, "human:test");
    expect(m.tasks.map((t) => t.title)).toEqual(["送信基盤", "設定"]);

    // 二重の complete は何も変えない
    const again = await service.complete(req.id, p.run.id);
    expect(again.already).toBe(true);
    expect(again.run.finishedAt).toBe(r.run.finishedAt);
    expect(again.run.materialized).toEqual(m.tasks.map((t) => t.id));
  });

  it("不正な成果物は確定せず、run は待ったまま。直して同じ run で取り込める", async () => {
    const { service, req } = await setup();
    const p = await service.prepare(req.id);
    await expect(service.complete(req.id, p.run.id)).rejects.toThrow("assessment.json がありません");
    writeResult(p.runDir, {
      assessment: "{ 壊れた",
      drafts: { D1: { key: "D1", title: "", repo: "other", dependsOn: ["D9"] }, X: { key: "X1", title: "x", repo: "main" } },
    });
    const err = await service.complete(req.id, p.run.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalResultError);
    const problems = (err as LocalResultError).problems.join("\n");
    expect(problems).toContain("assessment.json が JSON として読めません");
    expect(problems).toContain("D1: 題がありません");
    expect(problems).toContain("D1: 依存先の D9 というタスク案はありません");
    expect(problems).toContain("D1: ");
    expect(problems).toContain("タスク案のキーの形が違います: X1");
    const waiting = (await service.get(req.id, p.run.id))!;
    expect(waiting).toMatchObject({ status: "running", local: { rejected: 2 } });
    expect(waiting.assessment).toBeUndefined();

    writeResult(p.runDir, { drafts: { D1: { key: "D1", title: "送信基盤", repo: "main" } } });
    const { rmSync } = await import("node:fs");
    rmSync(join(p.runDir, "drafts", "X.md"));
    const r = await service.complete(req.id, p.run.id);
    expect(r.run.status).toBe("completed");
    expect(r.run.drafts.map((d) => d.key)).toEqual(["D1"]);
  });

  it("成果物のシンボリックリンク（run の外を読ませる）は取り込まない", async () => {
    const { service, req } = await setup();
    const p = await service.prepare(req.id);
    const outside = join(tempDir(), "a.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, join(p.runDir, "assessment.json"));
    await expect(service.complete(req.id, p.run.id)).rejects.toThrow("assessment.json がシンボリックリンクです");
  });

  it("分割の案（children/）も通常と同じに取り込み、混在は断る", async () => {
    const { service, req } = await setup();
    const p = await service.prepare(req.id);
    writeResult(p.runDir, { drafts: {} });
    mkdirSync(join(p.runDir, "children"));
    for (const k of ["C1", "C2"]) {
      writeFileSync(join(p.runDir, "children", `${k}.md`), stringifyFrontmatter({ key: k, title: `子 ${k}`, estimatedTasks: 3, include: true }, "## 目的\nx\n## 完了条件\ny"));
    }
    writeFileSync(join(p.runDir, "drafts", "D1.md"), stringifyFrontmatter({ key: "D1", title: "混ざった案", repo: "main" }, "x"));
    await expect(service.complete(req.id, p.run.id)).rejects.toThrow("両方あります");
    const { rmSync } = await import("node:fs");
    rmSync(join(p.runDir, "drafts"), { recursive: true });
    const r = await service.complete(req.id, p.run.id);
    expect(r.run.children?.map((c) => c.key)).toEqual(["C1", "C2"]);
    expect(r.run.draftProblems).toBeUndefined();
  });

  it("同じ要望の二重の準備・通常の実行を断り、取り消すと次を始められる。取り消した run は取り込めない", async () => {
    const { ctx, service, req } = await setup();
    const p = await service.prepare(req.id);
    await expect(service.prepare(req.id)).rejects.toThrow(PreflightBusyError);
    await expect(service.prepare(req.id)).rejects.toThrow(`--complete --run ${p.run.id}`);
    // 別のプロセス（serve）の通常の実行も断る
    const other = await openTestProject(ctx.ws.dataDir);
    await expect(other.preflight.start(req.id, { engine: "mock" })).rejects.toThrow(PreflightBusyError);

    const c = await service.cancelLocal(req.id, p.run.id);
    expect(c.run).toMatchObject({ status: "failed", error: PREFLIGHT_CANCELLED });
    expect(ctx.ws.requests.get(req.id)!.status).toBe("draft");
    expect((await service.cancelLocal(req.id, p.run.id)).already).toBe(true);
    writeResult(p.runDir);
    await expect(service.complete(req.id, p.run.id)).rejects.toThrow(LocalRunError);

    const next = await service.prepare(req.id);
    expect(next.run.id).not.toBe(p.run.id);
    // 通常の run・無い run は手元の操作の対象にしない
    await expect(service.complete(req.id, "PF-nope")).rejects.toThrow(NotFoundError);
    await expect(service.cancelLocal(req.id, "../x")).rejects.toThrow(NotFoundError);
  });

  it("同時に complete しても取り込みは1回だけ", async () => {
    const { service, req } = await setup();
    const p = await service.prepare(req.id);
    writeResult(p.runDir);
    const both = await Promise.all([service.complete(req.id, p.run.id), service.complete(req.id, p.run.id)]);
    expect(both.filter((r) => r.already)).toHaveLength(1);
  });

  it("評価のあとで要望が変わればタスク化を断る（stale_input）", async () => {
    const { ctx, service, req } = await setup();
    const p = await service.prepare(req.id);
    writeResult(p.runDir);
    await service.complete(req.id, p.run.id);
    await ctx.ws.requests.update(req.id, { body: "別の内容" });
    await expect(service.materialize(req.id, p.run.id, "human:test")).rejects.toMatchObject({ code: "stale_input" });
  });

  it("画面の原稿があるときだけ描画し、描けなくても評価は残して go を clarify にする", async () => {
    const drew: string[] = [];
    const ok: Renderer = async (jobs, _w, outDir) => {
      await mkdir(outDir, { recursive: true });
      drew.push(...jobs.map((j) => j.id));
      return jobs.map((j) => {
        writeFileSync(join(outDir, `${j.id}.png`), wireframePng(j.width, 200, [[0, 0, 10, 10, 0x334155]]));
        return { id: j.id, ok: true, file: join(outDir, `${j.id}.png`), blocked: [] };
      });
    };
    const ui = { needed: true, targets: ["D1"], items: [{ id: "U1", html: "src/U1.html", title: "設定画面", drafts: ["D1"], viewport: 800 }] };
    for (const [render, want] of [
      [ok, { status: "ready", verdict: "go" }],
      [async () => Promise.reject(new RenderError("Docker デーモンにつながりません", "docker")), { status: "missing", verdict: "clarify" }],
    ] as const) {
      const { service, req } = await setup(render);
      const p = await service.prepare(req.id);
      writeResult(p.runDir, { ui });
      mkdirSync(join(p.runDir, "ui", "src"));
      writeFileSync(join(p.runDir, "ui", "src", "U1.html"), "<p>設定</p>");
      const r = await service.complete(req.id, p.run.id);
      expect(r.run.status).toBe("completed");
      expect(r.run.ui?.status).toBe(want.status);
      expect(r.run.assessment!.verdict).toBe(want.verdict);
    }
    expect(drew).toEqual(["U1"]);
  });
});

describe("画面（API）から見た手元のエージェントの Preflight", () => {
  it("外で準備・取り込みした run の状態・評価・案を、別に開いた serve が読め、待っている間は通常の実行を断る", async () => {
    const { ctx, service, req } = await setup();
    const serve = await openTestProject(ctx.ws.dataDir);
    const app = apiRoutes(serve);
    const p = await service.prepare(req.id);
    const pulse = (await (await app.request(`/requests/${req.id}/preflight-status`)).json()) as { latest: { id: string; status: string } };
    expect(pulse.latest).toMatchObject({ id: p.run.id, status: "running" });
    const start = await app.request(`/requests/${req.id}/preflight`, { method: "POST", body: JSON.stringify({ engine: "mock" }), headers: { "content-type": "application/json" } });
    expect(start.status).toBeGreaterThanOrEqual(400);
    writeResult(p.runDir);
    await service.complete(req.id, p.run.id);
    const runs = (await (await app.request(`/requests/${req.id}/preflight`)).json()) as { id: string; engine: string; status: string; drafts: unknown[]; assessment: { verdict: string } }[];
    expect(runs[0]).toMatchObject({ id: p.run.id, engine: "local", status: "completed", assessment: { verdict: "go" } });
    expect(runs[0].drafts).toHaveLength(2);
  });
});

describe("CLI（別のプロセス）での手元のエージェントの Preflight", () => {
  const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
  function p3(cwd: string, configHome: string, args: string[]) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
    // Codex・Docker を呼べないようにする（呼べば失敗する）
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...base, XDG_CONFIG_HOME: configHome, PATH: "/nonexistent", P3_ACTOR: "ai:claude" } });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  }

  it("prepare → 成果物 → complete → drafts → accept を、認証も Docker も無しで通せる。曖昧な指定は書く前に断る", async () => {
    const root = tempDir("p3-local-");
    gitInit(root);
    const configHome = tempDir("p3-config-");
    expect(p3(root, configHome, ["init", "--yes", "--description", "在庫", "--dir", ".p3", "--repo-name", "main"]).code).toBe(0);
    const rid = p3(root, configHome, ["request", "new", "通知", "--body", "通知を送る", "--json"]).json().id as string;

    for (const bad of [
      ["--prepare", "--complete"],
      ["--prepare", "--engine", "mock"],
      ["--prepare", "--run", "PF-x"],
      ["--complete"],
      ["--cancel", "--run", "PF-x", "--note", "x"],
      ["--run", "PF-x"],
    ]) {
      const r = p3(root, configHome, ["preflight", rid, ...bad, "--json"]);
      expect(r.code, bad.join(" ")).toBe(1);
    }
    expect(p3(root, configHome, ["show", rid, "--json"]).json().item.lastPreflight).toBeUndefined();

    const prep = p3(root, configHome, ["preflight", rid, "--prepare", "--json"]);
    expect(prep.code, prep.err).toBe(0);
    const p = prep.json();
    expect(p).toMatchObject({ request: rid, status: "running", engine: "local", next: { complete: `p3 preflight ${rid} --complete --run ${p.run}` } });
    expect(readFileSync(p.instructions, "utf8")).toContain("# P3 の Preflight の指示");
    expect(p3(root, configHome, ["preflight", rid, "--prepare", "--json"]).code).toBe(1);

    writeResult(p.runDir, { assessment: "x" });
    const bad = p3(root, configHome, ["preflight", rid, "--complete", "--run", p.run, "--json"]);
    expect(bad.code).toBe(1);
    expect(bad.json()).toMatchObject({ code: "invalid_result", run: p.run });

    writeResult(p.runDir);
    const done = p3(root, configHome, ["preflight", rid, "--complete", "--run", p.run, "--json"]);
    expect(done.code, done.err).toBe(0);
    expect(done.json()).toMatchObject({ status: "completed", already: false, inputMatch: { status: "same" } });
    expect(p3(root, configHome, ["drafts", rid, "--json"]).json()).toMatchObject({ id: p.run, engine: "local", drafts: [{ key: "D1" }, { key: "D2" }] });
    const shown = p3(root, configHome, ["drafts", rid]).out;
    expect(shown).toContain("✓ main（本体）  このマシンのパスで読める");
    expect(shown).not.toContain("/workspace/");
    const acc = p3(root, configHome, ["accept", rid, "--json", "--actor", "human:test"]);
    expect(acc.code, acc.err).toBe(0);
    expect(acc.json().tasks).toHaveLength(2);
    expect(p3(root, configHome, ["preflight", rid, "--complete", "--run", p.run, "--json"]).json().already).toBe(true);
  });
});
