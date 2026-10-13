import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { apiRoutes } from "../src/server/api/routes.ts";
import { connectionPath, loadConnection, saveConnection } from "../src/core/chatgpt/store.ts";
import { loadUserConfig, setProjectNode, updateUserConfig, UserConfigError, userConfigPath } from "../src/core/userConfig.ts";
import { readTheme, ThemeInputError, writeTheme } from "../src/core/userTheme.ts";
import { makeProject, tempDir } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));

/** 個人設定の置き場所（XDG_CONFIG_HOME）をテストごとに分ける */
let home = "";
let keep: string | undefined;
beforeEach(() => {
  keep = process.env.XDG_CONFIG_HOME;
  home = tempDir("p3-theme-");
  process.env.XDG_CONFIG_HOME = home;
});
afterEach(() => {
  if (keep === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = keep;
});
const file = () => join(home, "infodb-p3", "config.yaml");
const write = (text: string) => {
  mkdirSync(join(home, "infodb-p3"), { recursive: true });
  writeFileSync(file(), text);
};

function p3(cwd: string, args: string[]) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: home };
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("画面のテーマ（個人設定の ui.theme）", () => {
  it("既定は system。3つの値を書けて、XDG_CONFIG_HOME の下に保存する", async () => {
    expect(userConfigPath()).toBe(file());
    expect(await readTheme()).toBe("system");
    for (const t of ["light", "dark", "system"] as const) {
      expect(await writeTheme(t)).toBe(t);
      expect(await readTheme()).toBe(t);
    }
    expect(YAML.parse(readFileSync(file(), "utf8")).ui.theme).toBe("system");
  });

  it("新しく書く値は確かめ、ファイルにある読めない値は system として読む", async () => {
    await expect(writeTheme("blue")).rejects.toBeInstanceOf(ThemeInputError);
    await expect(writeTheme(undefined)).rejects.toBeInstanceOf(ThemeInputError);
    write("ui:\n  theme: purple\n");
    expect(await readTheme()).toBe("system");
    expect(readFileSync(file(), "utf8")).toBe("ui:\n  theme: purple\n");
  });

  it("テーマだけを変え、コメント・ui のほかの項目・マシンの設定・知らない項目・プロジェクトは残す", async () => {
    const before = [
      "# 自分のメモ",
      "projects:",
      "  a: { dir: /data/a } # A のデータ",
      "ui:",
      "  theme: light",
      "  density: compact # 将来の項目",
      "codex:",
      "  pathMap:",
      "    /workspaces: /home/me/workspaces",
      "future: { x: 1 }",
      "",
    ].join("\n");
    write(before);
    await writeTheme("dark");
    const after = readFileSync(file(), "utf8");
    expect(after).toBe(before.replace("theme: light", "theme: dark"));
  });

  it("壊れた YAML と読めないファイルは、書かずに直し方を出す（無いのとは区別する）", async () => {
    const broken = "projects:\n  a: [\n";
    write(broken);
    await expect(writeTheme("dark")).rejects.toThrow(/YAML が壊れています.*ファイルは変えていません/);
    await expect(updateUserConfig((doc) => setProjectNode(doc, "b", { dir: "/data/b", repos: {} }))).rejects.toBeInstanceOf(UserConfigError);
    expect(readFileSync(file(), "utf8")).toBe(broken);

    // ファイルの代わりにフォルダがある（読めない）
    const dirHome = tempDir("p3-theme-dir-");
    mkdirSync(join(dirHome, "infodb-p3", "config.yaml"), { recursive: true });
    process.env.XDG_CONFIG_HOME = dirHome;
    await expect(readTheme()).rejects.toThrow(/個人設定を読めません.*EISDIR/);
    await expect(writeTheme("dark")).rejects.toBeInstanceOf(UserConfigError);
  });

  it("ChatGPT の接続のファイルと互いに消し合わない", async () => {
    await saveConnection({ hostId: "urn:uuid:h", clientId: "oaiapp_1" });
    await writeTheme("dark");
    expect(await loadConnection()).toMatchObject({ hostId: "urn:uuid:h", clientId: "oaiapp_1" });
    await saveConnection({ hostId: "urn:uuid:h2" });
    expect(await readTheme()).toBe("dark");
    expect(connectionPath()).not.toBe(file());
  });

  it("同時に別の項目を変えても、両方とも残る（同じプロセス）", async () => {
    await Promise.all([
      writeTheme("dark"),
      ...Array.from({ length: 8 }, (_, i) => updateUserConfig((doc) => setProjectNode(doc, `p${i}`, { dir: `/data/p${i}`, repos: {} }))),
    ]);
    const cfg = await loadUserConfig();
    expect(Object.keys(cfg.projects).sort()).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
    expect(cfg.ui.theme).toBe("dark");
  });

  it("別のプロセスが同時に project add と user-config set をしても、両方とも残る", async () => {
    const cwd = tempDir("p3-theme-cwd-");
    const dirs = Array.from({ length: 5 }, (_, i) => {
      const d = tempDir(`p3-theme-data${i}-`);
      writeFileSync(join(d, "project.yaml"), "name: x\n");
      return d;
    });
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: home };
    const run = (args: string[]) =>
      new Promise<number | null>((res) => spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: "ignore" }).on("exit", res));
    const codes = await Promise.all([
      ...dirs.map((d, i) => run(["project", "add", `p${i}`, d])),
      run(["user-config", "set", "ui.theme=light"]),
      run(["user-config", "set", "ui.theme=light"]),
    ]);
    expect(codes).toEqual(codes.map(() => 0));
    const cfg = await loadUserConfig();
    expect(Object.keys(cfg.projects).sort()).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(cfg.ui.theme).toBe("light");
    // 片方ずつでも（rm の後に theme）
    expect(p3(cwd, ["project", "rm", "p0"]).code).toBe(0);
    expect(p3(cwd, ["user-config", "set", "ui.theme=dark"]).code).toBe(0);
    expect(Object.keys((await loadUserConfig()).projects).sort()).toEqual(["p1", "p2", "p3", "p4"]);
  }, 60_000);
});

