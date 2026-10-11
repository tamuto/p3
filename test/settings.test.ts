import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, resolveMachineSettings, SETTING_KEYS, SettingsError } from "../src/server/machineSettings.ts";
import { loadUserConfig, normalizeUserConfig, saveUserConfig, userConfigPath } from "../src/server/userConfig.ts";
import { tempDir } from "./helpers.ts";

const user = (d: Record<string, unknown>) => normalizeUserConfig(d);
const resolve = (d: Record<string, unknown>, env: Record<string, string> = {}, cli = {}) => resolveMachineSettings(user(d), env, cli);

describe("マシンごとの設定", () => {
  it("何も無ければ既定値", () => {
    expect(resolve({})).toEqual(DEFAULT_SETTINGS);
  });

  it("個人設定から読む", () => {
    const s = resolve({
      codex: { auth: "legacy", authVolume: "vol", pathMap: { "/workspaces": "/home/me/workspaces" }, model: "m", effort: "high", ensureImage: false },
      preflight: { engine: "mock" },
      serve: { host: "127.0.0.1", port: 4400 },
    });
    expect(s).toEqual({
      codex: { auth: "legacy", authVolume: "vol", authFile: undefined, pathMap: [["/workspaces", "/home/me/workspaces"]], model: "m", effort: "high", ensureImage: false },
      preflight: { engine: "mock" },
      serve: { host: "127.0.0.1", port: 4400 },
    });
  });

  it("環境変数が個人設定より、CLI の明示が環境変数より優先する", () => {
    const d = { codex: { model: "from-config" }, serve: { port: 4400, host: "127.0.0.1" } };
    expect(resolve(d, { PCUBE_CODEX_MODEL: "from-env", PCUBE_PORT: "4500" }).codex.model).toBe("from-env");
    expect(resolve(d, { PCUBE_PORT: "4500" }).serve.port).toBe(4500);
    expect(resolve(d, { PCUBE_PORT: "4500", PCUBE_HOST: "0.0.0.0" }, { port: "4600", host: "::1" }).serve).toEqual({ port: 4600, host: "::1" });
  });

  it("環境変数を空にすると、個人設定を使わずに既定値に戻す", () => {
    const d = { codex: { model: "m", authVolume: "vol", pathMap: { "/a": "/b" }, ensureImage: false }, preflight: { engine: "mock" }, serve: { port: 4400 } };
    const s = resolve(d, { PCUBE_CODEX_MODEL: "", PCUBE_CODEX_AUTH_VOLUME: "", PCUBE_CODEX_PATH_MAP: "", PCUBE_CODEX_ENSURE_IMAGE: "", PCUBE_PREFLIGHT_ENGINE: "", PCUBE_PORT: "" });
    expect(s.codex).toMatchObject({ model: undefined, authVolume: undefined, pathMap: [], ensureImage: true });
    expect(s.preflight.engine).toBe("codex");
    expect(s.serve.port).toBe(4310);
  });

  it("イメージの更新は false / 0 で止まり、読めない値はエラー", () => {
    expect(resolve({}, { PCUBE_CODEX_ENSURE_IMAGE: "0" }).codex.ensureImage).toBe(false);
    expect(resolve({}, { PCUBE_CODEX_ENSURE_IMAGE: "false" }).codex.ensureImage).toBe(false);
    expect(resolve({ codex: { ensureImage: false } }, { PCUBE_CODEX_ENSURE_IMAGE: "1" }).codex.ensureImage).toBe(true);
    expect(resolve({ codex: { ensureImage: false } }).codex.ensureImage).toBe(false);
    expect(() => resolve({}, { PCUBE_CODEX_ENSURE_IMAGE: "maybe" })).toThrow(/PCUBE_CODEX_ENSURE_IMAGE.*maybe/);
    expect(() => resolve({ codex: { ensureImage: "maybe" } })).toThrow(/個人設定 codex.ensureImage/);
  });

  it("読めない値は、どこの何を直せばよいかをエラーにする", () => {
    expect(() => resolve({}, { PCUBE_PREFLIGHT_ENGINE: "fake" })).toThrow(SettingsError);
    expect(() => resolve({}, { PCUBE_PREFLIGHT_ENGINE: "fake" })).toThrow(/環境変数 PCUBE_PREFLIGHT_ENGINE.*codex \/ mock/);
    expect(() => resolve({ codex: { auth: "chatgpt" } })).toThrow(/個人設定 codex.auth.*auto \/ legacy/);
    expect(() => resolve({}, { PCUBE_PORT: "http" })).toThrow(/PCUBE_PORT/);
    expect(() => resolve({}, {}, { port: "70000" })).toThrow(/--port/);
    expect(() => resolve({ codex: { model: ["a"] } })).toThrow(/codex.model/);
  });

  it("パスの対応は環境変数（a=b,c=d）でも個人設定（対応表）でも書け、不正な指定は直し方を出す", () => {
    expect(resolve({}, { PCUBE_CODEX_PATH_MAP: " /workspaces=/root/workspaces , /a=/b " }).codex.pathMap).toEqual([
      ["/workspaces", "/root/workspaces"],
      ["/a", "/b"],
    ]);
    expect(resolve({ codex: { pathMap: { "/w": "C:\\Users\\me\\w" } } }).codex.pathMap).toEqual([["/w", "C:\\Users\\me\\w"]]);
    expect(() => resolve({}, { PCUBE_CODEX_PATH_MAP: "/workspaces" })).toThrow(/「\/workspaces」が読めません.*例: /);
    expect(() => resolve({}, { PCUBE_CODEX_PATH_MAP: "workspaces=/root/w" })).toThrow(/絶対パス/);
    expect(() => resolve({ codex: { pathMap: ["/a=/b"] } })).toThrow(/codex.pathMap/);
    expect(() => resolve({ codex: { pathMap: { "/a": 1 } } })).toThrow(/パスの文字列/);
  });

  it("環境変数の名前と個人設定の項目は1対1", () => {
    expect(new Set(Object.values(SETTING_KEYS)).size).toBe(Object.keys(SETTING_KEYS).length);
    expect(Object.values(SETTING_KEYS).every((n) => n.startsWith("PCUBE_"))).toBe(true);
  });
});

