import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { qualityState, updateQuality } from "../packages/tasks/src/features/quality/core/quality.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { applyQualityOps, QualityInputError, readQuality, standardsFor, type QualityOp } from "../packages/tasks/src/features/quality/shared/quality.ts";
import { MAIN_REF, makeProject, openTestProject, tempDir } from "./helpers.ts";

/**
 * プロジェクトの品質基準（shared/quality.ts・core/quality.ts・project.yaml の quality）: 項目は ID・文・対象の参照先・確かめ方だけ。
 * 未設定・設定済み（空を含む）・読めないの区別、重複した ID・知らない参照先、ID を使い直さないこと、以前の版の形（check・除外・
 * テンプレート・出典）の読み方、保存の往復とほかの保存で消えないこと、CLI と API の同じ結果、CLI の --repo の繰り返しと省略
 */

const repoNames = ["app", "infra"];

describe("規則（shared）", () => {
  it("無い・空・読めないを分け、重複した ID・空の文は読めない、知らない参照先は警告", () => {
    expect(readQuality(undefined)).toEqual({ state: "unset" });
    expect(readQuality({})).toEqual({ state: "set", config: { standards: [] } });
    expect(readQuality([])).toMatchObject({ state: "invalid" });
    expect(readQuality({ standards: [{ id: "Q1", text: "a" }, { id: "Q1", text: "b" }] })).toMatchObject({ state: "invalid", problems: [expect.stringContaining("重複")] });
    expect(readQuality({ standards: [{ id: "Q1", text: " " }] })).toMatchObject({ state: "invalid" });
    expect(readQuality({ standards: [{ id: "Q1", text: "a", repos: ["nope"] }] }, repoNames)).toMatchObject({ state: "set", warnings: [expect.stringContaining("nope")] });
  });

  it("以前の版の check は確かめ方として読み、除外した基準・テンプレート・出典・版は読まない。除外した ID は使い直さない", () => {
    const q = readQuality(
      {
        templates: [{ id: "basic", version: 1 }],
        standards: [
          { id: "Q1", text: "型検査", check: { kind: "machine", command: "pnpm typecheck", success: "終了コード 0" }, source: { template: "basic", version: 1 } },
          { id: "Q2", text: "文書", check: { kind: "manual", reference: "docs を直す" } },
          { id: "Q3", text: "除外", check: { kind: "manual", reference: "r" }, exempt: { reason: "層が無い" } },
        ],
      },
      repoNames,
    );
    expect(q).toEqual({
      state: "set",
      config: { standards: [{ id: "Q1", text: "型検査", how: "pnpm typecheck（成功: 終了コード 0）" }, { id: "Q2", text: "文書", how: "docs を直す" }], seq: 3 },
    });
    const next = applyQualityOps(q, [{ op: "add", standard: { text: "新しい" } }], { repoNames });
    expect(next.standards.map((s) => s.id)).toEqual(["Q1", "Q2", "Q4"]);
  });

  it("足す・直す・消す・丸ごと置き換え。消した ID を使い直さず、知らない参照先・空の文・無い ID は1件も当てない", () => {
    let c = applyQualityOps({ state: "unset" }, [{ op: "add", standard: { text: "一", how: "見る" } }, { op: "add", standard: { text: "二", repos: ["app"] } }], { repoNames });
    expect(c.standards).toEqual([{ id: "Q1", text: "一", how: "見る" }, { id: "Q2", text: "二", repos: ["app"] }]);
    c = applyQualityOps({ state: "set", config: c }, [{ op: "remove", id: "Q2" }, { op: "add", standard: { text: "三" } }, { op: "edit", id: "Q1", standard: { how: "" } }], { repoNames });
    expect(c.standards).toEqual([{ id: "Q1", text: "一" }, { id: "Q3", text: "三" }]);
    c = applyQualityOps({ state: "set", config: c }, [{ op: "replace", standards: [{ id: "Q3", text: "三'", repos: ["infra"] }, { text: "四" }] }], { repoNames });
    expect(c.standards.map((s) => [s.id, s.text, s.repos])).toEqual([["Q3", "三'", ["infra"]], ["Q4", "四", undefined]]);
    const state = { state: "set" as const, config: c };
    const bad: QualityOp[][] = [[{ op: "add", standard: { text: "x", repos: ["nope"] } }], [{ op: "add", standard: { text: " " } }], [{ op: "remove", id: "Q9" }]];
    for (const ops of bad)
      expect(() => applyQualityOps(state, ops, { repoNames })).toThrow(QualityInputError);
    expect(() => applyQualityOps({ state: "invalid", problems: ["x"] }, [], { repoNames })).toThrow(/読めないため変えられません/);
    // 置き換えに添えた編集前の一覧が今と違えば、他の変更を消さずに断る
    expect(() => applyQualityOps(state, [{ op: "replace", standards: [], base: [{ id: "Q3", text: "三'" }] }], { repoNames })).toThrow(expect.objectContaining({ code: "quality_conflict" }));
    expect(applyQualityOps(state, [{ op: "replace", standards: [], base: c.standards }], { repoNames }).standards).toEqual([]);
  });

  it("参照先の指定が無い基準は作業先なしにも当てはまり、指定がある基準は一致する作業先だけ", () => {
    const config = { standards: [{ id: "Q1", text: "全部" }, { id: "Q2", text: "app だけ", repos: ["app"] }] };
    expect(standardsFor(config, null).map((s) => s.id)).toEqual(["Q1"]);
    expect(standardsFor(config, "app").map((s) => s.id)).toEqual(["Q1", "Q2"]);
    expect(standardsFor(config, "infra").map((s) => s.id)).toEqual(["Q1"]);
  });
});

