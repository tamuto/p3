import { describe, expect, it } from "vitest";
import { CANDIDATE_INSTRUCTIONS, CANDIDATE_LIMITS, candidateObservations, candidatePrompt, InvalidCandidates, parseCandidates, type CandidateJob, type CandidateMaterial } from "../packages/observer/src/shared/candidates.ts";
import { CandidateService } from "../packages/observer/src/core/candidates.ts";
import { WorkStore } from "../packages/observer/src/core/workStore.ts";
import { DefinitionStore } from "../packages/observer/src/core/definitionStore.ts";
import type { SuggestAdapter } from "../packages/observer/src/core/suggest.ts";
import { tempDir } from "./helpers.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * 観測の候補の提案（docs/architecture.md「p3-observer」の観測の候補と表示の速さ）: 応答の読み方（足りない候補・材料に無い推定の経緯・近い既存の観測）・
 * 依頼と結果の保存・失敗で定義が増えない・材料（人が確かめる品質基準・申告のみや未検証のまま済みになった基準・最近の要望・今ある観測）・
 * 確かめた候補だけを登録し、推定の経緯は選んだときだけ残り、実作業の帰属として逆引きされない
 */
const M: CandidateMaterial = {
  quality: [{ id: "Q2", text: "画面の文字は 16px 以上" }],
  criteria: [],
  requests: [{ id: "261121-aaaaa", title: "画面を読みやすくする", status: "done", updatedAt: "2026-11-21T00:00:00Z" }],
  observations: [{ id: "obs-261121-bbbbb", title: "読みやすさ" }],
};
const full = { title: "文字の大きさ", description: "主な画面の文字", expected: "16px 以上", reason: "人が確かめる基準", evidence: ["Q2"] };

describe("応答の読み方", () => {
  it("項目の足りない候補・材料に無い推定の経緯の要望・知らない近い観測は外して知らせる", () => {
    const r = parseCandidates(
      JSON.stringify({ candidates: [{ ...full, similar: "obs-261121-bbbbb", estimatedOrigin: { requests: ["261121-aaaaa", "261121-zzzzz"], basis: "git log" } }, { title: "根拠なし", description: "x", expected: "y", reason: "z", evidence: [] }, { ...full, title: "知らない近い観測", similar: "obs-261121-zzzzz" }] }),
      M,
    );
    expect(r.candidates).toEqual([
      { ...full, similar: "obs-261121-bbbbb", estimatedOrigin: { requests: ["261121-aaaaa"], basis: "git log" } },
      { ...full, title: "知らない近い観測" },
    ]);
    expect(r.warnings).toEqual([expect.stringContaining("261121-zzzzz"), expect.stringContaining("候補 2")]);
    expect(() => parseCandidates(JSON.stringify({ candidates: [{ title: "x" }] }), M)).toThrow(InvalidCandidates);
    expect(parseCandidates('{"candidates":[]}', M).candidates).toEqual([]);
  });

  it("依頼と結果を残し、接続を使えないときは失敗として残して定義を増やさない", async () => {
    const dataDir = tempDir("p3-cand-");
    const work = new WorkStore(dataDir);
    const adapter = (ok: boolean): SuggestAdapter => ({
      context: async () => ({ engine: { name: "fake", ok, detail: ok ? "" : "サインインしてください" }, repos: [] }),
      ask: async (input) => {
        expect(input.prompt).toContain("Q2: 画面の文字は 16px 以上");
        expect(input.label).toBe("観測の候補の提案");
        return { engine: "fake", message: JSON.stringify({ candidates: [full] }) };
      },
    });
    const done = await new CandidateService(adapter(true), { store: work, material: async () => M }).run("補足");
    expect(done).toMatchObject({ status: "completed", note: "補足", candidates: [full], material: M });
    expect(await work.getCandidates(done.id)).toMatchObject({ status: "completed", candidates: [full] });
    const failed = await new CandidateService(adapter(false), { store: work, material: async () => M }).run();
    expect(failed).toMatchObject({ status: "failed", failure: "unavailable" });
    expect((await work.listCandidates()).map((j) => j.status)).toEqual(["failed", "completed"]);
    expect((await new DefinitionStore(dataDir).list()).definitions).toEqual([]);
  });
});

