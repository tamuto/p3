import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import type { PreflightEngine } from "../src/server/preflight/engine.ts";
import { MockEngine } from "../src/server/preflight/mockEngine.ts";
import { applyUiShortage, imageInfo, loadUiMaterials, safeRelative, UI_LIMITS } from "../src/server/preflight/uiMaterials.ts";
import type { PreflightAssessment } from "../src/shared/types.ts";
import { makeRepo, newRequest, openTestProject, tempDir } from "./helpers.ts";

/** 大きさだけ正しい PNG（P3 は先頭だけ読む） */
export function png(width = 640, height = 480, pad = 64): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(pad)]);
}

/** 大きさだけ正しい JPEG（APP0 の後に SOF0） */
export function jpeg(width = 320, height = 200): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

async function runDirWith(index: unknown, files: Record<string, Buffer | string> = {}) {
  const runDir = join(tempDir(), "PF-1");
  await mkdir(join(runDir, "ui", "src"), { recursive: true });
  if (index !== undefined) await writeFile(join(runDir, "ui", "index.json"), typeof index === "string" ? index : JSON.stringify(index));
  for (const [p, data] of Object.entries(files)) {
    await mkdir(join(runDir, "ui", p, ".."), { recursive: true });
    await writeFile(join(runDir, "ui", p), data);
  }
  return runDir;
}

const item = (patch: Record<string, unknown> = {}) => ({ id: "U1", file: "U1.png", html: "src/U1.html", title: "一覧画面", drafts: ["D1"], viewport: 1280, assumptions: ["仮のデータ"], ...patch });

