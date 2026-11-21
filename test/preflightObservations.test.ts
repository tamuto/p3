import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changedObservations, observationSection } from "../packages/tasks/src/core/preflight/observations.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * Preflight の材料の観測（docs/architecture.md「p3-observer」の仕様変更を要望の評価で捉える）: 始めた時点の観測（ID・タイトル・期待・版・状態）を
 * run に固定して評価の指示に入れる・終了・期待未記入・読めない・観測ゼロを分ける・Mock の分け方（期待の変更のタスク案・観測し直す受け入れ基準）・
 * 評価のあとで観測の版が変わったら drafts に知らせる（タスク化は止めない）
 */
describe("評価の指示の観測の節", () => {
  it("今の期待・期待未記入・終了・読めないファイル・観測ゼロ・読めないを分けて書き、4つの分け方を指示する", () => {
    const s = observationSection({
      items: [
        { id: "obs-261121-aaaaa", title: "一覧の速さ", expected: "1秒以内", rev: 3, ended: false },
        { id: "obs-261121-bbbbb", title: "未記入", rev: 1, ended: false },
        { id: "obs-261121-ccccc", title: "終えた", expected: "x", rev: 2, ended: true },
      ],
      unreadable: 1,
    });
    expect(s).toContain("- obs-261121-aaaaa（版 3）一覧の速さ: 期待「1秒以内」");
    expect(s).toContain("- obs-261121-bbbbb（版 1）未記入: 期待が未記入（確定した仕様として扱わない）");
    expect(s).toContain("- obs-261121-ccccc（終了）終えた（参考。新しく前提にしない）");
    expect(s).toContain("読めない観測のファイルが 1 件");
    for (const w of ["期待を変える（仕様変更）→ タスク案", "新しい期待を足す → タスク案", "観測を終える", "今の期待を壊すおそれがある → そのタスク案の受け入れ基準"]) expect(s).toContain(w);
    expect(observationSection({ items: [], unreadable: 0 })).toContain("- 観測はまだありません");
    expect(observationSection({ items: [], unreadable: 0, error: "EACCES" })).toContain("観測を読めませんでした（EACCES）");
    expect(observationSection(undefined)).toBe("");
  });

  it("評価のあとで版が変わった・消えた観測を出し、読めないときは比べない", () => {
    const evaluated = { items: [{ id: "a", title: "A", rev: 1, ended: false }, { id: "b", title: "B", rev: 1, ended: false }, { id: "c", title: "C", rev: 2, ended: false }], unreadable: 0 };
    const current = { items: [{ id: "a", title: "A", rev: 2, ended: false }, { id: "c", title: "C", rev: 2, ended: false }], unreadable: 0 };
    expect(changedObservations(evaluated, current)).toEqual([{ id: "a", title: "A", evaluated: 1, current: 2 }, { id: "b", title: "B", evaluated: 1, current: null }]);
    expect(changedObservations(evaluated, { ...current, error: "x" })).toEqual([]);
  });
});

describe("CLI の Preflight（Mock）と手元の評価の準備", () => {
  it("観測を固定して評価し、期待を壊すおそれは観測 ID 付きの受け入れ基準、期待の変更はタスク案になる。版が変わると drafts に知らせ、accept はできる", async () => {
    const { root } = await initialized();
    const env = { P3_PREFLIGHT_ENGINE: "mock" };
    const j = (args: string[]) => {
      const r = p3(root, [...args, "--json"], env);
      expect(r.code, r.err).toBe(0);
      return r.json();
    };
    const obs = j(["observer", "add", "--title", "一覧の速さ", "--body", "一覧が速く出るか", "--expected", "1秒以内に出る"]);
    const ended = j(["observer", "add", "--title", "古い観測", "--body", "x"]);
    j(["observer", "end", ended.id, "--rev", "1", "--reason", "CI に移した"]);
    const rid = j(["request", "new", "一覧に絞り込みを足す", "--body", "- 一覧の速さを落とさずに絞り込みを足す"]).id;
    j(["preflight", rid, "--engine", "mock"]);
    const run = j(["drafts", rid]);
    expect(run.observations).toEqual({ items: expect.arrayContaining([{ id: obs.id, title: "一覧の速さ", expected: "1秒以内に出る", rev: 1, ended: false }, expect.objectContaining({ id: ended.id, ended: true })]), unreadable: 0 });
    expect(run.drafts[0].acceptanceCriteria.map((c: { text: string }) => c.text)).toContain(`観測 ${obs.id}（一覧の速さ）を観測し直し、期待どおりであることを人か担当の AI が確かめる`);
    expect(run).not.toHaveProperty("observationsChanged");

    const spec = j(["request", "new", "一覧の速さの期待を変える", "--body", "- 一覧の速さの期待を変える（0.5秒以内）"]).id;
    j(["preflight", spec, "--engine", "mock"]);
    expect(j(["drafts", spec]).drafts.map((d: { title: string }) => d.title)).toContain(`観測 ${obs.id} の期待を変える`);

    // 評価のあとで観測の版が変わった
    j(["observer", "update", obs.id, "--rev", "1", "--expected", "2秒以内に出る"]);
    const changed = p3(root, ["drafts", rid], env).out;
    expect(changed).toContain(`評価のあとで観測が変わりました（${obs.id} 一覧の速さ: 版 1 → 版 2）`);
    expect(j(["drafts", rid]).observationsChanged).toEqual([{ id: obs.id, title: "一覧の速さ", evaluated: 1, current: 2 }]);
    expect(p3(root, ["accept", rid, "--json"], { ...env, P3_ACTOR: "human:test" }).code).toBe(0);

    // 手元の評価の準備も同じ材料（今の期待）を指示に入れる
    const local = j(["request", "new", "手元で評価する", "--body", "- 何か"]).id;
    const prep = p3(root, ["preflight", local, "--prepare", "--json"], { ...env, P3_ACTOR: "ai:test" });
    expect(prep.code, prep.err).toBe(0);
    const text = readFileSync(prep.json().instructions, "utf8");
    expect(text).toContain(`- ${obs.id}（版 2）一覧の速さ: 期待「2秒以内に出る」`);
    expect(text).toContain(`- ${ended.id}（終了）古い観測`);
  });
});
