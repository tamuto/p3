import { describe, expect, it } from "vitest";
import type { PreflightNote, PreflightRun } from "../src/shared/types.ts";
import { ApiError } from "../src/web/lib/api.ts";
import { nextRunLabel, submitNote } from "../src/web/lib/notes.ts";

const note = (id: string, pending: boolean): PreflightNote & { pending: boolean } => ({ id, requestId: "r", createdAt: "2026-10-09T00:00:00Z", body: "b", pending });

/** 呼ばれた順を記録する偽の API */
function fakeApi(start: () => Promise<PreflightRun>) {
  const calls: string[] = [];
  return {
    calls,
    addNote: async (_rid: string, body: string) => {
      calls.push(`addNote:${body}`);
      return note("N-1", true);
    },
    startPreflight: async (_rid: string, opts: { note?: string } = {}) => {
      calls.push(`start:${opts.note ?? ""}`);
      return start();
    },
  };
}

describe("画面のメモ", () => {
  it("次の Preflight が引き継ぐものを実行前に見せる", () => {
    expect(nextRunLabel({ notes: [note("a", true), note("b", false)], previous: "PF-1", previousSkipped: null })).toBe(
      "次の Preflight: 前回 PF-1 の結果を引き継ぎます。メモ 1 件を渡します。",
    );
    expect(nextRunLabel({ notes: [], previous: null, previousSkipped: "直近の PF-2 が失敗のため" })).toContain("引き継ぎません（直近の PF-2 が失敗のため）");
    expect(nextRunLabel({ notes: [], previous: null, previousSkipped: null })).toContain("最初の評価です");
  });

  it("空のメモは送らない。メモだけの保存では実行しない", async () => {
    const api = fakeApi(async () => ({}) as PreflightRun);
    await expect(submitNote(api, "r", "  ", true)).rejects.toThrow("空");
    expect(await submitNote(api, "r", " 回答 ", false)).toMatchObject({ kind: "saved" });
    expect(api.calls).toEqual(["addNote:回答"]);
  });

  it("保存して再実行は1回の呼び出しで行い、始められなくても保存済みのメモを返す（重ねて保存しない）", async () => {
    const ok = fakeApi(async () => ({ id: "PF-3" }) as PreflightRun);
    expect(await submitNote(ok, "r", "回答", true)).toMatchObject({ kind: "started", run: { id: "PF-3" } });
    expect(ok.calls).toEqual(["start:回答"]);

    const busy = fakeApi(async () => {
      throw new ApiError(400, "実行中です", { error: "実行中です", note: note("N-9", true) });
    });
    expect(await submitNote(busy, "r", "回答", true)).toEqual({ kind: "not-started", note: note("N-9", true), error: "実行中です" });
    expect(busy.calls).toEqual(["start:回答"]);

    // メモを保存する前の失敗（要望が無いなど）はそのまま投げる
    const missing = fakeApi(async () => {
      throw new ApiError(404, "not found", { error: "not found" });
    });
    await expect(submitNote(missing, "r", "回答", true)).rejects.toThrow("not found");
  });
});
