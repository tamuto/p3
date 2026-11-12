import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { qualityView, updateQuality } from "../src/core/quality.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { applyQualityOps, QualityInputError, qualityVersion, readQuality, standardsFor, templateDiffs, type QualityTemplate } from "../src/shared/quality.ts";
import { QUALITY_TEMPLATES } from "../src/shared/qualityTemplates.ts";
import { makeProject, openTestProject, tempDir } from "./helpers.ts";

/**
 * プロジェクトの品質基準（shared/quality.ts・core/quality.ts・project.yaml の quality）: 未設定・設定済み（空を含む）・読めないの区別、
 * 重複した ID・知らない参照先・理由の無い除外、ID を使い直さないこと、テンプレートの採用と改版の差分、保存の往復、ほかの保存で
 * 消えないこと・コメントと知らない項目を残すこと、版の競合、CLI と API の同じ結果
 */

const ctx0 = { repoNames: ["app", "infra"], templates: QUALITY_TEMPLATES };

describe("規則（shared）", () => {
  it("無い・空・読めないを分け、重複した ID・理由の無い除外は読めない、知らない参照先は警告", () => {
    expect(readQuality(undefined)).toEqual({ state: "unset" });
    expect(readQuality({ standards: [] })).toEqual({ state: "set", config: { standards: [] } });
    expect(readQuality("文字")).toMatchObject({ state: "invalid" });
    const dup = readQuality({ standards: [{ id: "Q1", text: "a", check: { kind: "manual", reference: "r" } }, { id: "Q1", text: "b", check: { kind: "manual", reference: "r" } }] });
    expect(dup).toMatchObject({ state: "invalid", problems: [expect.stringContaining("重複")] });
    expect(readQuality({ standards: [{ id: "Q1", text: "a", check: { kind: "manual", reference: "r" }, exempt: {} }] })).toMatchObject({ state: "invalid", problems: [expect.stringContaining("理由")] });
    expect(readQuality({ standards: [{ id: "Q1", text: "a", check: { kind: "machine", command: "x" } }] })).toMatchObject({ state: "invalid" });
    expect(readQuality({ standards: [{ id: "Q1", text: "a", repos: ["nope"], check: { kind: "manual", reference: "r" } }] }, ["app"])).toMatchObject({ state: "set", warnings: [expect.stringContaining("nope")] });
    expect(qualityVersion({ state: "unset" })).not.toBe(qualityVersion({ state: "set", config: { standards: [] } }));
  });

  it("テンプレートを写して採用し、消した ID を使い直さない。対象・除外・置き換え", () => {
    let c = applyQualityOps({ state: "unset" }, [{ op: "adopt", template: "basic" }], ctx0);
    expect(c.standards.map((s) => s.id)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(c.standards[0].source).toEqual({ template: "basic", version: 1, key: "conventions" });
    expect(c.templates).toEqual([{ id: "basic", version: 1 }]);
    expect(() => applyQualityOps({ state: "set", config: c }, [{ op: "adopt", template: "basic" }], ctx0)).toThrow(QualityInputError);
    c = applyQualityOps({ state: "set", config: c }, [{ op: "remove", id: "Q4" }, { op: "add", standard: { text: "lint", repos: ["app"], check: { kind: "machine", command: "pnpm lint", success: "0" } } }], ctx0);
    expect(c.standards.map((s) => s.id)).toEqual(["Q1", "Q2", "Q3", "Q5"]);
    expect(c.seq).toBe(5);
    expect(() => applyQualityOps({ state: "set", config: c }, [{ op: "add", standard: { text: "x", repos: ["nope"], check: { kind: "manual", reference: "r" } } }], ctx0)).toThrow(/登録されていません/);
    expect(() => applyQualityOps({ state: "set", config: c }, [{ op: "exempt", id: "Q1", reason: " " }], ctx0)).toThrow(QualityInputError);
    c = applyQualityOps({ state: "set", config: c }, [{ op: "exempt", id: "Q2", reason: "小さい CLI なので層が無い" }], ctx0);
    expect(standardsFor(c, "infra")).toMatchObject({ applies: [{ id: "Q1" }, { id: "Q3" }], exempt: [{ id: "Q2" }] });
    expect(standardsFor(c, "app").applies.map((s) => s.id)).toEqual(["Q1", "Q3", "Q5"]);
    expect(standardsFor(c, null).applies.map((s) => s.id)).toEqual(["Q1", "Q3"]);
    c = applyQualityOps({ state: "set", config: c }, [{ op: "replace", standards: [{ id: "Q5", text: "lint を通す", repos: [], check: { kind: "machine", command: "pnpm lint", success: "0" } }, { text: "新", check: { kind: "manual", reference: "r" } }] }], ctx0);
    expect(c.standards.map((s) => [s.id, s.text])).toEqual([["Q5", "lint を通す"], ["Q6", "新"]]);
    expect(() => applyQualityOps({ state: "invalid", problems: ["x"] }, [{ op: "init" }], ctx0)).toThrow(/読めない/);
  });

  it("テンプレートが改版しても採用済みの内容は変わらず、差分を見て明示して当てる", () => {
    const v2: QualityTemplate = { ...QUALITY_TEMPLATES[0], version: 2, items: [{ ...QUALITY_TEMPLATES[0].items[0], text: "規約に従う（改版）" }, ...QUALITY_TEMPLATES[0].items.slice(1, 3), { key: "security", text: "秘密を書かない", check: { kind: "manual", reference: "r" } }] };
    const templates = [...QUALITY_TEMPLATES, v2];
    const c = applyQualityOps({ state: "unset" }, [{ op: "adopt", template: "basic", version: 1 }], { ...ctx0, templates });
    expect(c.standards[0].text).toBe(QUALITY_TEMPLATES[0].items[0].text);
    const [d] = templateDiffs(c, templates);
    expect(d).toMatchObject({ template: "basic", from: 1, to: 2, added: [{ key: "security" }], changed: [{ key: "conventions", ids: ["Q1"] }], removed: [{ key: "docs", ids: ["Q4"] }] });
    const up = applyQualityOps({ state: "set", config: c }, [{ op: "upgrade", template: "basic" }], { ...ctx0, templates });
    expect(up.standards.find((s) => s.id === "Q1")!.text).toBe("規約に従う（改版）");
    expect(up.standards.find((s) => s.id === "Q4")!.source).toBeUndefined();
    expect(up.standards.at(-1)).toMatchObject({ id: "Q5", text: "秘密を書かない" });
    expect(up.templates).toEqual([{ id: "basic", version: 2 }]);
    expect(templateDiffs(up, templates)).toEqual([]);
  });
});

describe("保存（core）", () => {
  it("採用して保存し直して読める。設定の保存・参照先の保存では消えず、コメントと知らない項目も残る", async () => {
    const { ctx, dataDir } = await makeProject();
    const file = join(dataDir, "project.yaml");
    writeFileSync(file, `# チームのメモ\n${readFileSync(file, "utf8")}future: keep\n`);
    await ctx.ws.reloadAll();
    expect(qualityView(ctx.ws).quality.state).toBe("unset");
    await updateQuality(ctx.ws, [{ op: "adopt", template: "typescript" }]);
    await ctx.ws.saveProject({ description: "説明を直した" });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# チームのメモ");
    expect(text).toContain("future: keep");
    const again = await openTestProject(dataDir);
    const v = qualityView(again.ws);
    expect(v.quality).toMatchObject({ state: "set", config: { standards: [{ id: "Q1", text: "型検査が通る" }, {}, {}, {}], templates: [{ id: "typescript", version: 1 }] } });
    expect(again.ws.project.description).toBe("説明を直した");
  });

  it("読めない設定は消さず、操作は断る（直す方法を示す）。ほかの保存でも残る", async () => {
    const { ctx, dataDir } = await makeProject();
    const file = join(dataDir, "project.yaml");
    writeFileSync(file, `${readFileSync(file, "utf8")}quality:\n  standards:\n    - id: Q1\n      text: 理由の無い除外\n      check: { kind: manual, reference: r }\n      exempt: {}\n`);
    await ctx.ws.reloadAll();
    expect(qualityView(ctx.ws).quality).toMatchObject({ state: "invalid" });
    await expect(updateQuality(ctx.ws, [{ op: "init" }])).rejects.toMatchObject({ code: "quality_unreadable" });
    await ctx.ws.saveProject({ description: "x" });
    expect(readFileSync(file, "utf8")).toContain("理由の無い除外");
  });

  it("版が違えば何も書かない（並行の保存は後のほうが断られる）", async () => {
    const { ctx, dataDir } = await makeProject();
    const other = await openTestProject(dataDir);
    const base = qualityView(ctx.ws).version;
    await updateQuality(ctx.ws, [{ op: "init" }], { expectedVersion: base });
    await expect(updateQuality(other.ws, [{ op: "adopt", template: "basic" }], { expectedVersion: base })).rejects.toMatchObject({ code: "quality_conflict" });
    await ctx.ws.reloadAll();
    expect(qualityView(ctx.ws).quality).toEqual({ state: "set", config: { standards: [] } });
    // 版なしの並行の保存は順に当たる（ロックの中で最新に当てる）
    await Promise.all([updateQuality(ctx.ws, [{ op: "add", standard: { text: "一", check: { kind: "manual", reference: "r" } } }]), updateQuality(other.ws, [{ op: "add", standard: { text: "二", check: { kind: "manual", reference: "r" } } }])]);
    await ctx.ws.reloadAll();
    const q = qualityView(ctx.ws).quality;
    expect(q.state === "set" && q.config.standards.map((s) => s.id).sort()).toEqual(["Q1", "Q2"]);
  });
});

describe("CLI と API", () => {
  it("CLI と API で同じ基準が残る。版の競合は CLI 3・API 409", async () => {
    const a = await makeProject();
    const b = await makeProject();
    const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
    const p3 = (args: string[]) => {
      const r = spawnSync(process.execPath, [BIN, "--dir", a.dataDir, ...args], { encoding: "utf8", env });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    expect(p3(["quality"]).out).toContain("未設定");
    expect(p3(["quality", "templates"]).out).toContain("basic@1");
    expect(p3(["quality", "template", "typescript"]).out).toContain("型検査が通る");
    expect(p3(["quality", "adopt", "basic"]).code).toBe(0);
    expect(p3(["quality", "add", "--text", "lint を通す", "--command", "pnpm lint", "--success", "終了コード 0"]).code).toBe(0);
    expect(p3(["quality", "add", "--text", "x"]).code).toBe(1);
    expect(p3(["quality", "exempt", "Q2", "--reason", "層が無い"]).code).toBe(0);
    expect(p3(["quality", "rm", "Q4"]).code).toBe(0);
    expect(p3(["quality", "init", "--version", "0000"]).code).toBe(3);
    const viaCli = (JSON.parse(p3(["quality", "--json"]).out) as { quality: unknown }).quality;
    expect(p3(["quality"]).out).toContain("除外の理由: 層が無い");

    const app = apiRoutes(b.ctx);
    const post = async (body: unknown) => {
      const res = await app.request("/quality", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const ops = [
      { op: "adopt", template: "basic" },
      { op: "add", standard: { text: "lint を通す", check: { kind: "machine", command: "pnpm lint", success: "終了コード 0" } } },
      { op: "exempt", id: "Q2", reason: "層が無い" },
      { op: "remove", id: "Q4" },
    ];
    expect((await post({ ops })).status).toBe(200);
    expect((await post({ ops: [{ op: "init" }], version: "0000" })).body).toMatchObject({ code: "quality_conflict" });
    expect((await post({ ops: [{ op: "add", standard: { text: " ", check: { kind: "manual", reference: "r" } } }] })).body).toMatchObject({ code: "quality_invalid" });
    const viaApi = ((await (await app.request("/quality")).json()) as { quality: unknown }).quality;
    expect(viaApi).toEqual(viaCli);
    expect((await app.request("/quality/templates/nope")).status).toBe(404);
  });
});
