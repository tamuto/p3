import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RequestIdCopy } from "../src/web/components/RequestIdCopy.tsx";
import { COPY_MESSAGE, copyNotice, copyText } from "../src/web/lib/copy.ts";

describe("要望 ID のコピー", () => {
  it("渡した ID の全文だけを書き、書き込みが終わってから copied を返す", async () => {
    const written: string[] = [];
    let finish!: () => void;
    const clipboard = { writeText: (t: string) => new Promise<void>((r) => ((finish = r), written.push(t))) };
    let settled = false;
    const p = copyText("261011-7av02", clipboard).then((r) => ((settled = true), r));
    await Promise.resolve();
    expect(written).toEqual(["261011-7av02"]);
    expect(settled).toBe(false); // まだ書き込み中: 成功は知らせない
    finish();
    expect(await p).toBe("copied");
  });

  it("拒まれたら denied、Clipboard API が無ければ unavailable（例外は外へ出さない）", async () => {
    expect(await copyText("x", { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) })).toBe("denied");
    expect(await copyText("x", { writeText: () => { throw new Error("sync"); } })).toBe("denied");
    expect(await copyText("x", undefined)).toBe("unavailable");
    expect(await copyText("x", {} as never)).toBe("unavailable");
  });

  it("知らせは今の ID の結果だけ。失敗は手で選んでコピーするよう案内する", () => {
    expect(copyNotice(null, "a")).toBeNull();
    expect(copyNotice({ id: "a", result: "copied" }, "a")).toEqual({ text: "コピーしました", ok: true });
    expect(copyNotice({ id: "a", result: "copied" }, "b")).toBeNull(); // 別の要望へ移った
    expect(copyNotice({ id: "a", result: "denied" }, "a")).toEqual({ text: COPY_MESSAGE.denied, ok: false });
    expect(COPY_MESSAGE.denied).toContain("選択してコピー");
    expect(COPY_MESSAGE.unavailable).toContain("選択してコピー");
  });

  it("表示: ID・コピーのボタン（名前つき）・空の知らせの欄", () => {
    const html = renderToStaticMarkup(createElement(RequestIdCopy, { id: "261011-7av02" }));
    expect(html).toContain(">261011-7av02</span>");
    expect(html).toMatch(/<button type="button" aria-label="要望 ID をコピー"[^>]*><svg aria-hidden="true"[^]*<\/svg>コピー<\/button>/);
    expect(html).toMatch(/<span role="status"[^>]*><\/span>/);
  });
});
