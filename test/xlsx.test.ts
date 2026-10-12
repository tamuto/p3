import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractXlsx, unescapeXml, XLSX_LIMITS } from "../src/core/preflight/xlsx.ts";
import { codexPrompt } from "../src/core/preflight/codexEngine.ts";
import { makeRepo, newRequest, openTestProject } from "./helpers.ts";
import { jpeg, png } from "./imageFixture.ts";
import { makeXlsx } from "./zipFixture.ts";

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: [string, string, string, boolean?][]) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${ext ? ' TargetMode="External"' : ""}/>`)
    .join("")}</Relationships>`;

/** 日本語・2枚のシート・共有文字列・数式（値あり / なし）・結合セル・標準の画像・グラフ・図形・リンクの画像 */
function specBook() {
  return makeXlsx([
    { name: "xl/workbook.xml", data: `<workbook ${NS}><sheets><sheet name="画面項目" sheetId="1" r:id="rId1"/><sheet name="計算" sheetId="2" r:id="rId2"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: rels([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "worksheet", "worksheets/sheet2.xml"]]) },
    { name: "xl/sharedStrings.xml", data: `<sst ${NS}><si><t>項目名</t></si><si><r><t>必須</t></r><r><t>（太字）</t></r><rPh><t>ヒッス</t></rPh></si><si><t>A &amp; B &lt;注&gt;</t></si></sst>` },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>顧客名</t></is></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="s"><v>2</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells><drawing r:id="rId1"/></worksheet>`,
    },
    { name: "xl/worksheets/_rels/sheet1.xml.rels", data: rels([["rId1", "drawing", "../drawings/drawing1.xml"]]) },
    {
      name: "xl/drawings/drawing1.xml",
      data: `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}">
<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>
<xdr:oneCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:row>0</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rId2"/></xdr:blipFill></xdr:pic></xdr:oneCellAnchor>
<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>10</xdr:row></xdr:from><xdr:graphicFrame/></xdr:twoCellAnchor>
<xdr:twoCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:row>12</xdr:row></xdr:from><xdr:sp><xdr:txBody><a:p><a:r><a:t>保存ボタン</a:t></a:r></a:p></xdr:txBody></xdr:sp></xdr:twoCellAnchor>
<xdr:twoCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:row>5</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:link="rId3"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>
<xdr:twoCellAnchor><xdr:from><xdr:col>6</xdr:col><xdr:row>6</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rId4"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>
</xdr:wsDr>`,
    },
    {
      name: "xl/drawings/_rels/drawing1.xml.rels",
      data: rels([["rId1", "image", "../media/image1.png"], ["rId2", "image", "../media/image2.jpeg"], ["rId3", "image", "https://example.com/a.png", true], ["rId4", "image", "../media/image3.emf"]]),
    },
    { name: "xl/media/image1.png", data: png(400, 300) },
    { name: "xl/media/image2.jpeg", data: jpeg(200, 100) },
    { name: "xl/media/image3.emf", data: "EMF" },
    {
      name: "xl/worksheets/sheet2.xml",
      data: `<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>10</v></c><c r="B1"><f>A1*2</f><v>20</v></c><c r="C1"><f>SUM(A1:B1)</f></c><c r="D1" t="e"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>`,
    },
    { name: "xl/externalLinks/externalLink1.xml", data: "<externalLink/>" },
  ]);
}

describe("xlsx の取り出し", () => {
  it("シート名・セル座標・文字・保存済みの値・結合セルと、標準の画像（位置つき）を取り出し、扱わないものを記録する", () => {
    const x = extractXlsx(specBook(), "仕様.xlsx");
    expect(x.sheets).toBe(2);
    expect(x.text).toContain("## シート「画面項目」");
    expect(x.text).toContain("結合セル: A1:C1");
    expect(x.text).toContain("- A1: 項目名");
    expect(x.text).toContain("- B1: 必須（太字）");
    expect(x.text).not.toContain("ヒッス");
    expect(x.text).toContain("- A2: 顧客名");
    expect(x.text).toContain("- B2: TRUE");
    expect(x.text).toContain("- C2: A & B <注>");
    expect(x.text).toContain("- B1: =A1*2 → 20（保存済みの値）");
    expect(x.text).toContain("- C1: =SUM(A1:B1) → （値が保存されていません。未確認）");
    expect(x.text).toContain("- D1: =1/0 → エラー #DIV/0!（保存済みの値）");
    expect(x.unknownCells).toBe(1);
    expect(x.images.map((i) => [i.sheet, i.anchor, i.format, i.width, i.height])).toEqual([
      ["画面項目", "B4", "png", 400, 300],
      ["画面項目", "E1", "jpeg", 200, 100],
    ]);
    const un = x.unsupported.join("\n");
    for (const s of ["グラフ", "図形（描きません。中の文字: 保存ボタン）", "リンクの画像（取りに行きません）", "emf", "外部のブックへの参照"]) expect(un).toContain(s);
    expect(x.text).toContain("扱っていないもの（中身は未確認）");
  });

  it("壊れた xlsx・DOCTYPE（外部実体）・展開の上限は読まずに理由を返す", () => {
    expect(() => extractXlsx(Buffer.from("PK\x03\x04broken"), "a")).toThrow("ZIP");
    expect(() => extractXlsx(makeXlsx([{ name: "xl/sharedStrings.xml", data: `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><sst><si><t>&e;</t></si></sst>` }]), "a")).toThrow("DOCTYPE");
    const bomb = makeXlsx([{ name: "xl/sharedStrings.xml", data: Buffer.alloc(XLSX_LIMITS.entryBytes + 10, 0x20) }]);
    expect(() => extractXlsx(bomb, "a")).toThrow("展開すると大きすぎます");
    expect(unescapeXml("&#x41;&#66;&e;&amp;")).toBe("AB&e;&");
  });

  it("セル数と時間の上限で打ち切り、打ち切りを記録する", () => {
    const limits = XLSX_LIMITS as { cells: number };
    const saved = limits.cells;
    limits.cells = 2;
    try {
      const x = extractXlsx(specBook(), "a");
      expect(x.cells).toBe(2);
      expect(x.truncated[0]).toContain("セル数の上限");
    } finally {
      limits.cells = saved;
    }
    let t = 0;
    const slow = extractXlsx(specBook(), "a", () => (t += XLSX_LIMITS.timeMs));
    expect(slow.truncated.join("\n")).toContain("時間の上限");
  });
});

