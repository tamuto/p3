import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { metricsReport } from "../packages/tasks/src/core/metrics/index.ts";
import { manualFile, recordManual } from "../packages/tasks/src/core/metrics/manual.ts";
import { checkMilestoneRemoval } from "../packages/tasks/src/core/requestOps.ts";
import type { MetricResult, MetricsReport } from "../packages/tasks/src/shared/metrics.ts";
import { makeProject, openTestProject, tempDir } from "./helpers.ts";

/**
 * 人が記録する指標の値（core/metrics/manual.ts）: CLI で記録・訂正した値が別のプロセスでも範囲ごとに読めること、0 と未記録の区別、
 * 通貨・期間・範囲を合算しないこと、再送・版の競合・同時更新、入力の検査と壊れたファイル、マイルストーンの削除と参照切れを確かめる
 */

const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));
async function setup() {
  const p = await makeProject({ milestones: [{ id: "m1", title: "一" }] });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, "--dir", p.dataDir, ...args], { encoding: "utf8", env, cwd: p.dataDir });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const report = (...args: string[]) => {
    const r = cli("metrics", ...args, "--json");
    expect(r.code, r.err).toBe(0);
    return JSON.parse(r.out) as MetricsReport;
  };
  const metric = (r: MetricsReport, id: string) => r.metrics.find((m) => m.id === id)!;
  return { ...p, cli, report, metric };
}
const period = ["--from", "2026-11-01", "--to", "2026-11-30"];

