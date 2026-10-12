import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { ChatGptAccount } from "../src/server/chatgpt/account.ts";
import { unknownEngine } from "../src/web/lib/engineStatus.ts";
import { ProjectIndex } from "../src/server/intel/index.ts";
import { machineSettingsSource } from "../src/server/machineSettings.ts";
import { CodexWorkspaceEngine, codexConfig } from "../src/server/preflight/codexEngine.ts";
import { MockEngine } from "../src/server/preflight/mockEngine.ts";
import { PreflightService } from "../src/server/preflight/service.ts";
import { Workspace } from "../src/server/store/workspace.ts";
import { makeRepo, newRequest, tempDir } from "./helpers.ts";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

/**
 * serve と同じ組み立て（context.ts の openProject）で、個人設定をファイルから読み直す。
 * docker の代わりに偽の app-server を起こし、渡されたパス（Docker のホストのパス）を記録する
 */
async function setup(env: Record<string, string | undefined> = {}) {
  const repo = await makeRepo();
  const configDir = tempDir("p3-config-");
  const configPath = join(configDir, "config.yaml");
  const source = machineSettingsSource({ path: configPath, env });
  const launched: { workspace: string; data: string }[] = [];
  const ws = new Workspace(repo.dataDir);
  await ws.load();
  const index = new ProjectIndex(ws);
  const initial = await source.get().catch(() => undefined);
  const codex = new CodexWorkspaceEngine({
    account: new ChatGptAccount(join(tempDir(), "none.json")),
    load: async () => ({
      ...codexConfig(await source.get()),
      configPath: source.path,
      command: (workspace, data) => {
        launched.push({ workspace, data });
        return ["env", `FAKE_REPO=${repo.root}`, `FAKE_DATA=${repo.dataDir}`, "FAKE_LOG=/dev/null", process.execPath, FAKE_CODEX];
      },
    }),
  });
  const preflight = new PreflightService(ws, index, { codex, mock: new MockEngine({ delay: 0 }) }, {
    initial: initial?.preflight.engine ?? "codex",
    load: async () => (await source.get()).preflight.engine,
  });
  const ctx = { ws, index, preflight };
  const write = (yaml: string) => writeFile(configPath, yaml);
  const legacy = "codex:\n  authVolume: vol\n  ensureImage: false\n";
  const runOnce = async (opts: { engine?: "codex" | "mock" } = {}) => {
    const req = await newRequest(ctx, { title: "x", status: "draft" });
    const { id } = await preflight.start(req.id, opts);
    const run = (await preflight.wait(req.id, id))!;
    return { run, request: ws.requests.get(req.id)!, log: run.log.map((l) => l.text).join("\n") };
  };
  return { repo, configPath, configDir, write, legacy, launched, runOnce, preflight, codex, ctx };
}

