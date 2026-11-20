/**
 * この画面（ページ）の製品の選び方。ページを開いたときに Boot.tsx が URL と /api/mode から一度だけ決める（ページの間は変えない）。
 * serve は常に tasks と observer の両方を起動する（製品ごとの ON/OFF は無い）。
 *
 *   tasks     この画面が tasks の画面か（tasks のプロジェクトを決め、AppDataProvider で tasks のデータ・設定・イベントを読む）。
 *             observer のページ（/observer）では false で、tasks のものを何も要求しない
 *   mode      serve の形（single / all-projects）
 *
 * 製品の間の移動はページごと移る（a 要素の遷移）。前の製品の取得・通知はページと一緒に消える
 */
export interface Shell {
  tasks: boolean;
  mode: "single" | "all-projects";
}

let shell: Shell | undefined;

/** ページを開いたときに一度だけ呼ぶ */
export function fixShell(s: Shell) {
  if (shell) throw new Error("この画面の製品はもう決まっています（切り替えはページごと移る）");
  shell = Object.freeze({ ...s });
}

export function currentShell(): Shell {
  if (!shell) throw new Error("この画面の製品がまだ決まっていません");
  return shell;
}
