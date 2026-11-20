import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mockSuggestion, suggestionMessage, suggestPrompt, SuggestionService, type SuggestAdapter } from "../packages/observer/src/core/suggest.ts";
import { InvalidSuggestion, parseSuggestion, SuggestionError, validateSuggestionRequest, type SuggestionRequest } from "../packages/observer/src/shared/suggestion.ts";
import { startServer, type RunningServer } from "../packages/app/src/server/server.ts";
import { resolveMachineSettings } from "../packages/tasks/src/core/machineSettings.ts";
import { tempDir } from "./helpers.ts";
import { initialized, p3, snapshot } from "./cliHelpers.ts";

/**
 * 観測の定義の入力から確認の手順を提案する（docs/architecture.md「p3-observer」の手順の提案）。
 * AI の接続は代替（偽のアダプター・Mock の頼む先）にして、提案・足りない材料・不正な応答・失敗・取り消し・プロジェクトの分離を確かめる。
 * 画面は test/ui/observerSuggest.ui.test.ts
 */
const MEASURES = [
  { name: "elapsed", type: "number" as const, unit: "ms" },
  { name: "ok", type: "boolean" as const },
];
const request = (over: Partial<SuggestionRequest["definition"]> = {}, rest: Partial<SuggestionRequest> = {}): SuggestionRequest => ({
  definition: { title: "一覧の応答時間", category: "性能", description: "p3 ls コマンドが速く返るか", measures: MEASURES, procedures: [], ...over },
  ...rest,
});

/** 偽のアダプター（頼まれた依頼文を残し、決めた応答を返す） */
function fake(reply: (input: Parameters<SuggestAdapter["ask"]>[0], signal: AbortSignal) => Promise<string> | string, opts: { ok?: boolean; repos?: { name: string; available: boolean; reason?: string }[] } = {}) {
  const asked: Parameters<SuggestAdapter["ask"]>[0][] = [];
  const adapter: SuggestAdapter = {
    context: async () => ({ engine: { name: "fake", ok: opts.ok ?? true, detail: opts.ok === false ? "ChatGPT にサインインしてください" : "代替" }, repos: (opts.repos ?? [{ name: "app", available: true }]).map((r) => ({ ...r, ...(r.available ? { path: `/workspace/${r.name}` } : {}) })), project: "## プロジェクト\napp: 代替", qualityVersion: "q1" }),
    ask: async (input, _log, signal) => {
      asked.push(input);
      return { message: await reply(input, signal), engine: "fake" };
    },
  };
  return { adapter, asked };
}

describe("依頼と応答の読み方", () => {
  it("依頼文に未保存の定義・測定項目・参照先・補足が入る", () => {
    const p = suggestPrompt(request({}, { note: "pnpm の script を使う" }), ["/workspace/app"], "## プロジェクト\napp: 在庫管理");
    expect(p).toContain("タイトル: 一覧の応答時間");
    expect(p).toContain("p3 ls コマンドが速く返るか");
    expect(p).toContain("- elapsed: 数値（ms）");
    expect(p).toContain("- /workspace/app");
    expect(p.startsWith("## プロジェクト\napp: 在庫管理")).toBe(true);
    expect(p).toContain("pnpm の script を使う");
  });

  it("依頼の入力: タイトルか観測内容が要る。測定項目・手順の形は定義と同じ検証", () => {
    expect(validateSuggestionRequest({ definition: { title: "", description: "" } })).toMatchObject({ ok: false, problems: [{ path: "definition.description" }] });
    const bad = validateSuggestionRequest({ definition: { title: "t", measures: [{ name: "x", type: "date" }] }, repos: ["app"] });
    expect(bad.ok ? [] : bad.problems.map((p) => p.path)).toEqual(expect.arrayContaining(["repos", "definition.measures[0].type"]));
    expect(validateSuggestionRequest({ definition: { title: "t" } })).toMatchObject({ ok: true, value: { definition: { category: "", measures: [] } } });
  });

  it("コードブロックの JSON を読み、手順は定義の検証を通す。定義に無い測定項目は外して知らせる", () => {
    const s = parseSuggestion(
      "説明\n```json\n" +
        JSON.stringify({
          surface: "cli",
          rationale: "package.json に bench がある",
          procedures: [{ kind: "command", title: "bench", command: "pnpm", args: ["bench"], repo: "app", measures: ["elapsed", "nope"], evidence: "package.json の scripts.bench" }],
          missing: [{ field: "weird", reason: "その他" }],
        }) +
        "\n```",
      MEASURES,
    );
    expect(s.procedures).toEqual([{ procedure: { kind: "command", title: "bench", command: "pnpm", args: ["bench"], repo: "app", measures: ["elapsed"] }, evidence: "package.json の scripts.bench" }]);
    expect(s.missing).toEqual([{ field: "other", reason: "その他" }]);
    expect(s.warnings).toEqual(["手順 1 の測定項目 nope は定義に無いので外しました"]);
  });

  it("形の違う応答は InvalidSuggestion（理由つき）", () => {
    const bad = (o: unknown) => () => parseSuggestion(typeof o === "string" ? o : JSON.stringify(o), MEASURES);
    expect(bad("すみません、わかりません")).toThrow(InvalidSuggestion);
    expect(bad({ surface: "desktop", rationale: "x", procedures: [], missing: [] })).toThrow(/surface/);
    expect(bad({ surface: "cli", rationale: "x", procedures: [{ kind: "test", title: "t", path: "/abs.ts", measures: [], evidence: "e" }], missing: [] })).toThrow(/procedures\[0\]/);
    expect(bad({ surface: "cli", rationale: "x", procedures: [{ kind: "command", title: "t", command: "c", measures: [] }], missing: [] })).toThrow(/evidence/);
    expect(bad({ surface: "unknown", rationale: "x", procedures: [], missing: [] })).toThrow(/足りない材料もありません/);
  });
});

