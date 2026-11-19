import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitInit, tempDir } from "./helpers.ts";
import { DOCS, links } from "./docLinks.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * npm pack の中身だけで動くか（files の漏れが無いか）を、ネットワーク無しで確かめる。
 * 公開する中身は scripts/build-cli.mjs が dist/package に組み立てる（入口・製品（tasks・observer）・kit を同梱した lib/、skills・docs・README・LICENSE、開発だけの項目を外した manifest）。
 * 配布物はソース（src/・packages/）を含まないので、bin はビルドした lib/ を動かす（tsx を使わない）。依存は入口のパッケージ（packages/p3）の node_modules を借りる。
 * 実行時の依存だけでレジストリから入れる確認は scripts/verify-pack.mjs
 */
describe("npm pack の中身だけで動く", () => {
  it("別の場所に展開した p3 で init・whoami・Mock の Preflight・serve が動く", async () => {
    const work = tempDir("p3-pack-");
    // 配布物の CLI・serve（lib/）と公開する中身を今のソースから作ってから詰める（pnpm -s check はテストの後に画面をビルドするので、画面は無くてもよい）
    execFileSync(process.execPath, [join(ROOT, "scripts", "build-cli.mjs")], { cwd: ROOT, encoding: "utf8" });
    const out = execFileSync("npm", ["pack", "./dist/package", "--json", "--ignore-scripts", "--pack-destination", work], { cwd: ROOT, encoding: "utf8" });
    const tgz = join(work, JSON.parse(out)[0].filename);
    execFileSync("tar", ["xzf", tgz, "-C", work]);
    const pkg = join(work, "package");
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    // 入口・同梱した製品（tasks・observer の Node 側の雛形）・kit の JavaScript と資材が lib/ に入る
    for (const f of ["bin/p3.mjs", "lib/cli/main.js", "lib/cli/guide.md", "lib/tasks/cli/tasksCli.js", "lib/kit/fsutil.js", "lib/tasks/core/preflight/render-image/Dockerfile", "lib/tasks/core/preflight/render-image/render.mjs", "lib/tasks/core/preflight/mock-ui.png", "lib/tasks/core/preflight/mock-ui.html", "lib/tasks/core/preflight/launcher.mjs", "lib/observer/core/status.js", "lib/observer/cli/observerCli.js", "lib/observer/server/api/routes.js", "lib/observer/shared/status.js"]) {
      expect(files, f).toContain(f);
    }
    // README から辿る文書と、その文書のリンクの先も入る（npm のページから読んでも切れない）
    for (const f of ["package.json", "README.md", "LICENSE", "skills/p3/SKILL.md"]) expect(files).toContain(f);
    for (const doc of DOCS) {
      expect(files).toContain(doc);
      for (const { target } of links(doc)) expect(files, `${doc} → ${target}`).toContain(target);
    }
    // ソース・設定・テスト・開発用のものは入れない（実行はビルド済みの lib/。tsx・esbuild を利用者の環境に入れない）
    const unwanted = files.filter((f) => /^(\.env|\.p3|\.claude\/|\.serena\/|test\/|scripts\/|src\/|packages\/|build-src\/|node_modules\/|tsconfig|vite\.config|vitest\.config|pnpm-)/.test(f) || f.endsWith(".ts"));
    expect(unwanted).toEqual([]);
    // 実行時の import に workspace のパッケージ名が残らない（同梱した先への相対パスに書き換わる）
    const leftover = files.filter((f) => f.endsWith(".js") && /from\s*["']@infodb\/p3-|import\(\s*["']@infodb\/p3-/.test(readFileSync(join(pkg, f), "utf8")));
    expect(leftover).toEqual([]);
    // 公開する manifest は開発だけの項目（workspace の参照・scripts）を持たない
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    expect([manifest.devDependencies, manifest.scripts]).toEqual([undefined, undefined]);
    expect(JSON.stringify(manifest)).not.toMatch(/workspace:|link:|file:|@infodb\/p3-/);
    symlinkSync(join(ROOT, "packages", "p3", "node_modules"), join(pkg, "node_modules"));

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

    // 手順（guide）は配布物に同梱した原本とそのパッケージの版を返す（登録の前でも読める。ソースは使わない）
    const g = JSON.parse(p3(["guide", "--json"]));
    expect(g).toMatchObject({ schemaVersion: 1, entryVersion: 1, cliVersion: JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version });
    expect(g.guide).toBe(readFileSync(join(pkg, "lib", "cli", "guide.md"), "utf8"));
    expect(g.guide).toBe(readFileSync(join(ROOT, "packages", "p3", "src", "cli", "guide.md"), "utf8"));
    p3(["init", "--yes", "--agents", "--project", "sample", "--dir", join(work, "data")]);
    const original = readFileSync(join(ROOT, "skills", "p3", "SKILL.md"), "utf8");
    for (const dir of [".claude", ".agents"]) {
      expect(readFileSync(join(repo, dir, "skills", "p3", "SKILL.md"), "utf8")).toBe(original);
    }
    // 選んだ先だけを最新にする（p3 agents）。選ばなかった先は変えない
    const claude = join(repo, ".claude", "skills", "p3", "SKILL.md");
    const codex = join(repo, ".agents", "skills", "p3", "SKILL.md");
    writeFileSync(claude, "# 古い版\n");
    writeFileSync(codex, "# 古い版\n");
    expect(p3(["agents", "claude"])).toContain("保護");
    expect(p3(["agents", "claude", "--force"])).toContain("更新");
    expect(readFileSync(claude, "utf8")).toBe(original);
    expect(readFileSync(codex, "utf8")).toBe("# 古い版\n");
    expect(JSON.parse(p3(["whoami", "--json"]))).toMatchObject({ project: "sample" });
    const rid = JSON.parse(p3(["request", "new", "通知", "--body", "- 送信\n- 設定", "--json"])).id;
    expect(JSON.parse(p3(["preflight", rid, "--engine", "mock", "--json"]))).toMatchObject({ status: "completed" });
    // 機能のまとまり（features/）に移したコマンドも同梱した JavaScript で動く
    expect(JSON.parse(p3(["metrics", "--json"]))).toMatchObject({ scope: { kind: "project" }, metrics: expect.any(Array) });

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
