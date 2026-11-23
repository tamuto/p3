import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { init } from "../packages/p3/src/cli/project.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { codexAvailability } from "../packages/tasks/src/cli/tasksCli.ts";
import type { EngineStatus } from "../packages/tasks/src/core/preflight/engine.ts";
import { gitInit, makeProject, tempDir } from "./helpers.ts";

/**
 * Preflight の担当（preflight.runner）は無い。Codex の Preflight を使えるかはマシンの状態（サインイン）で決まり、whoami に出る。
 * 以前の project.yaml の preflight.runner は読み飛ばし、設定の保存でも消さない
 */

const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));
let CONFIG_HOME = "";
beforeEach(() => {
  CONFIG_HOME = tempDir("p3-config-");
});

function p3(cwd: string, args: string[]) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...base, XDG_CONFIG_HOME: CONFIG_HOME } });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

function repo() {
  const root = tempDir("p3-pf-");
  gitInit(root);
  return root;
}

const yamlOf = (root: string) => YAML.parse(readFileSync(join(root, ".p3", "project.yaml"), "utf8"));

/** init を関数で呼ぶ（対話の答えを渡す）。個人設定はテストのものにする */
async function initWith(root: string, o: Partial<Parameters<typeof init>[0]>) {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = CONFIG_HOME;
  try {
    return await init({ cwd: root, project: "app", ...o });
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

describe("Preflight の担当の設定は無い（Codex を使えるかはマシンで決まる）", () => {
  it("init は担当を聞かず・書かない。--preflight-runner は使い方の誤りで、何も作らない", async () => {
    const a = repo();
    const r = p3(a, ["init", "--yes", "--project", "a"]);
    expect(r.code, r.err).toBe(0);
    expect(yamlOf(a).preflight).toBeUndefined();
    expect(r.out).toContain("p3 preflight <要望ID>");
    expect(r.out).toContain("手元の AI エージェントに「要望 <要望ID> の Preflight をして」と頼む");

    const b = repo();
    const s = p3(b, ["init", "--yes", "--project", "b", "--preflight-runner", "agent"]);
    expect(s.code).toBe(1);
    expect(s.err).toContain("--preflight-runner");
    expect(existsSync(join(b, ".p3"))).toBe(false);

    const asked: string[] = [];
    const c = repo();
    await initWith(c, { project: "c", prompt: async (q) => (asked.push(q), "") });
    expect(asked.some((q) => q.includes("Preflight を実行するのは"))).toBe(false);
    expect(yamlOf(c).preflight).toBeUndefined();
  });

  it.each(["codex", "agent", "Agent"])("以前の project.yaml の preflight.runner: %s は読み飛ばし、config の保存でも残す。config には出ず、set は断る", (runner) => {
    const root = repo();
    expect(p3(root, ["init", "--yes", "--project", "a"]).code).toBe(0);
    writeFileSync(join(root, ".p3", "project.yaml"), `name: a\nbranchPattern: req/{id}-{slug}\npreflight:\n  runner: ${runner}\n`);
    const who = p3(root, ["whoami", "--json"]);
    expect(who.code, who.err).toBe(0);
    expect(who.json().preflight).not.toHaveProperty("runner");
    expect(p3(root, ["config"]).out).not.toContain("runner");
    expect(p3(root, ["config", "--json"]).json()).toMatchObject({ preflight: { instructions: "" } });
    expect(p3(root, ["config", "--json"]).json()).not.toHaveProperty("preflightRunner");

    expect(p3(root, ["config", "set", "instructions=観点"]).code).toBe(0);
    expect(yamlOf(root).preflight).toEqual({ runner, instructions: "観点" });
    expect(p3(root, ["config", "set", "instructions="]).code).toBe(0);
    expect(yamlOf(root).preflight).toEqual({ runner });

    const set = p3(root, ["config", "set", "preflight.runner=codex"]);
    expect(set.code).toBe(1);
    expect(set.err).toContain("preflight.runner（Preflight の担当）はなくなりました");
    expect(yamlOf(root).preflight).toEqual({ runner });
  });

  it("画面（API）の保存でも以前の preflight.runner を残す", async () => {
    const p = await makeProject();
    writeFileSync(join(p.dataDir, "project.yaml"), "name: x\nbranchPattern: req/{id}-{slug}\npreflight:\n  runner: agent\n");
    await p.ctx.ws.load();
    const app = apiRoutes(p.ctx);
    const res = await app.request("/project", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ preflight: { instructions: "画面で変えた" } }) });
    expect(res.status).toBe(200);
    expect((await res.json()).preflight).toEqual({ instructions: "画面で変えた" });
    expect(YAML.parse(readFileSync(join(p.dataDir, "project.yaml"), "utf8")).preflight).toEqual({ runner: "agent", instructions: "画面で変えた" });
  });

  it("whoami はサインインしていないマシンで Codex は使えないことと、サインインの方法・手元の AI に頼む方法を出す", () => {
    const root = repo();
    expect(p3(root, ["init", "--yes", "--project", "a"]).code).toBe(0);
    const j = p3(root, ["whoami", "--json"]).json().preflight;
    expect(j).toMatchObject({ codex: false, auth: "none" });
    expect(j.detail).toContain("p3 chatgpt login");
    const t = p3(root, ["whoami"]).out;
    expect(t).toContain("Preflight     Codex は使えません");
    expect(t).toContain("手元の AI エージェントに「要望 <要望ID> の Preflight をして」と頼めます");
  });

  it("whoami の Preflight の行は Codex の診断をそのまま使う（使える・接続済みで準備不足・旧来の認証）", async () => {
    const at = (s: EngineStatus) => codexAvailability({ assistant: { codex: { status: async () => s } as never, engine: async () => "mock" } });
    const ok = await at({ name: "codex", ok: true, auth: "chatgpt", detail: "Codex（codex-workspace）で評価します · ChatGPT プラン" });
    expect(ok).toMatchObject({ codex: true, auth: "chatgpt" });
    expect(ok.text).toContain("Codex で実行できます");
    const docker = await at({ name: "codex", ok: false, auth: "chatgpt", detail: "Codex を使えません: docker コマンドがありません" });
    expect(docker).toMatchObject({ codex: false, auth: "chatgpt" });
    expect(docker.text).toBe("Codex は使えません: docker コマンドがありません。手元の AI エージェントに「要望 <要望ID> の Preflight をして」と頼めます");
    expect((await at({ name: "codex", ok: true, auth: "legacy", detail: "旧来の認証" })).codex).toBe(true);
  });

  it("Codex が使えなくても、人が頼んだ手元の評価（--prepare / --cancel）は使える", () => {
    const root = repo();
    expect(p3(root, ["init", "--yes", "--project", "a"]).code).toBe(0);
    const rid = p3(root, ["request", "new", "要望", "--body", "本文", "--json"]).json().id;
    const prep = p3(root, ["preflight", rid, "--prepare", "--json"]);
    expect(prep.code, prep.err).toBe(0);
    expect(prep.json()).toMatchObject({ run: expect.stringMatching(/^PF-/) });
    expect(p3(root, ["preflight", rid, "--cancel", "--run", prep.json().run]).code).toBe(0);
  });
});