describe("個人設定のファイル", () => {
  it("XDG_CONFIG_HOME に従う", () => {
    const keep = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = "/x/conf";
      expect(userConfigPath()).toBe("/x/conf/infodb-p3/config.yaml");
    } finally {
      if (keep === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = keep;
    }
  });

  it("プロジェクトやテーマを保存しても、マシンの設定とコメントは残る", async () => {
    const path = join(tempDir("p3-settings-"), "config.yaml");
    writeFileSync(
      path,
      [
        "# 自分のメモ",
        "projects:",
        "  a: { dir: /data/a }",
        "codex:",
        "  # DevContainer のとき",
        "  pathMap:",
        "    /workspaces: /home/me/workspaces",
        "  ensureImage: false",
        "preflight:",
        "  engine: mock",
        "serve: { port: 4400 }",
        "",
      ].join("\n"),
    );
    const u = await loadUserConfig(path);
    u.projects.b = { dir: "/data/b", repos: { main: "/w/b" } };
    delete u.projects.a;
    u.ui.theme = "dark";
    await saveUserConfig(u, path);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# 自分のメモ");
    expect(text).toContain("# DevContainer のとき");
    const again = await loadUserConfig(path);
    expect(Object.keys(again.projects)).toEqual(["b"]);
    expect(again.ui.theme).toBe("dark");
    expect(resolveMachineSettings(again, {})).toMatchObject({
      codex: { pathMap: [["/workspaces", "/home/me/workspaces"]], ensureImage: false },
      preflight: { engine: "mock" },
      serve: { port: 4400 },
    });
  });
});

describe("入力されたパス", () => {
  it("~ をホームに展開する（対話式の入力ではシェルが展開しない）", async () => {
    const { homedir } = await import("node:os");
    const { resolvePath } = await import("../src/cli/project.ts");
    expect(resolvePath("/w", "~/p3-data/a")).toBe(join(homedir(), "p3-data/a"));
    expect(resolvePath("/w", "~")).toBe(homedir());
    expect(resolvePath("/w", "data")).toBe("/w/data");
    expect(resolvePath("/w", "~x")).toBe("/w/~x");
  });
});
