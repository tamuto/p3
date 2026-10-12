import { describe, expect, it } from "vitest";
import type { PreflightRun, UiMaterial } from "../src/shared/types.ts";
import {
  attachFormatOf,
  attachmentUrl,
  checkPending,
  draftAnchor,
  emptyAttachForm,
  fixedAttachmentUrl,
  materialUrl,
  sendPending,
  setUnsentAttachments,
  sortMaterials,
  submitAttach,
  uiShortage,
  uiStatusView,
  unsentAttachments,
} from "../src/web/lib/uiMaterials.ts";
import { ATTACHMENT_FILE_LIMITS } from "../src/shared/types.ts";
import { ATTACHMENT_LIMITS } from "../src/server/store/attachments.ts";
import { UI_LIMITS } from "../src/server/preflight/uiMaterials.ts";

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

describe("作成と同時の添付", () => {
  const MB = 1024 * 1024;
  const f = (name: string, size = 10) => ({ name, size });

  it("画面の上限はサーバと同じ値（画像は画面資料の上限と同じ）", () => {
    expect(ATTACHMENT_LIMITS).toMatchObject(ATTACHMENT_FILE_LIMITS);
    expect(ATTACHMENT_FILE_LIMITS.imageBytes).toBe(UI_LIMITS.bytes);
  });

  it("作る前に形式・1件の大きさ・件数・合計を知らせる", () => {
    expect(attachFormatOf("画面.PNG")).toBe("png");
    expect(attachFormatOf("a.jpeg")).toBe("jpeg");
    expect(attachFormatOf("a.xls")).toBeUndefined();
    const c = checkPending([f("a.png"), f("b.svg"), f("c.jpg", 6 * MB), f("d.xlsx", 6 * MB), f("e.xlsx", 21 * MB)]);
    expect(c.items).toEqual([undefined, "PNG / JPEG / xlsx だけ添付できます", "大きすぎます（上限 5.0MB）", undefined, "大きすぎます（上限 20.0MB）"]);
    expect(c.total).toBeUndefined();
    expect(checkPending(Array.from({ length: 21 }, (_, i) => f(`${i}.png`))).total).toBe("添付は1つの要望に 20 件までです");
    expect(checkPending(Array.from({ length: 6 }, (_, i) => f(`${i}.xlsx`, 19 * MB))).total).toBe("添付の合計が上限（100.0MB）を超えます");
  });

  it("順に送り、失敗したものだけを理由つきで残す", async () => {
    const items = ["a.png", "b.png", "c.xlsx"].map((n, i) => ({ key: `k${i}`, file: new File(["x"], n), description: `説明${i}`, source: "" }));
    const progress: number[] = [];
    const sent: string[] = [];
    const failed = await sendPending(
      items,
      async ({ file, description }) => {
        if (file.name === "b.png") throw new Error("PNG / JPEG として読めません");
        sent.push(`${file.name}:${description}`);
      },
      (n) => progress.push(n),
    );
    expect(sent).toEqual(["a.png:説明0", "c.xlsx:説明2"]);
    expect(failed).toEqual([{ ...items[1], error: "PNG / JPEG として読めません" }]);
    expect(progress).toEqual([1, 2, 3]);
  });

  it("付け直す分は要望ごとに持ち、読んでも消えず、空にすると消える", () => {
    const item = { key: "k", file: new File(["x"], "a.png"), description: "", source: "", error: "x" };
    setUnsentAttachments("R1", [item]);
    expect(unsentAttachments("R1")).toEqual([item]);
    expect(unsentAttachments("R1")).toEqual([item]);
    expect(unsentAttachments("R2")).toEqual([]);
    setUnsentAttachments("R1", []);
    expect(unsentAttachments("R1")).toEqual([]);
  });
});