describe("Preflight と xlsx", () => {
  it("固定した xlsx から取り出し、画像は「仕様書から」の画面資料に、内容は Codex への資料になる", async () => {
    const { dataDir } = await makeRepo();
    const ctx = await openTestProject(dataDir);
    const req = await newRequest(ctx, { title: "一覧画面に絞り込みを足す", status: "draft", body: "- 絞り込み欄" });
    const a = await ctx.preflight.addAttachment(req.id, { data: specBook(), name: "仕様.xlsx", description: "画面の項目表" });
    const broken = await ctx.preflight.addAttachment(req.id, { data: makeXlsx([{ name: "xl/sharedStrings.xml", data: "<!DOCTYPE x><sst/>" }]), name: "壊れ.xlsx" });
    const run = (await ctx.preflight.wait(req.id, (await ctx.preflight.start(req.id)).id))!;
    const fixed = run.attachments!.find((x) => x.id === a.id)!;
    expect(fixed.extract).toMatchObject({ text: `attachments/${a.id}.md`, sheets: 2, unknownCells: 1 });
    const runDir = ctx.ws.preflight.runDir(req.id, run.id);
    expect(await readFile(join(runDir, fixed.extract!.text!), "utf8")).toContain("- A2: 顧客名");
    expect(run.ui!.items.filter((m) => m.kind === "spec").map((m) => [m.id, m.file, m.source])).toEqual([
      [`${a.id}-1`, `spec/${a.id}-1.png`, `添付 仕様.xlsx / シート「画面項目」B4`],
      [`${a.id}-2`, `spec/${a.id}-2.jpg`, `添付 仕様.xlsx / シート「画面項目」E1`],
    ]);
    expect((await ctx.preflight.uiImage(req.id, run.id, `${a.id}-1`)).type).toBe("image/png");
    expect(run.attachments!.find((x) => x.id === broken.id)!.extract!.error).toContain("DOCTYPE");
    expect(run.log.map((l) => l.text).join("\n")).toContain("壊れ.xlsx の中身を取り出せません（未読として渡します）");

    // Codex への資料: 取り出した内容と画像のパス、未確認のもの
    const text = codexPrompt({ project: ctx.ws.project, request: req, context: [], refs: [], dataDir, runDir, attachments: run.attachments });
    const base = `/data/requests/${req.id}/preflight/${run.id}`;
    expect(text).toContain(`取り出した内容: ${base}/attachments/${a.id}.md（シート 2・セル`);
    expect(text).toContain(`埋め込みの画像: ${base}/ui/spec/${a.id}-1.png（シート「画面項目」B4）`);
    expect(text).toContain("値が保存されていない数式が 1 個あります（未確認）");
    expect(text).toContain("扱っていないもの（中身は未確認）");
    expect(text).toContain("中身は読めていません（未読: ");
  });
});

describe("ほかのソフトが書いた xlsx", () => {
  it("openpyxl 3.1.5 が書いた原本（接頭辞の無い drawing）からも、セルと画像を取り出せる", async () => {
    const dir = join(import.meta.dirname, "fixtures");
    const x = extractXlsx(await readFile(join(dir, "sample-openpyxl.xlsx")), "sample.xlsx");
    expect(x.text).toContain("結合セル: A5:C5");
    expect(x.text).toContain("- A2: 顧客名");
    expect(x.text).toContain("- F1: =E1*2 → （値が保存されていません。未確認）");
    expect(x.text).toContain("## シート「メモ」\n- A1: 期限で並べ替える");
    expect(x.images).toHaveLength(1);
    expect(x.images[0]).toMatchObject({ sheet: "画面項目", anchor: "B7", format: "png" });
    expect(x.images[0].data).toEqual(await readFile(join(dir, "sample-openpyxl-image.png")));
  });
});