describe("人が記録する値", () => {
  it("CLI で記録・訂正した値は、別のプロセスでも指定した範囲に期間・単位・出典つきで出る。0 の記録と未記録を分ける", async () => {
    const { cli, report, metric } = await setup();
    expect(metric(report("--milestone", "m1"), "post_release_defects")).toMatchObject({ kind: "manual", state: "unrecorded", value: null, rows: [] });
    const a = cli("metrics", "record", "post_release_defects", "0", ...period, "--source", "不具合の管理表", "--milestone", "m1", "--json");
    expect(a.code, a.err).toBe(0);
    expect(JSON.parse(a.out)).toMatchObject({ created: true, record: { id: "M1", value: 0, unit: "件", scope: "m1", createdBy: "human:test" } });
    let m = metric(report("--milestone", "m1"), "post_release_defects");
    expect(m).toMatchObject({ state: "ok", value: 0, rows: [{ id: "M1", from: "2026-11-01", to: "2026-11-30", value: 0, unit: "件", source: "不具合の管理表", rev: 1 }] });
    expect(metric(report(), "post_release_defects").state).toBe("unrecorded");
    // 訂正（--rev）
    expect(cli("metrics", "record", "post_release_defects", "2", ...period, "--source", "不具合の管理表", "--milestone", "m1", "--rev", "1").code).toBe(0);
    m = metric(report("--milestone", "m1"), "post_release_defects");
    expect(m.rows).toEqual([expect.objectContaining({ id: "M1", value: 2, rev: 2 })]);
    expect(cli("metrics", "--milestone", "m1").out).toContain("M1  2026-11-01〜2026-11-30  2 件  出典: 不具合の管理表");
  });

  it("通貨・期間の違う費用は別の行で1つに合算せず、全体とマイルストーンに同じ内容を入れても全体には足さない", async () => {
    const { ctx, report, metric } = await setup();
    const rec = (value: number, unit: string, from: string, to: string, scope?: string) => recordManual(ctx, { metric: "cost", value, unit, from, to, scope, source: "請求書" }, { actor: "human:a" });
    await rec(1000, "JPY", "2026-11-01", "2026-11-30");
    await rec(10, "USD", "2026-11-01", "2026-11-30");
    await rec(500, "JPY", "2026-10-01", "2026-10-31");
    await rec(1000, "JPY", "2026-11-01", "2026-11-30", "m1");
    const all = metric(report(), "cost");
    expect(all).toMatchObject({ state: "ok", value: null });
    expect(all.rows!.map((r) => [r.from, r.unit, r.value])).toEqual([
      ["2026-10-01", "JPY", 500],
      ["2026-11-01", "JPY", 1000],
      ["2026-11-01", "USD", 10],
    ]);
    expect(metric(report("--milestone", "m1"), "cost")).toMatchObject({ value: 1000, rows: [expect.objectContaining({ unit: "JPY", value: 1000 })] });
  });

  it("同じ内容の再送は行を増やさず、版を照らさない訂正・古い版・同時の訂正は競合で何も書かない", async () => {
    const { ctx, cli, dataDir } = await setup();
    const args = ["metrics", "record", "cost", "100", "--unit", "jpy", ...period, "--source", "請求書"];
    expect(cli(...args).code).toBe(0);
    const again = cli(...args, "--json");
    expect(JSON.parse(again.out)).toMatchObject({ created: false, changed: false, record: { id: "M1", unit: "JPY" } });
    const noRev = cli("metrics", "record", "cost", "200", "--unit", "JPY", ...period, "--source", "請求書");
    expect(noRev.code).toBe(3);
    expect(noRev.err).toMatch(/--rev 1/);
    expect(cli("metrics", "record", "cost", "200", "--unit", "JPY", ...period, "--source", "請求書", "--rev", "1").code).toBe(0);
    expect(cli("metrics", "record", "cost", "300", "--unit", "JPY", ...period, "--source", "請求書", "--rev", "1").code).toBe(3);
    const fresh = await openTestProject(dataDir);
    const results = await Promise.allSettled([
      recordManual(fresh, { metric: "cost", value: 400, unit: "JPY", from: "2026-11-01", to: "2026-11-30", source: "請求書" }, { expectedRev: 2 }),
      recordManual(ctx, { metric: "cost", value: 500, unit: "JPY", from: "2026-11-01", to: "2026-11-30", source: "請求書" }, { expectedRev: 2 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const saved = JSON.parse(await readFile(manualFile(dataDir), "utf8")) as { records: { value: number; rev: number }[] };
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0].rev).toBe(3);
  });

  it("負数・非数・小数の件数・不明な指標や所属・不正な期間・出典なしは受け付けず、壊れたファイルは読めないと出して書かない", async () => {
    const { cli, report, metric, dataDir } = await setup();
    const bad: string[][] = [
      ["cost", "-1", "--unit", "JPY", ...period, "--source", "s"],
      ["cost", "abc", "--unit", "JPY", ...period, "--source", "s"],
      ["cost", "1", ...period, "--source", "s"],
      ["post_release_defects", "1.5", ...period, "--source", "s"],
      ["post_release_defects", "1", "--unit", "JPY", ...period, "--source", "s"],
      ["lines_of_code", "1", ...period, "--source", "s"],
      ["request_to_done", "1", ...period, "--source", "s"],
      ["post_release_defects", "1", ...period, "--source", "s", "--milestone", "nope"],
      ["post_release_defects", "1", "--from", "2026-12-01", "--to", "2026-11-01", "--source", "s"],
      ["post_release_defects", "1", "--from", "2026-02-30", "--to", "2026-03-01", "--source", "s"],
      ["post_release_defects", "1", ...period],
    ];
    for (const b of bad) expect(cli("metrics", "record", ...b).code, b.join(" ")).toBe(1);
    await expect(readFile(manualFile(dataDir), "utf8")).rejects.toThrow(/ENOENT/);
    await mkdir(join(dataDir, "metrics"), { recursive: true });
    await writeFile(manualFile(dataDir), "{ broken");
    const r = report();
    expect(r.notices).toEqual([expect.objectContaining({ code: "manual_unreadable" })]);
    expect(metric(r, "cost")).toMatchObject({ state: "no_data", value: null, missing: 1 } satisfies Partial<MetricResult>);
    const w = cli("metrics", "record", "post_release_defects", "1", ...period, "--source", "s");
    expect(w.code).toBe(1);
    expect(w.err).toMatch(/読めません/);
    expect(await readFile(manualFile(dataDir), "utf8")).toBe("{ broken");
  });

  it("値を記録したマイルストーンは通常の削除で消さず、直接編集で消えたら記録への注意を出す", async () => {
    const { ctx, dataDir, report } = await setup();
    await recordManual(ctx, { metric: "post_release_defects", value: 1, from: "2026-11-01", to: "2026-11-30", scope: "m1", source: "s" });
    await expect(checkMilestoneRemoval(ctx, [])).rejects.toThrow(/指標の値を記録したマイルストーンは消せません/);
    const yaml = join(dataDir, "project.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace(/milestones:[\s\S]*?(\n\S|$)/, "milestones: []$1"));
    expect(report().notices).toEqual([expect.objectContaining({ code: "manual_orphan", target: "M1" })]);
    const fresh = await openTestProject(dataDir);
    expect((await metricsReport(fresh)).scopes).toHaveLength(1);
  });
});