describe("保存（core）", () => {
  it("保存し直して読める。設定の保存では消えず、コメントと知らない項目も残る。並行の保存は順に当たる", async () => {
    const { ctx, dataDir } = await makeProject();
    const file = join(dataDir, "project.yaml");
    writeFileSync(file, `# チームのメモ\n${readFileSync(file, "utf8")}future: keep\n`);
    await ctx.ws.reloadAll();
    expect(qualityState(ctx.ws).state).toBe("unset");
    const other = await openTestProject(dataDir);
    await Promise.all([updateQuality(ctx.ws, [{ op: "add", standard: { text: "一", how: "pnpm test" } }]), updateQuality(other.ws, [{ op: "add", standard: { text: "二" } }])]);
    await ctx.ws.saveProject({ description: "説明を直した" });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# チームのメモ");
    expect(text).toContain("future: keep");
    const again = await openTestProject(dataDir);
    const q = qualityState(again.ws);
    expect(q.state === "set" && q.config.standards.map((s) => s.id).sort()).toEqual(["Q1", "Q2"]);
    expect(again.ws.project.description).toBe("説明を直した");
  });

  it("読めない設定は消さず、操作は断る（直す方法を示す）。ほかの保存でも残る", async () => {
    const { ctx, dataDir } = await makeProject();
    const file = join(dataDir, "project.yaml");
    writeFileSync(file, `${readFileSync(file, "utf8")}quality:\n  standards:\n    - id: 壊れた\n      text: 読めない基準\n`);
    await ctx.ws.reloadAll();
    expect(qualityState(ctx.ws)).toMatchObject({ state: "invalid" });
    await expect(updateQuality(ctx.ws, [{ op: "add", standard: { text: "x" } }])).rejects.toMatchObject({ code: "quality_unreadable" });
    await ctx.ws.saveProject({ description: "x" });
    expect(readFileSync(file, "utf8")).toContain("読めない基準");
  });
});

