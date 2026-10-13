import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DOCS, links } from "./docLinks.ts";

const root = new URL("../", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");

describe("依存の指定", () => {
  it("llmcs の部品（codex-workspace・chatgpt-plan）は公開版の範囲で指定し、手元のフォルダへのリンクを残さない", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["@infodb/codex-workspace"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["@infodb/chatgpt-plan"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["@llmcs/codex-workspace"]).toBeUndefined();
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.entries(all).filter(([, v]) => /^(link|file|portal):/.test(String(v)))).toEqual([]);
    expect(read("pnpm-lock.yaml")).not.toMatch(/\b(link|file):\.\.?\//);
  });

  it("公開から日の浅い版を待たずに入れる例外は、自分たちが公開した @infodb の部品の版を固定したものだけ", () => {
    const ws = parse(read("pnpm-workspace.yaml")) as { minimumReleaseAgeExclude?: string[] };
    for (const e of ws.minimumReleaseAgeExclude ?? []) expect(e).toMatch(/^@infodb\/[a-z0-9-]+@\d+\.\d+\.\d+$/);
  });
});

describe("npm で配る中身", () => {
  const pkg = JSON.parse(read("package.json"));

  it("公開できる manifest（スコープ付きの公開・Node の版・bin・公開前のビルド）", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.name).toBe("@infodb/p3");
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.license).toBe("MIT");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.bin).toEqual({ p3: "bin/p3.mjs" });
    expect(pkg.scripts.prepack).toBe("pnpm build");
    // 利用者が入れるときにビルドや Docker を動かさない
    for (const s of ["preinstall", "install", "postinstall", "prepare"]) expect(pkg.scripts[s]).toBeUndefined();
  });

  it("実行に要るものだけを実行時の依存にする（画面はビルドして配るので React などは開発用）", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@hono/node-server", "@infodb/chatgpt-plan", "@infodb/codex-workspace", "hono", "tsx", "yaml", "zod"]);
  });

  it("npm pack の一覧に、動かすのに要るものがあり、設定・テスト・開発用のものが無い", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: fileURLToPath(root), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const files: string[] = JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path);
    for (const f of ["package.json", "README.md", "LICENSE", "bin/p3.mjs", "src/cli/main.ts", "src/core/context.ts", "src/shared/types.ts", "skills/p3/SKILL.md", "src/core/preflight/render-image/Dockerfile", "src/core/preflight/render-image/render.mjs", "src/core/preflight/mock-ui.png", "src/core/preflight/mock-ui.html"]) {
      expect(files).toContain(f);
    }
    // 画面はビルドしてあれば入る（pnpm -s check はテストの後にビルドするので、ここでは有無だけ確かめる）
    if (existsSync(new URL("dist/web/index.html", root))) expect(files).toContain("dist/web/index.html");
    // README から辿る文書と、その文書のリンクの先も入る（npm のページから読んでも切れない）
    for (const doc of DOCS) {
      expect(files).toContain(doc);
      for (const { target } of links(doc)) expect(files, `${doc} → ${target}`).toContain(target);
    }
    const unwanted = files.filter((f) =>
      /^(\.env|\.p3|\.claude\/|\.serena\/|test\/|scripts\/|src\/web\/|node_modules\/|tsconfig|vite\.config|vitest\.config|pnpm-)/.test(f) || f.endsWith(".test.ts"),
    );
    expect(unwanted).toEqual([]);
  });
});
