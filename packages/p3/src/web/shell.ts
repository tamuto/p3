import type { Product } from "../shared/products.ts";

/**
 * この画面（ページ）の製品の選び方。ページを開いたときに Boot.tsx が /api/mode から一度だけ決める（ページの間は変えない）。
 *
 *   products  この serve で使える製品（p3 serve --products）
 *   tasks     この画面が tasks の画面か（tasks のプロジェクトを決め、AppDataProvider で tasks のデータ・設定・イベントを読む）。
 *             observer のページ（/observer）や observer だけの serve では false で、tasks のものを何も要求しない
 *   mode      serve の形（single / all-projects / none: tasks を使わない）
 *
 * 製品の間の移動はページごと移る（a 要素の遷移）。前の製品の取得・通知はページと一緒に消える
 */
export interface Shell {
  products: readonly Product[];
  tasks: boolean;
  mode: "single" | "all-projects" | "none";
}

let shell: Shell | undefined;

/** ページを開いたときに一度だけ呼ぶ */
export function fixShell(s: Shell) {
  if (shell) throw new Error("この画面の製品はもう決まっています（切り替えはページごと移る）");
  shell = Object.freeze({ ...s, products: Object.freeze([...s.products]) });
}

export function currentShell(): Shell {
  if (!shell) throw new Error("この画面の製品がまだ決まっていません");
  return shell;
}
