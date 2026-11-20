/**
 * observer の画面の API の基点（ページを開いたときに入口の Boot.tsx が、tasks の画面と同じプロジェクトで一度だけ決める）。
 * observer は tasks の画面の部品を読まないので、入口が決めた値を受け取る。headers は変える操作に添えるもの（プロジェクトを跨ぐ serve の登録世代）
 */
export interface ObserverScope {
  apiBase: string;
  headers: Record<string, string>;
}

let scope: ObserverScope | undefined;

export function fixObserverScope(s: ObserverScope) {
  if (scope) throw new Error("観測の画面の対象はもう決まっています（切り替えはページごと移る）");
  scope = Object.freeze({ ...s });
}

export function observerScope(): ObserverScope {
  if (!scope) throw new Error("観測の画面の対象がまだ決まっていません");
  return scope;
}