describe("CLI と API", () => {
  const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));
  async function setup() {
    const a = await makeProject({ repos: [MAIN_REF, { ...MAIN_REF, name: "infra", readFirst: false }] });
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
    const p3 = (args: string[]) => {
      const r = spawnSync(process.execPath, [BIN, "--dir", a.dataDir, ...args], { encoding: "utf8", env });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const standards = () => (JSON.parse(p3(["quality", "--json"]).out) as { quality: { state: string; config?: { standards: { id: string; repos?: string[]; how?: string }[] } } }).quality;
    const yaml = () => readFileSync(join(a.dataDir, "project.yaml"), "utf8");
    return { a, p3, standards, yaml };
  }

  it("CLI と API で同じ基準が残る。未設定の表示から足し方が分かり、空の文は CLI 1・API 400", async () => {
    const { p3, standards } = await setup();
    const unset = p3(["quality"]).out;
    expect(unset).toContain("作業は続けられます");
    expect(unset).toContain("p3 quality add");
    expect(p3(["quality", "add", "--text", "lint を通す", "--how", "pnpm lint"]).code).toBe(0);
    expect(p3(["quality", "add", "--text", "文書を直す"]).code).toBe(0);
    expect(p3(["quality", "add", "--text", " "]).code).toBe(1);
    expect(p3(["quality", "set", "Q2", "--how", "README を見る"]).code).toBe(0);
    expect(p3(["quality", "set", "Q1", "--how="]).code).toBe(0);
    expect(p3(["quality", "rm", "Q1"]).code).toBe(0);
    const viaCli = standards();
    expect(viaCli).toEqual({ state: "set", config: { standards: [{ id: "Q2", text: "文書を直す", how: "README を見る" }], seq: 2 } });
    expect(p3(["quality"]).out).toContain("確かめ方: README を見る");

    const b = await makeProject({ repos: [MAIN_REF, { ...MAIN_REF, name: "infra", readFirst: false }] });
    const app = apiRoutes(b.ctx);
    const post = async (body: unknown) => {
      const res = await app.request("/quality", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect((await post({ ops: [{ op: "add", standard: { text: "lint を通す", how: "pnpm lint" } }, { op: "add", standard: { text: "文書を直す" } }] })).status).toBe(200);
    expect((await post({ ops: [{ op: "edit", id: "Q2", standard: { how: "README を見る" } }, { op: "remove", id: "Q1" }] })).status).toBe(200);
    const bad = await post({ ops: [{ op: "add", standard: { text: " " } }] });
    expect([bad.status, bad.body.code]).toEqual([400, "quality_invalid"]);
    const viaApi = ((await (await app.request("/quality")).json()) as { quality: unknown }).quality;
    expect(viaApi).toEqual(viaCli);
  });

  it("add / set で --repo を繰り返した全部が残る。省略・all・同名の反復。混在・登録されていない参照先は何も変えない", async () => {
    const { p3, standards, yaml } = await setup();
    expect(p3(["quality", "add", "--text", "両方", "--repo", "main", "--repo", "infra"]).code).toBe(0);
    expect(p3(["quality", "add", "--text", "等号", "--repo=main", "--repo=infra", "--repo=main"]).code).toBe(0);
    expect(p3(["quality", "add", "--text", "省略"]).code).toBe(0);
    expect(p3(["quality", "add", "--text", "全部", "--repo", "all"]).code).toBe(0);
    expect(standards().config!.standards.map((s) => s.repos)).toEqual([["main", "infra"], ["main", "infra"], undefined, undefined]);
    const text = p3(["quality"]).out;
    expect(text).toContain("対象: main, infra");
    expect(text).toContain("対象: 全参照先");
    // set: 省略は対象を変えない・繰り返しは全部に置き換える・all は全参照先に戻す
    expect(p3(["quality", "set", "Q1", "--text", "文だけ変える"]).code).toBe(0);
    expect(p3(["quality", "set", "Q3", "--repo", "infra", "--repo", "main"]).code).toBe(0);
    expect(p3(["quality", "set", "Q2", "--repo", "all"]).code).toBe(0);
    expect(standards().config!.standards.map((s) => s.repos)).toEqual([["main", "infra"], undefined, ["infra", "main"], undefined]);

    const before = yaml();
    const mixed = p3(["quality", "add", "--text", "x", "--repo", "all", "--repo", "main"]);
    expect([mixed.code, mixed.err]).toEqual([1, expect.stringContaining("一緒に指定できません")]);
    const unknown = p3(["quality", "add", "--text", "x", "--repo", "main", "--repo", "nope"]);
    expect([unknown.code, unknown.err]).toEqual([1, expect.stringContaining("nope")]);
    expect(p3(["quality", "rm", "Q1", "--repo", "main"]).code).toBe(1);
    expect(yaml()).toBe(before);
    // 作業先を1つだけ取るコマンドは、繰り返すと説明付きで断り、タスクを作らない
    const req = (JSON.parse(p3(["request", "new", "要望", "--json"]).out) as { id: string }).id;
    const created = p3(["new", "タスク", "--req", req, "--repo", "main", "--repo", "infra"]);
    expect([created.code, created.err]).toEqual([1, expect.stringContaining("1つだけ")]);
    expect(JSON.parse(p3(["ls", "--req", req, "--json"]).out)).toEqual([]);
  });
});