describe("p3 user-config", () => {
  it("プロジェクトが無くても動き、テーマとマシンごとの設定を出どころつきで見せる（プロジェクトの登録は出さない。--json も）", () => {
    const cwd = tempDir("p3-nowhere-");
    write("projects:\n  secret: { dir: /data/secret }\ncodex:\n  authVolume: vol\n  pathMap:\n    /workspaces: /home/me/ws\n");
    const show = p3(cwd, ["user-config", "--json"]);
    expect(show.code, show.err).toBe(0);
    const json = JSON.parse(show.out);
    expect(json.ui).toEqual({ theme: "system" });
    expect(json.path).toBe(file());
    expect(json.settings.find((r: any) => r.key === "codex.authVolume")).toMatchObject({ value: "vol", from: "個人設定" });
    expect(json.settings.find((r: any) => r.key === "codex.pathMap")).toMatchObject({ value: "/workspaces → /home/me/ws", from: "個人設定" });
    expect(json.settings.find((r: any) => r.key === "serve.port")).toMatchObject({ value: "4310", from: "既定" });
    const set = p3(cwd, ["user-config", "set", "ui.theme=dark", "--json"]);
    expect(set.code, set.err).toBe(0);
    expect(JSON.parse(set.out)).toEqual({ changed: ["ui.theme"], path: file() });
    const text = p3(cwd, ["user-config"]).out;
    expect(text).toMatch(/ui\.theme +dark/);
    expect(text).toMatch(/codex\.ensureImage +true +（既定）/);
    expect(text).not.toContain("secret");
  });

  it("set でマシンごとの設定を書き・消し、パスの対応を1件ずつ足し・外す。コメントとほかの項目は残す", () => {
    const cwd = tempDir("p3-nowhere-");
    write("# 個人設定\nprojects:\n  a: { dir: /data/a }\ncodex:\n  model: gpt-x # 使っているモデル\n");
    const run = (...pairs: string[]) => {
      const r = p3(cwd, ["user-config", "set", ...pairs]);
      expect(r.code, r.err).toBe(0);
      return YAML.parse(readFileSync(file(), "utf8"));
    };
    let y = run("codex.pathMap+=/workspaces=/home/me/ws", "codex.pathMap+=/mnt/assets=/mnt/usb/assets", "codex.ensureImage=false", "serve.port=4400", "codex.authVolume=codex-state");
    expect(y.codex).toEqual({ model: "gpt-x", pathMap: { "/workspaces": "/home/me/ws", "/mnt/assets": "/mnt/usb/assets" }, ensureImage: false, authVolume: "codex-state" });
    expect(y.serve).toEqual({ port: 4400 });
    expect(y.projects).toEqual({ a: { dir: "/data/a" } });
    expect(readFileSync(file(), "utf8")).toContain("# 使っているモデル");
    y = run("codex.pathMap+=/workspaces=/root/ws"); // 同じパスは置き換える
    expect(y.codex.pathMap["/workspaces"]).toBe("/root/ws");
    y = run("codex.pathMap-=/mnt/assets", "serve.port=");
    expect(y.codex.pathMap).toEqual({ "/workspaces": "/root/ws" });
    expect(y.serve).toBeUndefined(); // 空になった項目は消す
    y = run("codex.pathMap=");
    expect(y.codex.pathMap).toBeUndefined();
  });

  it("読めない値はどれも書かず、書き方を出す", () => {
    const cwd = tempDir("p3-nowhere-");
    write("codex:\n  model: gpt-x\n");
    for (const [pairs, msg] of [
      [["codex.pathMap+=relative=/x"], "どちらも絶対パス"],
      [["codex.pathMap+=/workspaces"], "codex.pathMap+=<このマシンのパス>=<Docker デーモンから見たパス>"],
      [["codex.pathMap=/a=/b"], "1件ずつ codex.pathMap+="],
      [["codex.pathMap-=/nothing"], "対応はありません"],
      [["codex.auth=other"], "auto / legacy"],
      [["serve.port=99999"], "1〜65535"],
      [["codex.ensureImage=maybe"], "true か false"],
      [["codex.model=gpt-y", "preflight.engine=nope"], "codex / mock"],
      [["ui.theme=dark", "codex.auth=other"], "auto / legacy"],
    ] as [string[], string][]) {
      const r = p3(cwd, ["user-config", "set", ...pairs]);
      expect(r.code, pairs.join(" ")).toBe(1);
      expect(r.err).toContain(msg);
    }
    expect(readFileSync(file(), "utf8")).toBe("codex:\n  model: gpt-x\n");
  });

  it("読めない値・知らないキーは終了コード 1 で、ファイルを変えない", () => {
    const cwd = tempDir("p3-nowhere-");
    write("ui:\n  theme: light\n");
    const bad = p3(cwd, ["user-config", "set", "ui.theme=blue"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("system / light / dark");
    const key = p3(cwd, ["user-config", "set", "projects.a=/x"]);
    expect(key.code).toBe(1);
    expect(key.err).toContain("変更できるキー: ui.theme codex.auth");
    write("ui: [\n");
    const broken = p3(cwd, ["user-config", "set", "ui.theme=dark"]);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("YAML が壊れています");
    expect(readFileSync(file(), "utf8")).toBe("ui: [\n");
  });
});

describe("/api/user-theme", () => {
  async function setup() {
    const p = await makeProject();
    const events: unknown[] = [];
    p.ctx.ws.on((e) => events.push(e));
    const app = apiRoutes(p.ctx);
    const call = async (method: string, opt: { body?: unknown; addr?: string; origin?: string | null } = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const origin = opt.origin === undefined ? "http://localhost:4310" : opt.origin;
      if (origin) headers.origin = origin;
      const res = await app.request(
        "/user-theme",
        { method, headers, body: opt.body === undefined ? undefined : typeof opt.body === "string" ? opt.body : JSON.stringify(opt.body) },
        { incoming: { socket: { remoteAddress: opt.addr ?? "127.0.0.1" } } },
      );
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
    };
    return { call, events };
  }

  it("テーマだけを返し、キャッシュさせない", async () => {
    const { call } = await setup();
    write("projects:\n  a: { dir: /data/a }\nui:\n  theme: dark\ncodex:\n  authVolume: vol\n");
    const r = await call("GET");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ theme: "dark" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    // ファイルを変えれば次の GET に出る
    write("ui:\n  theme: light\n");
    expect((await call("GET")).body).toEqual({ theme: "light" });
  });

  it("変更はこのマシンのローカルの画面からだけ。テーマ以外のキー・読めない値は断る", async () => {
    const { call, events } = await setup();
    expect((await call("PUT", { body: { theme: "dark" } })).body).toEqual({ theme: "dark" });
    expect(await readTheme()).toBe("dark");
    expect(events).toEqual([{ type: "changed", kind: "user" }]); // 開いているほかの画面へ知らせる
    expect((await call("PUT", { body: { theme: "light" }, addr: "192.168.1.20" })).status).toBe(403);
    expect((await call("PUT", { body: { theme: "light" }, origin: null })).status).toBe(403);
    expect((await call("PUT", { body: { theme: "light" }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("PUT", { body: { theme: "light", projects: {} } })).status).toBe(400);
    expect((await call("PUT", { body: { theme: "blue" } })).status).toBe(400);
    expect((await call("PUT", { body: "not json" })).status).toBe(400);
    expect(await readTheme()).toBe("dark");
  });

  it("個人設定が壊れていれば 500 で知らせ、書かない", async () => {
    const { call } = await setup();
    write("ui: [\n");
    const r = await call("PUT", { body: { theme: "dark" } });
    expect(r.status).toBe(500);
    expect(r.body.error).toContain("YAML が壊れています");
    expect(readFileSync(file(), "utf8")).toBe("ui: [\n");
  });
});

describe("describeSettings（p3 user-config の表示）", () => {
  it("環境変数・個人設定・既定のどれから来た値かを出し、読めない値は理由を添える", async () => {
    const { describeSettings } = await import("../src/core/machineSettingsEdit.ts");
    const user = { settings: { codex: { model: "gpt-x", effort: "high" } } };
    const { rows, error } = describeSettings(user, { P3_CODEX_MODEL: "gpt-env", P3_CODEX_EFFORT: "" });
    expect(error).toBeUndefined();
    expect(rows.find((r) => r.key === "codex.model")).toMatchObject({ value: "gpt-env", from: "環境変数", env: "P3_CODEX_MODEL" });
    expect(rows.find((r) => r.key === "codex.effort")).toMatchObject({ value: "（なし）", from: "既定" }); // 空の環境変数は既定に戻す
    expect(rows.find((r) => r.key === "codex.auth")).toMatchObject({ value: "auto", from: "既定" });
    const bad = describeSettings({ settings: { serve: { port: "x" } } }, {});
    expect(bad.error).toContain("個人設定 serve.port が読めません");
    expect(bad.rows.find((r) => r.key === "serve.port")).toMatchObject({ value: "x", from: "個人設定" });
  });
});
