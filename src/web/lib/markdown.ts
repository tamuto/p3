import type { ProposedTask } from "../../shared/types.ts";
import { outputHref } from "./outputs.ts";

/**
 * 画面で読むだけの Markdown（今はタスク案の本文）の安全な見せ方。描画は react-markdown + remark-gfm（components/Markdown.tsx）。
 *
 *   - リンクは絶対の http(s) URL だけ（成果物と同じ判定 outputHref）。相対パス・アンカー・javascript: / data: / file: などは文字で出す
 *   - 生の HTML は解釈せず、書かれたとおりの文字として出す（htmlAsText）
 *   - 画像は取りに行かず、代替テキストを出す
 */
export const markdownHref = (url: string): string | null => outputHref(url);

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** remark のプラグイン: 生の HTML（html の節）を文字の節に変える（書かれたとおりに見せ、要素にはしない） */
export function htmlAsText() {
  const walk = (node: MdNode) => {
    if (node.type === "html") node.type = "text";
    node.children?.forEach(walk);
  };
  return walk;
}

/** 詳細を開いている案（run と案のキーの組。同じキーでも別の run の案は取り違えない） */
export interface DraftSelection {
  runId: string;
  key: string;
}

/** 開いている案の今の内容。run が切り替わった・案が無くなったら null（閉じる）。外で更新されたら最新の内容を返す */
export function selectedDraft(sel: DraftSelection | null, run: { id: string; drafts: ProposedTask[] }): ProposedTask | null {
  if (!sel || sel.runId !== run.id) return null;
  return run.drafts.find((d) => d.key === sel.key) ?? null;
}