describe("画面資料の検証", () => {
  it("PNG / JPEG の形式と大きさを中身から読む（ほかは読まない）", () => {
    expect(imageInfo(png(800, 600))).toEqual({ format: "png", width: 800, height: 600 });
    expect(imageInfo(jpeg(320, 200))).toEqual({ format: "jpeg", width: 320, height: 200 });
    expect(imageInfo(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(imageInfo(Buffer.from("<html></html>"))).toBeUndefined();
  });

  it("ui/ の中の相対パスだけを認める", () => {
    expect(safeRelative("./a/U1.png")).toBe("a/U1.png");
    for (const bad of ["/etc/passwd", "../PF-2/ui/U1.png", "a/../../x.png", "C:/x.png", "a\\b.png", "", "a//b.png"]) expect(safeRelative(bad)).toBeUndefined();
  });

  it("正しい資料を取り込み、原稿・対象のタスク案・幅・前提・元の run を記録する", async () => {
    const runDir = await runDirWith({ needed: true, items: [item(), item({ id: "U2", file: "U2.jpg", html: undefined, drafts: ["D1", "D2"] })] }, { "U1.png": png(1280, 900), "U2.jpg": jpeg(), "src/U1.html": "<html></html>" });
    const ui = await loadUiMaterials(runDir, "PF-1", ["D1", "D2"]);
    expect(ui.status).toBe("ready");
    expect(ui.problems).toEqual([]);
    expect(ui.targets).toEqual(["D1", "D2"]);
    expect(ui.items[0]).toMatchObject({ id: "U1", kind: "proposal", file: "U1.png", format: "png", width: 1280, height: 900, html: "src/U1.html", source: "ui/src/U1.html", drafts: ["D1"], viewport: 1280, assumptions: ["仮のデータ"], run: "PF-1" });
    expect(ui.items[1]).toMatchObject({ id: "U2", format: "jpeg", width: 320, height: 200 });
  });

  it("一覧が無ければ足りない（要るかは分からない）、壊れていれば要るものとして足りない", async () => {
    expect(await loadUiMaterials(await runDirWith(undefined), "PF-1", ["D1"])).toMatchObject({ status: "missing", needed: undefined, items: [] });
    const broken = await loadUiMaterials(await runDirWith("{ not json"), "PF-1", ["D1"]);
    expect(broken).toMatchObject({ status: "missing", needed: true });
    expect(broken.reason).toContain("JSON として読めません");
  });

  it("不要なら理由を残す（理由が無ければ問題として残す）", async () => {
    expect(await loadUiMaterials(await runDirWith({ needed: false, reason: "CLI だけの変更" }), "PF-1", ["D1"])).toMatchObject({ status: "not_needed", reason: "CLI だけの変更", problems: [] });
    const noReason = await loadUiMaterials(await runDirWith({ needed: false }), "PF-1", ["D1"]);
    expect(noReason.problems).toEqual(["不要の理由が書かれていません"]);
  });

  it("不正な参照・欠損・形式偽装・上限超過・未知の D キー・別 run・シンボリックリンクは取り込まず理由を残す", async () => {
    const outside = join(tempDir(), "secret.png");
    await writeFile(outside, png());
    const runDir = await runDirWith(
      {
        needed: true,
        targets: ["D1", "D9"],
        items: [
          item({ id: "abs", file: "/etc/passwd.png" }),
          item({ id: "up", file: "../../PF-2/ui/U1.png" }),
          item({ id: "gone", file: "nothing.png" }),
          item({ id: "fake", file: "fake.png" }),
          item({ id: "kind", file: "kind.png" }),
          item({ id: "svg", file: "pic.svg" }),
          item({ id: "huge", file: "huge.png" }),
          item({ id: "nodraft", file: "ok.png", drafts: ["D9"] }),
          item({ id: "other", file: "ok.png", run: "PF-2" }),
          item({ id: "link", file: "link.png" }),
          item({ id: "cur", file: "ok.png", kind: "current" }),
        ],
      },
      { "fake.png": "<html><script>alert(1)</script></html>", "kind.png": jpeg(), "pic.svg": "<svg/>", "huge.png": png(5000, 100), "ok.png": png() },
    );
    await symlink(outside, join(runDir, "ui", "link.png"));
    const ui = await loadUiMaterials(runDir, "PF-1", ["D1"]);
    expect(ui.items).toEqual([]);
    expect(ui.status).toBe("missing");
    expect(ui.needed).toBe(true);
    expect(ui.reason).toContain("D1");
    const text = ui.problems.join("\n");
    for (const s of [
      "abs: ui/ の中の相対パスではありません",
      "up: ui/ の中の相対パスではありません",
      "gone: nothing.png: ファイルがありません",
      "fake: fake.png: PNG / JPEG として読めません",
      "kind: kind.png: 拡張子と中身の形式が合いません",
      "svg: 画像は PNG か JPEG",
      "huge: huge.png: 画像の大きさが上限を超えています",
      "nodraft: 無いタスク案 D9 を外しました",
      "nodraft: 対象のタスク案（drafts）がありません",
      "other: ほかの run（PF-2）の資料は取り込みません",
      "link: link.png: シンボリックリンクは使えません",
      "cur: エンジンが書けるのは提案（proposal）",
      "targets: 無いタスク案 D9 を外しました",
    ]) {
      expect(text).toContain(s);
    }
  });

  it("ui/ そのものがシンボリックリンクなら使わない", async () => {
    const other = await runDirWith({ needed: true, items: [item()] }, { "U1.png": png() });
    const runDir = join(tempDir(), "PF-1");
    await mkdir(runDir);
    await symlink(join(other, "ui"), join(runDir, "ui"));
    expect((await loadUiMaterials(runDir, "PF-1", ["D1"])).reason).toContain("シンボリックリンク");
  });

  it("件数と1枚の容量の上限", async () => {
    const many = Array.from({ length: UI_LIMITS.items + 2 }, (_, i) => item({ id: `U${i}`, html: undefined }));
    const big = Buffer.concat([png(), Buffer.alloc(UI_LIMITS.bytes)]);
    const runDir = await runDirWith({ needed: true, items: [...many.slice(1), item({ id: "big", file: "big.png" })] }, { "U1.png": png(), "big.png": big });
    const ui = await loadUiMaterials(runDir, "PF-1", ["D1"]);
    expect(ui.items).toHaveLength(UI_LIMITS.items);
    expect(ui.problems.join("\n")).toContain("資料が多すぎます");
    const one = await loadUiMaterials(await runDirWith({ needed: true, items: [item({ file: "big.png" })] }, { "big.png": big }), "PF-1", ["D1"]);
    expect(one.problems.join("\n")).toContain("大きすぎます");
  });

  it("必要な画面イメージが足りなければ go を clarify にし、no_go は変えない。一覧が無いだけなら変えない", () => {
    const a = (verdict: PreflightAssessment["verdict"]): PreflightAssessment => ({ summary: "", verdict, validity: { score: 80, reasons: [] }, feasibility: { score: 80, reasons: [] }, risks: [], questions: [], areas: [], impacts: [] });
    const lacking = { status: "missing" as const, needed: true, reason: "画面イメージが足りないタスク案: D1", targets: ["D1"], items: [], problems: [] };
    const go = a("go");
    expect(applyUiShortage(go, lacking).verdictAdjusted).toEqual({ from: "go", to: "clarify" });
    expect(go.verdict).toBe("clarify");
    expect(go.questions[0]).toContain("画面イメージが足りません");
    const noGo = a("no_go");
    expect(applyUiShortage(noGo, lacking).verdictAdjusted).toBeUndefined();
    expect(noGo.verdict).toBe("no_go");
    const unknown = a("go");
    applyUiShortage(unknown, { ...lacking, needed: undefined });
    expect(unknown).toEqual(a("go"));
  });
});

/** mock の結果に画面資料を書き足すエンジン */
function engineWithUi(write: (runDir: string) => Promise<void>): PreflightEngine {
  const mock = new MockEngine({ delay: 0 });
  return {
    name: "mock",
    status: () => mock.status(),
    async run(job, log, signal) {
      const out = await mock.run(job, log, signal);
      await write(job.runDir);
      return out;
    },
  };
}

async function setup(write: (runDir: string) => Promise<void>) {
  const { dataDir } = await makeRepo();
  const ctx = await openTestProject(dataDir, { mock: engineWithUi(write) });
  const req = await newRequest(ctx, { title: "一覧画面に絞り込みを足す", status: "draft", body: `- 絞り込み欄\n- 結果の表\n\n${"一覧画面の上に、状態・担当・期限で絞り込む欄を置き、結果の表を絞り込む。".repeat(4)}` });
  const started = await ctx.preflight.start(req.id);
  expect(started.ui?.status).toBe("generating");
  const run = (await ctx.preflight.wait(req.id, started.id))!;
  return { dataDir, ctx, req, run, app: apiRoutes(ctx) };
}

describe("Preflight と画面資料", () => {
  it("取り込んだ資料は run に残り、API で 要望 / run / 資料 ID から画像を取れる（原稿やパスでは取れない）", async () => {
    const { ctx, req, run, app, dataDir } = await setup(async (runDir) => {
      await mkdir(join(runDir, "ui", "src"), { recursive: true });
      await writeFile(join(runDir, "ui", "U1.png"), png(1280, 800));
      await writeFile(join(runDir, "ui", "src", "U1.html"), "<html><body>一覧</body></html>");
      await writeFile(join(runDir, "ui", "index.json"), JSON.stringify({ needed: true, items: [item()] }));
    });
    expect(run.status).toBe("completed");
    expect(run.ui).toMatchObject({ status: "ready", items: [{ id: "U1", file: "U1.png", run: run.id }] });
    expect(run.assessment!.verdict).toBe("go");

    const res = await app.request(`/requests/${req.id}/preflight/${run.id}/ui/U1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png(1280, 800));
    for (const bad of ["src%2FU1.html", "U9", "..%2F..%2Frun.json"]) expect((await app.request(`/requests/${req.id}/preflight/${run.id}/ui/${bad}`)).status).toBe(404);
    expect((await app.request(`/requests/${req.id}/preflight/PF-..%2F..%2Fx/ui/U1`)).status).toBe(404);

    // 取り込んだ後に差し替えられた画像は配信しない
    await writeFile(join(ctx.ws.preflight.runDir(req.id, run.id), "ui", "U1.png"), "<html></html>");
    expect((await app.request(`/requests/${req.id}/preflight/${run.id}/ui/U1`)).status).toBe(404);
    await writeFile(join(ctx.ws.preflight.runDir(req.id, run.id), "ui", "U1.png"), png(1280, 800));

    // データのフォルダを動かしても、相対パスで同じ資料を辿れる
    const moved = join(tempDir(), "moved");
    await cp(dataDir, moved, { recursive: true });
    const ctx2 = await openTestProject(moved, undefined, { repos: {} });
    const got = await ctx2.preflight.uiImage(req.id, run.id, "U1");
    expect(got.type).toBe("image/png");
    expect(JSON.parse(await readFile(join(ctx2.ws.preflight.runDir(req.id, run.id), "run.json"), "utf8")).ui.items[0].file).toBe("U1.png");
  });

  it("必要な画面イメージが無ければ評価を残したまま clarify にし、不足の理由をログに残す", async () => {
    const { run } = await setup(async (runDir) => {
      await mkdir(join(runDir, "ui"), { recursive: true });
      await writeFile(join(runDir, "ui", "index.json"), JSON.stringify({ needed: true, targets: ["D1"], items: [item({ file: "none.png" })] }));
    });
    expect(run.status).toBe("completed");
    expect(run.drafts.length).toBeGreaterThan(0);
    expect(run.assessment!.verdict).toBe("clarify");
    expect(run.ui).toMatchObject({ status: "missing", needed: true, verdictAdjusted: { from: "go", to: "clarify" } });
    expect(run.log.map((l) => l.text).join("\n")).toContain("画面資料を取り込めません: U1: none.png: ファイルがありません");
  });

  it("以前の run（記録なし）はそのまま読め、画像は無い", async () => {
    const { ctx, req, run } = await setup(async () => {});
    // mock は画面を伴う要望に決まった例を書く
    expect(run.ui).toMatchObject({ status: "ready", items: [{ id: "U1", kind: "proposal", html: "src/U1.html" }] });
    const file = join(ctx.ws.preflight.runDir(req.id, run.id), "run.json");
    const { ui, ...old } = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify(old));
    expect((await ctx.preflight.get(req.id, run.id))!.ui).toBeUndefined();
    await expect(ctx.preflight.uiImage(req.id, run.id, "U1")).rejects.toThrow("not found");
  });
});

describe("再評価と画面資料", () => {
  it("前回の画面イメージを、前回の提案として固定した参照で渡す（今回の run には写さない）", async () => {
    const { dataDir } = await makeRepo();
    const ctx = await openTestProject(dataDir);
    const req = await newRequest(ctx, { title: "一覧画面に絞り込みを足す", status: "draft", body: "- 絞り込み欄\n- 結果の表" });
    const first = (await ctx.preflight.wait(req.id, (await ctx.preflight.start(req.id)).id))!;
    expect(first.ui?.status).toBe("ready");
    await ctx.preflight.addNote(req.id, "状態の絞り込みは複数選べるようにする");
    const second = (await ctx.preflight.wait(req.id, (await ctx.preflight.start(req.id)).id))!;
    const carry = await readFile(join(ctx.ws.preflight.runDir(req.id, second.id), "carryover.md"), "utf8");
    expect(carry).toContain("## 前回の画面イメージ（前回の提案。今の画面の証拠ではありません");
    expect(carry).toContain(`画像 requests/${req.id}/preflight/${first.id}/ui/U1.png / 原稿 requests/${req.id}/preflight/${first.id}/ui/src/U1.html`);
    // 今回の資料は今回の run のもの
    expect(second.ui!.items[0].run).toBe(second.id);
  });

  it("「P3 が描いた」はエンジンが書いても消す", async () => {
    const { renderManuscripts } = await import("../src/server/preflight/uiRender.ts");
    const runDir = await runDirWith({ needed: true, items: [item({ rendered: { by: "p3" } })] }, { "U1.png": png(), "src/U1.html": "<p>a</p>" });
    await renderManuscripts(runDir, { log: () => {}, render: async () => [] });
    const ui = await loadUiMaterials(runDir, "PF-1", ["D1"]);
    expect(ui.items[0].rendered).toBeUndefined();
  });
});
