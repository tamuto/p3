import { describe, expect, it } from "vitest";
import type { PreflightRun, UiMaterial } from "../src/shared/types.ts";
import { attachmentUrl, draftAnchor, emptyAttachForm, fixedAttachmentUrl, materialUrl, sortMaterials, submitAttach, uiShortage, uiStatusView } from "../src/web/lib/uiMaterials.ts";

const run = (ui: PreflightRun["ui"], status: PreflightRun["status"] = "completed") => ({ ui, status });
const m = (id: string, kind: UiMaterial["kind"]): UiMaterial => ({ id, kind, file: `${id}.png`, format: "png", width: 1, height: 1, bytes: 1, title: id, drafts: [], assumptions: [], run: "PF-1" });

describe("画面資料の表示", () => {
  it("画像の URL は 要望 / run / 資料 ID で作る（run を替えれば別の URL）", () => {
    expect(materialUrl("261012-abcde", "PF-1", "U1")).toBe("/api/requests/261012-abcde/preflight/PF-1/ui/U1");
    expect(materialUrl("261012-abcde", "PF-2", "U1")).not.toBe(materialUrl("261012-abcde", "PF-1", "U1"));
    expect(materialUrl("r", "PF-1", "../x")).toBe("/api/requests/r/preflight/PF-1/ui/..%2Fx");
    expect(attachmentUrl("r", "A-1")).toBe("/api/requests/r/attachments/A-1");
    expect(fixedAttachmentUrl("r", "PF-1", "A-1", true)).toBe("/api/requests/r/preflight/PF-1/attachments/A-1/extract");
    expect(draftAnchor("D2")).toBe("draft-D2");
  });

  it("状態: 記録なし・評価中・不要・そろっている・足りない を分ける", () => {
    expect(uiStatusView(run(undefined)).label).toBe("記録なし");
    expect(uiStatusView(run({ status: "generating", targets: [], items: [], problems: [] }, "running")).label).toBe("評価中");
    expect(uiStatusView(run({ status: "not_needed", reason: "CLI だけ", targets: [], items: [], problems: [] }))).toMatchObject({ label: "不要", message: "CLI だけ" });
    expect(uiStatusView(run({ status: "ready", targets: [], items: [], problems: [] })).label).toBe("そろっています");
    expect(uiStatusView(run({ status: "missing", reason: "D1 が無い", targets: [], items: [], problems: [] }))).toMatchObject({ label: "足りません", tone: "amber" });
  });

  it("タスク化の前に知らせる不足は、必要な画面イメージが無いときだけ", () => {
    expect(uiShortage(run({ status: "missing", needed: true, reason: "D1 が無い", targets: [], items: [], problems: [] }))).toContain("D1 が無い");
    expect(uiShortage(run({ status: "missing", reason: "一覧が無い", targets: [], items: [], problems: [] }))).toBeUndefined();
    expect(uiShortage(run(undefined))).toBeUndefined();
  });

  it("提案 → 現状 → 仕様書から の順に並べる", () => {
    expect(sortMaterials([m("S", "spec"), m("C", "current"), m("P", "proposal")]).map((x) => x.id)).toEqual(["P", "C", "S"]);
  });
});

describe("添付の入力", () => {
  const file = new File(["x"], "a.png");
  it("失敗しても入力を残し、そのまま再試行できる。成功したら空にする", async () => {
    const form = { ...emptyAttachForm(), file, description: "今の画面", source: "本番" };
    let calls = 0;
    const failed = await submitAttach(form, async () => {
      calls++;
      throw new Error("PNG / JPEG として読めません");
    });
    expect(failed).toMatchObject({ file, description: "今の画面", source: "本番", busy: false, error: "PNG / JPEG として読めません" });
    const sent: unknown[] = [];
    const ok = await submitAttach(failed, async (f) => void sent.push(f));
    expect(sent).toEqual([{ file, description: "今の画面", source: "本番" }]);
    expect(ok).toEqual(emptyAttachForm());
    expect(calls).toBe(1);
  });

  it("ファイルを選んでいなければ送らない", async () => {
    expect((await submitAttach(emptyAttachForm(), async () => Promise.reject(new Error("呼ばれない")))).error).toBe("ファイルを選んでください");
  });
});
