import { describe, expect, it } from "vitest";
import { preflightSteps } from "../src/web/lib/preflightSteps.ts";

const view = (run: Parameters<typeof preflightSteps>[0]) => preflightSteps(run).map((s) => `${s.label}:${s.state}${s.current ? "*" : ""}`);
const log = (n: number) => Array.from({ length: n }, () => ({ at: "", kind: "info" as const, text: "" }));

describe("Preflight の工程の表示", () => {
  it("実行の状態ごとに、済んだ工程・今の工程（狭い画面でも名前を出す）・まだの工程が決まる", () => {
    expect(view({ status: "running", log: log(1) })).toEqual(["文脈選定:current*", "評価・細分化:todo", "レビュー:todo", "タスク化:todo"]);
    expect(view({ status: "running", log: log(5) })).toEqual(["文脈選定:done", "評価・細分化:current*", "レビュー:todo", "タスク化:todo"]);
    expect(view({ status: "failed", log: log(5) })).toEqual(["文脈選定:done", "評価・細分化:failed*", "レビュー:todo", "タスク化:todo"]);
    expect(view({ status: "completed", log: log(5) })).toEqual(["文脈選定:done", "評価・細分化:done", "レビュー:current*", "タスク化:todo"]);
    expect(view({ status: "completed", log: log(5), materialized: ["T001"] })).toEqual(["文脈選定:done", "評価・細分化:done", "レビュー:done", "タスク化:done*"]);
  });

  it("今の工程はいつも1つだけ（狭い画面で名前が1つは出る）", () => {
    for (const run of [
      { status: "running" as const, log: log(0) },
      { status: "failed" as const, log: [] },
      { status: "completed" as const, log: [], materialized: [] },
    ]) {
      expect(preflightSteps(run).filter((s) => s.current)).toHaveLength(1);
    }
  });
});
