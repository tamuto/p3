import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");

describe("依存の指定", () => {
  it("codex-workspace は公開版の範囲で指定し、手元のフォルダへのリンクを残さない", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["@infodb/codex-workspace"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["@llmcs/codex-workspace"]).toBeUndefined();
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.entries(all).filter(([, v]) => /^(link|file|portal):/.test(String(v)))).toEqual([]);
    expect(read("pnpm-lock.yaml")).not.toMatch(/\b(link|file):\.\.?\//);
  });

  it("公開から日の浅い版を待たずに入れる例外を置かない", () => {
    expect(read("pnpm-workspace.yaml")).not.toMatch(/minimumReleaseAgeExclude/);
  });
});
