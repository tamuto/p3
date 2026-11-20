import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DefinitionStore, PreparationStore } from "../packages/observer/src/core/definitionStore.ts";
import { WorkStore } from "../packages/observer/src/core/workStore.ts";
import { mockSuggestion, SUGGEST_INSTRUCTIONS, suggestionCandidates, suggestionMessage, suggestPrompt, SuggestionService, type SuggestAdapter } from "../packages/observer/src/core/suggest.ts";
import { InvalidSuggestion, migrateSuggestion, parseSuggestion, validateSuggestionRequest, type Suggestion, type SuggestionCandidates } from "../packages/observer/src/shared/suggestion.ts";
import { tempDir } from "./helpers.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * 手順の提案の前提の観測と準備の候補（docs/architecture.md「p3-observer」の前提の観測と準備・手順の提案）: 依頼文の原則と候補・応答の読み方
 * （候補に無いものは外す・同じ名前の新しい案は再利用にする）・候補の作り方（自分と循環するものを除く）・Mock・古い提案・CLI。画面は test/ui/observerSuggest.ui.test.ts
 */
const C: SuggestionCandidates = {
  observations: [{ id: "obs-261121-aaaaa", title: "サインイン", description: "サインインできる" }],
  preparations: [{ id: "prep-261121-bbbbb", name: "注文1件", description: "注文を1件作る", exclusive: ["db:orders"], slots: ["setup"] }],
};
const reply = (extra: Record<string, unknown>) => JSON.stringify({ surface: "ui", rationale: "画面", measures: [], procedures: [], missing: [], ...extra });
const NEW = { name: "利用者が1人いる", setup: { run: { kind: "ai-instruction", target: "管理画面", steps: ["一意な名前で利用者を作る"], judge: "一覧に出る", record: "記録しない" } } };

describe("依頼文と応答", () => {
  it("依頼文に準備の原則・前後の観点と、選べる観測・既にある準備（判断に要る項目だけ）が入る", () => {
    for (const w of ["既知の状態に戻す", "実行ごとに一意な名前", "片付ける前に証跡を取る", "決まった秒数ではなく条件で待つ", "データ・認証と権限・アプリの状態・時刻と地域・外部の依存・キャッシュと非同期処理・ファイル・ブラウザ・証跡", "再利用を優先"]) {
      expect(SUGGEST_INSTRUCTIONS).toContain(w);
    }
    const v = validateSuggestionRequest({ definition: { title: "業務画面", prerequisites: ["obs-261121-aaaaa"] } });
    expect(v.ok).toBe(true);
    const p = suggestPrompt({ ...(v.ok ? v.value : ({} as never)), candidates: C }, []);
    expect(p).toContain("## 今の前提の観測（重ねて提案しない）\n- obs-261121-aaaaa サインイン");
    expect(p).toContain("- obs-261121-aaaaa サインイン — サインインできる");
    expect(p).toContain("- prep-261121-bbbbb 注文1件 — 注文を1件作る（前処理・占有 db:orders）");
    // 候補は利用者の入力からは渡せない
    expect(validateSuggestionRequest({ definition: { title: "t" }, candidates: C })).toMatchObject({ ok: false, problems: [{ path: "candidates" }] });
  });

  it("候補に無い前提と準備は外して知らせ、準備は名前でも読む。既にある準備と同じ名前の新しい案は、その準備の再利用にする", () => {
    const s = parseSuggestion(
      reply({
        prerequisites: [{ id: "obs-261121-aaaaa", reason: "サインインが要る" }, { id: "obs-261121-zzzzz", reason: "無い" }],
        preparations: [{ id: "注文1件", reason: "注文が要る" }, { id: "prep-261121-zzzzz", reason: "無い" }],
        newPreparations: [{ preparation: NEW, reason: "利用者が要る" }, { preparation: { name: "注文1件" }, reason: "重なる" }],
      }),
      [],
      C,
    );
    expect(s).toMatchObject({
      prerequisites: [{ id: "obs-261121-aaaaa", reason: "サインインが要る" }],
      preparations: [{ id: "prep-261121-bbbbb", reason: "注文が要る" }],
      newPreparations: [{ preparation: { name: "利用者が1人いる", exclusive: [] }, reason: "利用者が要る" }],
    });
    expect(s.warnings).toEqual([expect.stringContaining("obs-261121-zzzzz"), expect.stringContaining("prep-261121-zzzzz"), expect.stringContaining("同じ名前の準備が既にある")]);
    expect(() => parseSuggestion(reply({ newPreparations: [{ preparation: { name: "" }, reason: "x" }] }), [], C)).toThrow(InvalidSuggestion);
    expect(() => parseSuggestion(reply({ prerequisites: [{ id: "x" }] }), [], C)).toThrow(/理由/);
    // 候補だけの提案も読める。古い提案（前提と準備の欄が無い）は空として読む
    expect(parseSuggestion(reply({ prerequisites: [{ id: "obs-261121-aaaaa", reason: "r" }] }), [], C).prerequisites).toHaveLength(1);
    const old = { result: { surface: "cli", rationale: "r", measures: [], procedures: [], missing: [], warnings: [] } as unknown as Suggestion };
    expect(migrateSuggestion(old).result).toMatchObject({ prerequisites: [], preparations: [], newPreparations: [] });
  });

  it("Mock: 材料に名前が出る観測と準備を候補にし、合う準備が無い画面の観測には新しい準備の案を出す", () => {
    const base = { title: "業務画面", category: "", description: "サインインしてから注文1件を画面で確かめる", measures: [], procedures: [] };
    expect(mockSuggestion({ definition: base, candidates: C }, ["app"])).toMatchObject({ prerequisites: [{ id: "obs-261121-aaaaa" }], preparations: [{ id: "prep-261121-bbbbb" }], newPreparations: [] });
    const fresh = mockSuggestion({ definition: { ...base, description: "画面で一覧を確かめる" }, candidates: C }, ["app"]);
    expect(fresh).toMatchObject({ prerequisites: [], preparations: [], newPreparations: [{ preparation: { name: "業務画面の前の状態" } }] });
    // 応答の形に直しても同じに読める
    expect(parseSuggestion(suggestionMessage(fresh), [], C).newPreparations).toEqual(fresh.newPreparations);
  });
});