describe("提案の実行（代替の接続）", () => {
  it("CLI を示す材料ではコマンド、画面を示す材料では画面操作スクリプトを提案する（Mock）。手がかりが無ければ足りない材料と理由を返す", async () => {
    const svc = new SuggestionService(fake((input) => suggestionMessage(mockSuggestion(input.request, input.repos))).adapter);
    const cli = await svc.run(request());
    expect(cli).toMatchObject({ status: "completed", result: { surface: "cli", procedures: [{ procedure: { kind: "command", measures: ["elapsed", "ok"] } }], missing: [] } });
    const ui = await svc.run(request({ description: "要望の画面でボタンを押すと一覧が出るか" }));
    expect(ui).toMatchObject({ status: "completed", result: { surface: "ui", procedures: [{ procedure: { kind: "ui-script", repo: "app" } }] } });
    const none = await svc.run(request({ title: "観測", description: "速さを見る" }));
    expect(none.result?.surface).toBe("unknown");
    expect(none.result?.procedures).toEqual([]);
    expect(none.result?.missing.map((m) => m.field)).toEqual(["surface", "entry"]);
    expect(none.result?.missing.every((m) => m.reason.length > 0)).toBe(true);
  });

  it("参照先は選ばせず、Preflight と同じく読めるものを全部渡す（読めないものは外す）", async () => {
    const f = fake(() => suggestionMessage(mockSuggestion(request(), ["app"])), {
      repos: [{ name: "app", available: true }, { name: "docs", available: false, reason: "このマシンのパスが登録されていません" }, { name: "web", available: true }],
    });
    const svc = new SuggestionService(f.adapter);
    expect((await svc.run(request())).status).toBe("completed");
    expect(f.asked.map((a) => a.repos)).toEqual([["app", "web"]]);
    expect(f.asked[0].prompt).toContain("app: 代替");
    expect(f.asked[0].prompt).toContain("/workspace/web");
    expect(f.asked[0].prompt).not.toContain("/workspace/docs");
  });

  it("不正な応答・接続を使えない・接続の失敗・時間切れ・取り消しは理由を返す", async () => {
    expect(await new SuggestionService(fake(() => "{ 壊れた").adapter).run(request())).toMatchObject({ status: "failed", failure: "invalid_output", error: expect.stringContaining("応答の形が違います") });
    expect(await new SuggestionService(fake(() => "{}", { ok: false }).adapter).run(request())).toMatchObject({ status: "failed", failure: "unavailable", error: "ChatGPT にサインインしてください" });
    const auth = fake(() => {
      throw new SuggestionError("usage_limit", "使用量の上限です");
    });
    expect(await new SuggestionService(auth.adapter).run(request())).toMatchObject({ status: "failed", failure: "usage_limit" });
    const slow = fake((_i, signal) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(await new SuggestionService(slow.adapter, { timeoutMs: 50 }).run(request())).toMatchObject({ status: "failed", failure: "timeout" });
    const svc = new SuggestionService(slow.adapter);
    const job = await svc.start(request());
    expect(svc.get(job.id)?.status).toBe("running");
    await new Promise((r) => setTimeout(r, 20));
    expect(svc.cancel(job.id)).toBe(true);
    await svc.settle();
    expect(svc.get(job.id)).toMatchObject({ status: "cancelled", error: "取り消しました" });
  });
});

const servers: RunningServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close({ timeoutMs: 1000 });
});
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("ポートを選べません"))));
    });
  });
async function serve(opts: Omit<Parameters<typeof startServer>[0], "port" | "host">) {
  const port = await freePort();
  servers.push(await startServer({ ...opts, port, host: "127.0.0.1" }));
  const base = `http://127.0.0.1:${port}/api`;
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
}
const mockSettings = () => resolveMachineSettings({ settings: {} }, { P3_PREFLIGHT_ENGINE: "mock" });
async function waitDone(call: Awaited<ReturnType<typeof serve>>, path: string) {
  for (let i = 0; i < 100; i++) {
    const r = await call("GET", path);
    if (r.body.status !== "running") return r.body;
    await new Promise((x) => setTimeout(x, 20));
  }
  throw new Error("終わりません");
}

