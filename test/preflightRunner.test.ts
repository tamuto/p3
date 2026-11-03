import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { init } from "../src/cli/project.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { gitInit, makeProject, tempDir } from "./helpers.ts";

/**
 * Preflight の担当（project.yaml の preflight.runner: codex / agent）。共有の設定で、未設定は codex。
 * AI 向けの手順を選ぶ方針で、p3 preflight のエンジンや --prepare / --complete は変えない
 */

const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
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
  const root = tempDir("p3-runner-");
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

describe("Preflight の担当（preflight.runner）", () => {
  it("非対話の init は codex。--preflight-runner agent で agent を保存し、最後の案内も担当で変わる", () => {
    const a = repo();
    const r = p3(a, ["init", "--yes", "--project", "a"]);
    expect(r.code, r.err).toBe(0);
    expect(yamlOf(a).preflight).toEqual({ runner: "codex" });
    expect(r.out).toContain("Preflight     codex");
    expect(r.out).toContain("p3 preflight <要望ID>");

    const b = repo();
    const s = p3(b, ["init", "--yes", "--project", "b", "--preflight-runner", "agent"]);
    expect(s.code, s.err).toBe(0);
    expect(yamlOf(b).preflight).toEqual({ runner: "agent" });
    expect(s.out).toContain("手元の AI エージェントに「要望 <要望ID> の Preflight をして」と頼む");
    expect(s.out).not.toContain("→  p3 preflight <要望ID>");
  });

  it("init の不正な担当は、何も作らずに断る", () => {
    const root = repo();
    const r = p3(root, ["init", "--yes", "--project", "a", "--preflight-runner", "claude"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--preflight-runner は codex / agent");
    expect(existsSync(join(root, ".p3"))).toBe(false);
    // join では受け付けない（共有の定義は変えない）
    expect(p3(root, ["join", "--yes", "--preflight-runner", "agent"]).err).toContain("--preflight-runner");
  });

  it("対話の init は担当を尋ね、Enter は codex、agent を選べ、読めない答えは保存せずに断る", async () => {
    const asked: string[] = [];
    const enter = repo();
    await initWith(enter, { project: "enter", prompt: async (q) => (asked.push(q), "") });
    const q = asked.find((x) => x.startsWith("Preflight を実行するのは"));
    expect(q).toContain("[codex]");
    expect(yamlOf(enter).preflight).toEqual({ runner: "codex" });

    const agent = repo();
    await initWith(agent, { project: "agent", prompt: async (x) => (x.startsWith("Preflight を実行するのは") ? "agent" : "") });
    expect(yamlOf(agent).preflight).toEqual({ runner: "agent" });

    const bad = repo();
    await expect(initWith(bad, { project: "bad", prompt: async (x) => (x.startsWith("Preflight を実行するのは") ? "human" : "") })).rejects.toThrow("codex / agent");
    expect(existsSync(join(bad, ".p3", "project.yaml"))).toBe(false);
  });

  it("以前のプロジェクト（runner が無い）は codex（既定）と出し、config set で変えて読み直しても残る", () => {
    const root = repo();
    expect(p3(root, ["init", "--yes", "--project", "a"]).code).toBe(0);
    // 以前の形: preflight に runner が無い
    writeFileSync(join(root, ".p3", "project.yaml"), "name: a\nbranchPattern: req/{id}-{slug}\npreflight:\n  instructions: 外部 API は要相談\n");
    expect(p3(root, ["whoami", "--json"]).json().preflight).toEqual({ runner: "codex", source: "default" });
    expect(p3(root, ["whoami"]).out).toContain("Preflight     codex（人が p3 から実行する（Codex）。未設定なので既定）");
    expect(p3(root, ["config"]).out).toContain("preflight.runner  codex");

    const set = p3(root, ["config", "set", "preflight.runner=agent", "--json"]);
    expect(set.code, set.err).toBe(0);
    expect(yamlOf(root).preflight).toEqual({ instructions: "外部 API は要相談", runner: "agent" });
    expect(p3(root, ["whoami", "--json"]).json().preflight).toEqual({ runner: "agent", source: "project" });
    expect(p3(root, ["config", "--json"]).json()).toMatchObject({ preflight: { runner: "agent" }, preflightRunner: { runner: "agent", source: "project" } });

    // 観点だけを変えても担当は残り、同じ config set で両方を変えられる（順はどちらでも）
    expect(p3(root, ["config", "set", "instructions=画面は変えない"]).code).toBe(0);
    expect(yamlOf(root).preflight).toEqual({ instructions: "画面は変えない", runner: "agent" });
    expect(p3(root, ["config", "set", "preflight.runner=codex", "instructions=両方"]).code).toBe(0);
    expect(yamlOf(root).preflight).toEqual({ instructions: "両方", runner: "codex" });
    expect(p3(root, ["config", "set", "instructions=逆の順", "preflight.runner=agent"]).code).toBe(0);
    expect(yamlOf(root).preflight).toEqual({ instructions: "逆の順", runner: "agent" });

    // 読めない値は保存しない
    const bad = p3(root, ["config", "set", "preflight.runner=human"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("preflight.runner は codex / agent");
    expect(yamlOf(root).preflight.runner).toBe("agent");
  });

  it("project.yaml の読めない担当は agent と推測せず、直し方を出す。観点を保存しても消さず、config set で直せる", () => {
    const root = repo();
    expect(p3(root, ["init", "--yes", "--project", "a"]).code).toBe(0);
    writeFileSync(join(root, ".p3", "project.yaml"), "name: a\nbranchPattern: req/{id}-{slug}\npreflight:\n  runner: Agent\n");
    const who = p3(root, ["whoami", "--json"]).json().preflight;
    expect(who.runner).toBeNull();
    expect(who.problem).toContain("preflight.runner が読めません: Agent");
    expect(who.problem).toContain("p3 config set preflight.runner=");
    expect(p3(root, ["whoami"]).out).toContain("（読めません）");

    expect(p3(root, ["config", "set", "instructions=観点"]).code).toBe(0);
    expect(yamlOf(root).preflight).toEqual({ instructions: "観点", runner: "Agent" });
    expect(p3(root, ["config", "set", "preflight.runner=agent"]).code).toBe(0);
    expect(yamlOf(root).preflight).toEqual({ instructions: "観点", runner: "agent" });
    expect(p3(root, ["whoami", "--json"]).json().preflight).toEqual({ runner: "agent", source: "project" });
  });

  it("画面の保存（以前の形 { instructions } と、画面が送る今の設定の形）でも担当は残る", async () => {
    const p = await makeProject();
    const app = apiRoutes(p.ctx);
    const put = async (body: unknown) => {
      const res = await app.request("/project", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    await p.ctx.ws.saveProject({ preflight: { runner: "agent" } });
    // 以前の形: 観点だけ
    expect((await put({ preflight: { instructions: "観点" } })).body.preflight).toMatchObject({ instructions: "観点", runner: "agent" });
    // 画面（settings.tsx）は読んだ preflight に観点を重ねて送る
    const shown = (await (await app.request("/project")).json()).project;
    const draft = { name: shown.name, description: shown.description, branchPattern: shown.branchPattern, preflight: { ...shown.preflight, instructions: "画面で変えた" } };
    expect((await put(draft)).body.preflight).toMatchObject({ instructions: "画面で変えた", runner: "agent" });
    expect(YAML.parse(readFileSync(join(p.dataDir, "project.yaml"), "utf8")).preflight).toEqual({ instructions: "画面で変えた", runner: "agent" });
    // 読めない担当は API で受け付けない
    expect((await put({ preflight: { runner: "human" } })).status).toBe(400);
  });

  it("担当は手順を選ぶ方針で、codex でも agent でも手元の評価（--prepare / --cancel）はそのまま使える", () => {
    for (const runner of ["codex", "agent"]) {
      const root = repo();
      expect(p3(root, ["init", "--yes", "--project", runner, "--preflight-runner", runner]).code).toBe(0);
      const rid = p3(root, ["request", "new", "要望", "--body", "本文", "--json"]).json().id;
      const prep = p3(root, ["preflight", rid, "--prepare", "--json"]);
      expect(prep.code, prep.err).toBe(0);
      expect(prep.json()).toMatchObject({ run: expect.stringMatching(/^PF-/) });
      expect(p3(root, ["preflight", rid, "--cancel", "--run", prep.json().run]).code).toBe(0);
    }
  });
});