describe("候補の作り方と保存", () => {
  it("観測の候補から自分自身と、前提をたどると自分に戻るものを除き、依頼と一緒に提案の記録に残す", async () => {
    const dataDir = tempDir("p3-sg-refs-");
    const defs = new DefinitionStore(dataDir);
    const prep = await new PreparationStore(dataDir).create({ name: "注文1件", exclusive: ["db:orders"] }, "a");
    const self = await defs.create({ title: "業務画面", description: "画面" }, "a");
    const child = await defs.create({ title: "子", description: "業務画面が前提", prerequisites: [self.id] }, "a");
    const grandchild = await defs.create({ title: "孫", description: "子が前提", prerequisites: [child.id] }, "a");
    const other = await defs.create({ title: "サインイン", description: "サインインできる" }, "a");
    const c = await suggestionCandidates(dataDir, self.id);
    expect(c.observations.map((o) => o.id)).toEqual([other.id]);
    expect(c.preparations).toEqual([{ id: prep.id, name: "注文1件", exclusive: ["db:orders"], slots: [] }]);
    expect((await suggestionCandidates(dataDir)).observations.map((o) => o.id).sort()).toEqual([self.id, child.id, grandchild.id, other.id].sort());

    const asked: string[] = [];
    const adapter: SuggestAdapter = {
      context: async () => ({ engine: { name: "fake", ok: true, detail: "" }, repos: [] }),
      ask: async (input) => {
        asked.push(input.prompt);
        return { engine: "fake", message: reply({ prerequisites: [{ id: child.id, reason: "循環する" }, { id: other.id, reason: "サインインが要る" }] }) };
      },
    };
    const work = new WorkStore(dataDir);
    const job = await new SuggestionService(adapter, { store: work }).run({ definition: { title: "業務画面", category: "", description: "画面", measures: [], procedures: [] } }, { definition: self.id, basedOnRev: 1 });
    expect(job.result).toMatchObject({ prerequisites: [{ id: other.id }], warnings: [expect.stringContaining(child.id)] });
    expect(asked[0]).not.toContain(child.id);
    expect((await work.getSuggestion(self.id, job.id))?.request?.candidates?.observations.map((o) => o.id)).toEqual([other.id]);
  });

  it("CLI: 提案に前提と準備の候補が出て、ID の無い互換の経路は定義に前提と再利用の準備を足して返す（保存しない）", async () => {
    const { root } = await initialized();
    const env = { P3_PREFLIGHT_ENGINE: "mock" };
    const j = (args: string[]) => p3(root, [...args, "--json"], env).json();
    const prep = j(["observer", "prep", "add", "--title", "注文1件"]);
    const base = j(["observer", "add", "--title", "サインイン", "--body", "サインインできる"]);
    const d = j(["observer", "add", "--title", "業務画面", "--body", "サインインしてから注文1件を画面で確かめる"]);
    const out = p3(root, ["observer", "suggest", d.id], env).out;
    expect(out).toContain(`前提の観測の候補: ${base.id} サインイン`);
    expect(out).toContain(`使う準備の候補（既にある）: ${prep.id} 注文1件`);
    writeFileSync(join(root, "draft.json"), JSON.stringify({ title: "業務画面2", description: "サインインしてから注文1件を画面で確かめる" }));
    const compat = j(["observer", "suggest", "--input", "draft.json"]);
    expect(compat.definition).toMatchObject({ prerequisites: expect.arrayContaining([base.id]), preparations: [prep.id] });
    expect(j(["observer", "list"]).definitions).toHaveLength(2);
  });
});