describe("API と CLI（Mock の頼む先）", () => {
  it("通常の serve: 材料の状態・提案の開始と結果・入力の誤り。保存はしない", async () => {
    const { root } = await initialized();
    const dataDir = join(root, ".p3");
    const call = await serve({ dataDir, projectName: "app", repos: { app: root }, settings: mockSettings() });
    const ctx = await call("GET", "/observer/suggestions/context");
    expect(ctx.body).toMatchObject({ engine: { name: "mock", ok: true }, repos: [{ name: "app", available: true }] });
    expect((await call("POST", "/observer/suggestions", { definition: { title: "" } })).body).toMatchObject({ code: "invalid", problems: [{ path: "definition.description" }] });
    const started = await call("POST", "/observer/suggestions", { definition: request().definition, note: "補足" });
    expect(started.status).toBe(202);
    const done = await waitDone(call, `/observer/suggestions/${started.body.id}`);
    expect(done).toMatchObject({ status: "completed", engine: "mock", result: { surface: "cli", procedures: [{ procedure: { repo: "app" } }] } });
    expect((await call("GET", "/observer/definitions")).body.definitions).toEqual([]);
    expect((await call("GET", "/observer/suggestions/sg-000000000000")).status).toBe(404);
  });

  it("プロジェクトを跨ぐ serve: 提案の実行はプロジェクトごとで、別のプロジェクトからは読めない。始めるには登録世代が要る", async () => {
    const a = await initialized();
    const b = await initialized();
    const cfg = tempDir("p3-sg-all-");
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = cfg;
    await mkdir(join(cfg, "infodb-p3"), { recursive: true });
    await writeFile(join(cfg, "infodb-p3", "config.yaml"), `projects:\n  alpha:\n    dir: ${join(a.root, ".p3")}\n  beta:\n    dir: ${join(b.root, ".p3")}\n`);
    try {
      const call = await serve({ allProjects: true, settings: mockSettings() });
      const gen = ((await call("GET", "/projects")).body.projects as { name: string; generation: string }[]).find((p) => p.name === "alpha")!.generation;
      expect((await call("POST", "/projects/alpha/observer/suggestions", { definition: request().definition })).status).toBe(428);
      const started = await call("POST", "/projects/alpha/observer/suggestions", { definition: request().definition }, { "x-p3-project-generation": gen });
      expect(started.status).toBe(202);
      expect((await waitDone(call, `/projects/alpha/observer/suggestions/${started.body.id}`)).status).toBe("completed");
      expect((await call("GET", `/projects/beta/observer/suggestions/${started.body.id}`)).status).toBe(404);
    } finally {
      process.env.XDG_CONFIG_HOME = prev;
    }
  });

  it("CLI: 提案の JSON（今の手順に提案を足した definition）を出し、編集して add --input で保存すると定義の検証が働く。tasks のデータは変えない", async () => {
    const { root } = await initialized();
    const before = snapshot(join(root, ".p3"));
    writeFileSync(join(root, "draft.json"), JSON.stringify({ ...request().definition }));
    const r = p3(root, ["observer", "suggest", "--input", "draft.json", "--note", "pnpm を使う", "--json"], { P3_PREFLIGHT_ENGINE: "mock" });
    expect(r.code, r.err).toBe(0);
    const out = r.json();
    expect(out).toMatchObject({ status: "completed", engine: "mock", result: { surface: "cli" }, definition: { title: "一覧の応答時間", procedures: [{ kind: "command", repo: "app" }] } });
    expect(snapshot(join(root, ".p3"))).toEqual(before);
    const text = p3(root, ["observer", "suggest", "--title", "画面", "--body", "画面のボタンを押す"], { P3_PREFLIGHT_ENGINE: "mock" });
    expect(text.out).toContain("操作面: 画面");
    expect(text.out).toContain("画面操作スクリプト: 画面を画面で確かめる");
    expect(text.out).toContain("保存はしていません");
    // 編集して保存（誤りは定義の検証で断る）
    writeFileSync(join(root, "bad.json"), JSON.stringify({ ...out.definition, procedures: [{ ...out.definition.procedures[0], cwd: "../x" }] }));
    expect(p3(root, ["observer", "add", "--input", "bad.json"]).err).toContain("procedures[0].cwd");
    writeFileSync(join(root, "edited.json"), JSON.stringify({ ...out.definition, procedures: [{ ...out.definition.procedures[0], title: "直した" }] }));
    const saved = p3(root, ["observer", "add", "--input", "edited.json", "--json"]);
    expect(saved.code, saved.err).toBe(0);
    expect(saved.json().procedures[0]).toMatchObject({ kind: "command", title: "直した" });
    // --repo は使わない（黙って無視しない）。材料の不足は理由を出して 1
    const repo = p3(root, ["observer", "suggest", "--input", "draft.json", "--repo", "app"], { P3_PREFLIGHT_ENGINE: "mock" });
    expect([repo.code, repo.err]).toEqual([1, expect.stringContaining("--repo を使いません")]);
    expect(p3(root, ["observer", "suggest", "--category", "c"]).err).toContain("definition.description");
    expect(p3(root, ["observer", "list", "--repo", "app"]).code).toBe(1);
  });
});
