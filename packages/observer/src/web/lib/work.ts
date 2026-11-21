import { observerScope } from "./scope.ts";

/**
 * 画面の作業の文脈（タスクの詳細の「この作業として観測を開く」から移ったときの <要望ID>/<T>）。タブの中だけ・プロジェクトの API ごとに覚え、
 * 観測を変える操作に添える（アプリが同じプロジェクトの作業中のタスクかを確かめ、履歴に作業の帰属を残す）。覚えられないときは添えない
 */
const key = () => `p3-observer-work:${observerScope().apiBase}`;

export function workRef(): string | undefined {
  try {
    return sessionStorage.getItem(key()) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setWorkRef(ref: string | undefined) {
  try {
    if (ref) sessionStorage.setItem(key(), ref);
    else sessionStorage.removeItem(key());
  } catch {
    // 覚えられなければ作業の帰属を付けない
  }
}
