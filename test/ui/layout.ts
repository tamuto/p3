// 表示の測定（画像の比較ではなく DOM の寸法で）: ページの横のはみ出し・枠からのはみ出し・画面内への収まり・局所スクロールの到達。
// どれも問題の一覧（空なら問題なし）を返し、失敗の説明に幅・テーマ・対象・寸法を出せるようにする。
import type { Locator, Page } from "playwright-core";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const fmt = (b: Box) => `x ${Math.round(b.left)}〜${Math.round(b.right)}, y ${Math.round(b.top)}〜${Math.round(b.bottom)}（${Math.round(b.width)}×${Math.round(b.height)}）`;

export async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error(`寸法を測れません（見えていません）: ${String(l)}`);
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height };
}

/**
 * ページ全体の横のはみ出し: 文書の幅が画面より広い、または画面の左右からはみ出した要素・文字が、途中で切る / スクロールする
 * 要素（overflow が visible 以外。意図した局所スクロール）の中に無い
 */
export function pageOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const problems: string[] = [];
    const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (sw > vw + 1) problems.push(`文書の幅 ${sw}px が画面の幅 ${vw}px より広い`);
    // from から上（from を含む）に、切る / スクロールする要素があるか
    const clipped = (from: Element | null): boolean => {
      for (let e = from; e && e !== document.documentElement && e !== document.body; e = e.parentElement) {
        if (getComputedStyle(e).overflowX !== "visible") return true;
      }
      return false;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && problems.length < 8; n = walker.nextNode()) {
      const text = n instanceof Text ? n : null;
      const el = text ? text.parentElement : (n as Element);
      if (!el || (text && !text.data.trim())) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || el.closest("dialog:not([open])")) continue;
      let r: DOMRect;
      if (text) {
        const range = document.createRange();
        range.selectNodeContents(text);
        r = range.getBoundingClientRect();
      } else r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      // 文字は親から、要素はその親から上を見る（要素自身が切っていても、要素の箱が出ていればはみ出し）
      if (clipped(text ? el : el.parentElement)) continue;
      const what = text ? `文字「${text.data.trim().slice(0, 40)}」` : `${el.tagName.toLowerCase()}「${(el.textContent ?? "").trim().slice(0, 40)}」`;
      problems.push(`${what} が画面の外（x ${Math.round(r.left)}〜${Math.round(r.right)}、画面の幅 ${vw}）`);
    }
    return problems;
  });
}

/**
 * 枠からのはみ出し: 枠（container）の中の要素と文字が枠の外に出ていない。枠の中で切る / スクロールする要素の中身は、
 * その要素が枠の中にあればよい（局所スクロール）
 */
export function escapes(container: Locator): Promise<string[]> {
  return container.evaluate((root) => {
    const c = root.getBoundingClientRect();
    const problems: string[] = [];
    const clippedWithin = (el: Element | null): boolean => {
      for (let e = el; e && e !== root; e = e.parentElement) {
        if (getComputedStyle(e).overflowX !== "visible" || getComputedStyle(e).overflowY !== "visible") return true;
      }
      return false;
    };
    const out = (r: DOMRect) => r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1;
    const where = (r: DOMRect) => `x ${Math.round(r.left)}〜${Math.round(r.right)}, y ${Math.round(r.top)}〜${Math.round(r.bottom)}`;
    const frame = `枠 x ${Math.round(c.left)}〜${Math.round(c.right)}, y ${Math.round(c.top)}〜${Math.round(c.bottom)}`;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && problems.length < 8; n = walker.nextNode()) {
      if (n instanceof Text) {
        if (!n.data.trim() || !n.parentElement || clippedWithin(n.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width && out(r)) problems.push(`文字「${n.data.trim().slice(0, 40)}」が枠の外（${where(r)}、${frame}）`);
      } else if (n instanceof Element) {
        const style = getComputedStyle(n);
        if (style.display === "none" || style.position === "fixed" || n.closest("[aria-hidden=true]") || clippedWithin(n.parentElement)) continue;
        const r = n.getBoundingClientRect();
        if ((r.width || r.height) && out(r)) problems.push(`${n.tagName.toLowerCase()}「${(n.textContent ?? "").trim().slice(0, 40)}」が枠の外（${where(r)}、${frame}）`);
      }
    }
    return problems;
  });
}

/** 画面（viewport）の中に全体が入っている */
export async function inViewport(page: Page, l: Locator, what: string): Promise<string[]> {
  const vp = page.viewportSize()!;
  const b = await box(l);
  return b.left < -1 || b.top < -1 || b.right > vp.width + 1 || b.bottom > vp.height + 1 ? [`${what} が画面（${vp.width}×${vp.height}）の外: ${fmt(b)}`] : [];
}

/** スクロールする要素を端（右か下）まで送り、目印がその要素の見えている範囲に入ることを確かめる */
export async function reachByScroll(scroller: Locator, target: Locator, dir: "x" | "y", what: string): Promise<string[]> {
  const before = await scroller.evaluate((el, d) => {
    const can = d === "x" ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    if (d === "x") el.scrollLeft = el.scrollWidth;
    else el.scrollTop = el.scrollHeight;
    return can;
  }, dir);
  const s = await box(scroller);
  const t = await box(target);
  const inside = t.left >= s.left - 1 && t.right <= s.right + 1 && t.top >= s.top - 1 && t.bottom <= s.bottom + 1;
  return inside ? [] : [`${what}: 端まで送っても（送れる量 ${before}px）目印が見えている範囲に入らない（目印 ${fmt(t)}、範囲 ${fmt(s)}）`];
}

/** 操作できる（見えていて、ほかの要素に隠れていない。押しはしない） */
export async function reachable(l: Locator, what: string): Promise<string[]> {
  try {
    await l.scrollIntoViewIfNeeded({ timeout: 5000 });
    await l.click({ trial: true, timeout: 5000 });
    return [];
  } catch (e) {
    return [`${what} を操作できない: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`];
  }
}

/** 暗いテーマで描いているか（html の dark） */
export const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));

/** rgb(a) の明るさ（0〜1） */
export function luminance(css: string): number {
  const [r, g, b] = (css.match(/\d+(\.\d+)?/g) ?? ["255", "255", "255"]).slice(0, 3).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export { fmt as fmtBox };