describe("個人設定を serve の起動し直しなしで効かせる", () => {
  it("同じ serve のまま codex.pathMap を直すと、次の Preflight のマウントが変わる", async () => {
    const s = await setup();
    await s.write(`${s.legacy}  pathMap:\n    ${s.repo.root}: /wrong/host\n`);
    expect((await s.runOnce()).run.status).toBe("completed");
    await s.write(`${s.legacy}  pathMap:\n    ${s.repo.root}: /right/host\n`);
    const second = await s.runOnce();
    expect(second.run.status).toBe("completed");
    expect(s.launched.map((l) => l.workspace)).toEqual(["/wrong/host", "/right/host"]);
    expect(second.log).toContain(`リポジトリ: ${s.repo.root} → Docker のホスト /right/host（対応 ${s.repo.root}=/right/host）`);
    expect(second.log).toContain(s.configPath);
  });

  it("環境変数が個人設定より先。空の環境変数は既定値に戻す", async () => {
    const tmp = realpathSync(tmpdir());
    const s = await setup({ PCUBE_CODEX_PATH_MAP: `${tmp}=/from-env` });
    await s.write(`${s.legacy}  pathMap:\n    ${s.repo.root}: /from-config\n`);
    await s.runOnce();
    expect(s.launched.at(-1)!.workspace).toBe(`/from-env${s.repo.root.slice(tmp.length)}`);
    const cleared = await setup({ PCUBE_CODEX_PATH_MAP: "" });
    await cleared.write(`${cleared.legacy}  pathMap:\n    ${cleared.repo.root}: /from-config\n`);
    await cleared.runOnce();
    expect(cleared.launched.at(-1)!.workspace).toBe(cleared.repo.root);
  });

  it("既定のエンジンも読み直す。--engine の明示はそのまま", async () => {
    const s = await setup();
    await s.write(`${s.legacy}preflight:\n  engine: mock\n`);
    expect((await s.runOnce()).run.engine).toBe("mock");
    expect(s.preflight.defaultEngine).toBe("mock");
    await s.write(s.legacy);
    expect((await s.runOnce()).run.engine).toBe("codex");
    // 個人設定が壊れていても、明示した Mock は動く
    await s.write("codex: [壊れた\n");
    expect((await s.runOnce({ engine: "mock" })).run.status).toBe("completed");
  });

  it("実行中の run は始めたときの設定のまま。後から始めた run は新しい設定", async () => {
    const s = await setup();
    await s.write(`${s.legacy}  pathMap:\n    ${s.repo.root}: /first\n`);
    const r1 = await newRequest(s.ctx as never, { title: "1", status: "draft" });
    const first = await s.preflight.start(r1.id);
    // 始めた直後（偽の app-server が動いている間）に直す
    await s.write(`${s.legacy}  pathMap:\n    ${s.repo.root}: /second\n`);
    const second = await s.runOnce();
    const run1 = (await s.preflight.wait(r1.id, first.id))!;
    expect(run1.log.map((l) => l.text).join("\n")).toContain("/first");
    expect(second.log).toContain("/second");
    expect(s.launched.map((l) => l.workspace).sort()).toEqual(["/first", "/second"]);
  });

  it("読めない設定では、その Preflight を設定のエラーとして失敗にし（Docker を起こさない）、直すと次は成功する", async () => {
    const s = await setup();
    const cases: [string, () => Promise<void>, string][] = [
      ["壊れた YAML", () => s.write("codex:\n  pathMap: [壊れた\n"), "YAML が壊れています"],
      ["ルートの形", () => s.write("- a\n- b\n"), "個人設定の形が違います"],
      ["項目の形", () => s.write("codex: 文字列\n"), "個人設定の codex の形が違います"],
      ["pathMap", () => s.write(`${s.legacy}  pathMap:\n    relative: /x\n`), "どちらも絶対パスにしてください"],
      ["読めない", async () => {
        await s.write("");
        const { rm } = await import("node:fs/promises");
        await rm(s.configPath);
        await mkdir(s.configPath);
      }, "個人設定を読めません"],
    ];
    for (const [label, breakIt, expected] of cases) {
      await breakIt();
      const { run, request, log } = await s.runOnce();
      expect([label, run.status]).toEqual([label, "failed"]);
      expect(run.error).toContain("個人設定を読めないので Preflight を始めません（Docker は起動していません）");
      expect(run.error).toContain(expected);
      expect(run.error).toContain(s.configPath);
      expect(log).toContain(expected);
      expect(request.status).toBe("draft"); // 評価の前の状態に戻す
      const status = await s.preflight.engineStatus();
      expect(status).toMatchObject({ ok: false, detail: expect.stringContaining(expected) });
      if (label === "読めない") {
        const { rm } = await import("node:fs/promises");
        await rm(s.configPath, { recursive: true });
      }
    }
    expect(s.launched).toEqual([]);
    await s.write(s.legacy);
    expect((await s.runOnce()).run.status).toBe("completed");
    expect(s.launched).toHaveLength(1);
    // 状態も戻る（ためていた期間の中でも）
    expect((await s.preflight.engineStatus()).detail).not.toContain("個人設定を読めない");
  });

  it("個人設定が無ければ既定値で動く", async () => {
    const s = await setup();
    const status = await s.preflight.engineStatus();
    expect(status.detail).not.toContain("個人設定を読めない");
  });
});

describe("エンジンの状態（/api/engine・ChatGPT の状態）も読み直す", () => {
  it("設定を変える・壊す・直すと、serve を起動し直さずに状態が変わる", async () => {
    const s = await setup();
    const app = apiRoutes({ ...s.ctx, chatgpt: new ChatGptAccount(join(tempDir(), "none.json")) } as never);
    const engine = async () => (await (await app.request("/engine")).json()) as { name: string; ok: boolean; detail: string };
    await s.write(`${s.legacy}preflight:\n  engine: mock\n`);
    expect(await engine()).toMatchObject({ name: "mock", ok: true });
    await s.write("preflight: [壊れた\n");
    const broken = await engine();
    expect(broken).toMatchObject({ ok: false, detail: expect.stringContaining("個人設定を読めないので Preflight を始められません") });
    expect(broken.detail).toContain(s.configPath);
    const local = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    const chatgpt = (await (await app.request("/chatgpt", {}, local)).json()) as { engine: { ok: boolean; detail: string } };
    expect(chatgpt.engine).toMatchObject({ ok: false, detail: expect.stringContaining("YAML が壊れています") });
    await s.write(`${s.legacy}preflight:\n  engine: mock\n`);
    expect(await engine()).toMatchObject({ name: "mock", ok: true });
    // 既定のエンジンを Codex に戻すと、Codex の状態になる（Docker が無くても設定のエラーではない）
    await s.write(s.legacy);
    const codex = await engine();
    expect(codex.name).toBe("codex");
    expect(codex.detail).not.toContain("個人設定を読めない");
  });

  it("取れなかったときは使えると見せない", () => {
    expect(unknownEngine("Failed to fetch")).toMatchObject({ ok: false, detail: expect.stringContaining("Failed to fetch") });
  });
});