describe("材料と依頼文", () => {
  const ai = (target: string, steps: string[], judge: string) => ({ kind: "ai-instruction" as const, target, steps, judge, record: "記録の本文は写さない" });
  it("今ある観測の説明と今の手順の要点を、期待の有無を分けて依頼に入れる。指示は利用者の振る舞い・除くもの・CI への出口・要望ごとに作らないことを書く", () => {
    const [o] = candidateObservations([{ id: "obs-1", title: "ヘッダーの遷移", description: "各タブを押して画面が出る", expected: " ", procedures: [{ title: "5つのリンク", run: ai("http://localhost/", ["観測を押す", "設定を押す"], "見出しが出る") }, { title: "CLI", run: { kind: "command", command: "p3", args: ["ls"] } }] }]);
    expect(o).toEqual({ id: "obs-1", title: "ヘッダーの遷移", description: "各タブを押して画面が出る", procedures: "5つのリンク: 対象 http://localhost/ / 操作 観測を押す → 設定を押す / 判定 見出しが出る; CLI: コマンド p3 ls" });
    const prompt = candidatePrompt({ ...M, observations: [o, { id: "obs-2", title: "期待あり", expected: "16px 以上" }] }, ["p3"]);
    expect(prompt).toContain("obs-1 ヘッダーの遷移: 期待「未記入（確定した期待として扱わない）」\n  説明: 各タブを押して画面が出る\n  手順: 5つのリンク: 対象");
    expect(prompt).toContain("obs-2 期待あり: 期待「16px 以上」");
    expect(prompt).not.toContain("記録の本文は写さない");
    expect(prompt).toContain("最近変わった期待の手がかり。要望ごとに候補を作らない");
    for (const t of ["利用者から見える振る舞い", "外部の CI に移して観測を終えます", "終わった要望の受け入れの確かめ直し", "candidates を空にする", "README と使い方の文書", "実行しない"]) expect(CANDIDATE_INSTRUCTIONS).toContain(t);
  });

  it("長い説明・手順は1つの上限で切り、観測が多いと欄の合計の上限を超えた分は ID・タイトル・期待だけにする", () => {
    const long = "あ".repeat(1000);
    const defs = Array.from({ length: 150 }, (_, i) => ({ id: `obs-${i}`, title: `観測 ${i}`, description: long, expected: long, procedures: [{ title: "手順", run: ai("画面", [long], "判定") }] }));
    const obs = candidateObservations(defs);
    const L = CANDIDATE_LIMITS;
    expect(obs).toHaveLength(L.observations);
    expect(obs[0].description).toHaveLength(L.observationText);
    expect(obs[0].description?.endsWith("…")).toBe(true);
    expect(obs[0].expected).toHaveLength(L.observationText);
    const chars = obs.reduce((n, o) => n + (o.description?.length ?? 0) + (o.procedures?.length ?? 0), 0);
    expect(chars).toBeLessThanOrEqual(L.observationChars);
    expect(obs.at(-1)).toEqual({ id: "obs-99", title: "観測 99", expected: obs[0].expected });
  });

  it("説明・手順の要点の無い以前の候補の依頼の記録も読めて、依頼文を作れる", async () => {
    const work = new WorkStore(tempDir("p3-cand-old-"));
    const old: CandidateJob = { id: "cd-000000000001", status: "completed", engine: "codex", startedAt: "2026-11-22T07:05:42.985Z", material: { quality: [], criteria: [], requests: [], observations: [{ id: "obs-261120-jhydt", title: "p3画面上の遷移確認" }] }, candidates: [] };
    await work.saveCandidates(old);
    const read = await work.getCandidates(old.id);
    expect(read).toMatchObject(old);
    expect(candidatePrompt(read!.material, [])).toContain("obs-261120-jhydt p3画面上の遷移確認: 期待「未記入（確定した期待として扱わない）」");
  });
});

describe("CLI（Mock）", () => {
  it("材料を tasks の記録から作り、候補を確かめて登録する。推定の経緯は --origin のときだけ残る", async () => {
    const { root, rid } = await initialized();
    const env = { P3_PREFLIGHT_ENGINE: "mock" };
    const run = (args: string[], extra: Record<string, string> = {}) => {
      const r = p3(root, args, { ...env, ...extra });
      expect(r.code, r.err).toBe(0);
      return r;
    };
    run(["new", "通知を送る", "--req", rid, "--criterion", "失敗した通知を再送できる"]);
    run(["quality", "add", "--text", "画面の文字は 16px 以上", "--reference", "画面を開いて確かめる"]);
    run(["quality", "add", "--text", "型検査が通る", "--command", "pnpm tsc", "--success", "終了コード 0"]);
    run(["move", "T001", "done", "--req", rid, "--record", "直した", "--evidence", "A1=met:送れた"], { P3_ACTOR: "human:test" });
    run(["check", "T001", "--req", rid], { P3_ACTOR: "human:test" });
    run(["request", "set", rid, "status=resolved"], { P3_ACTOR: "human:test" });
    run(["observer", "add", "--title", "既にある観測", "--body", "x"]);

    const job = JSON.parse(run(["observer", "candidates", "--note", "画面を中心に", "--json"]).out);
    expect(job.material.quality).toEqual([{ id: "Q1", text: "画面の文字は 16px 以上" }]);
    expect(job.material.criteria).toEqual([{ ref: `${rid}/T001`, id: "A1", text: "失敗した通知を再送できる", state: "申告のみ" }]);
    expect(job.material.requests.map((r: { id: string }) => r.id)).toEqual([rid]);
    expect(job.material.observations.map((o: { title: string }) => o.title)).toEqual(["既にある観測"]);
    expect(job.candidates.map((c: { title: string }) => c.title)).toEqual(["品質基準 Q1 の確認", "失敗した通知を再送できる の確認"]);
    const text = run(["observer", "candidates", job.id]).out;
    expect(text).toContain(`登録: p3 observer add --candidate ${job.id}:2 [--origin]`);

    const plain = JSON.parse(run(["observer", "add", "--candidate", `${job.id}:1`, "--json"]).out);
    expect(plain).toMatchObject({ title: "品質基準 Q1 の確認", expected: "画面の文字は 16px 以上が守られている" });
    expect(plain).not.toHaveProperty("estimatedOrigin");
    expect(p3(root, ["observer", "add", "--candidate", `${job.id}:1`, "--origin"], env).code).toBe(1);
    const withOrigin = JSON.parse(run(["observer", "add", "--candidate", `${job.id}:2`, "--origin", "--json"]).out);
    expect(withOrigin.estimatedOrigin).toMatchObject({ requests: [rid], basis: expect.stringContaining(`${rid}/T001`), confirmedBy: expect.any(String) });
    expect(withOrigin.history[0]).not.toHaveProperty("work");
    expect(p3(root, ["observer", "add", "--candidate", `${job.id}:9`], env).code).toBe(1);
  });
});
