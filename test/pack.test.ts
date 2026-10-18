import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitInit, tempDir } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * npm pack の中身だけで動くか（files の漏れが無いか）を、ネットワーク無しで確かめる。
 * 依存はこのチェックアウトの node_modules を借りる。実行時の依存だけでレジストリから入れる確認は scripts/verify-pack.mjs
 */
describe("npm pack の中身だけで動く", () => {
  it("別の場所に展開した p3 で init・whoami・Mock の Preflight・serve が動く", async () => {
    const work = tempDir("p3-pack-");
    const out = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], { cwd: ROOT, encoding: "utf8" });
    const tgz = join(work, JSON.parse(out)[0].filename);
    execFileSync("tar", ["xzf", tgz, "-C", work]);
    const pkg = join(work, "package");
    symlinkSync(join(ROOT, "node_modules"), join(pkg, "node_modules"));

    const repo = tempDir("p3-pack-repo-");
    gitInit(repo);
    writeFileSync(join(repo, "README.md"), "# sample\n");
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))),
      XDG_CONFIG_HOME: tempDir("p3-pack-config-"),
    };
    const p3 = (args: string[]) => {
      const r = spawnSync(process.execPath, [join(pkg, "bin", "p3.mjs"), ...args], { cwd: repo, encoding: "utf8", env });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };

    p3(["init", "--yes", "--agents", "--project", "sample", "--dir", join(work, "data")]);
    for (const dir of [".claude", ".agents"]) {
      expect(readFileSync(join(repo, dir, "skills", "p3", "SKILL.md"), "utf8")).toBe(readFileSync(join(ROOT, "skills", "p3", "SKILL.md"), "utf8"));
    }
    expect(JSON.parse(p3(["whoami", "--json"]))).toMatchObject({ project: "sample" });
    const rid = JSON.parse(p3(["request", "new", "通知", "--body", "- 送信\n- 設定", "--json"])).id;
    expect(JSON.parse(p3(["preflight", rid, "--engine", "mock", "--json"]))).toMatchObject({ status: "completed" });

    // serve: API はいつも、画面はビルドしてあれば（pnpm -s check はテストの後にビルドする）
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [join(pkg, "bin", "p3.mjs"), "serve", "--port", String(port), "--host", "127.0.0.1"], { cwd: repo, env });
    try {
      const get = async (path: string) => {
        for (let i = 0; ; i++) {
          try {
            return await fetch(`http://127.0.0.1:${port}${path}`);
          } catch (e) {
            if (i > 50) throw e;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      };
      expect(JSON.stringify(await (await get("/api/requests")).json())).toContain(rid);
      if (existsSync(join(pkg, "dist", "web", "index.html"))) {
        expect(await (await get("/")).text()).toContain('<div id="root">');
      }
    } finally {
      child.kill();
    }
  }, 60_000);
});
