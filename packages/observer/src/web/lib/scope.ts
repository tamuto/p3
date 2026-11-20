/**
 * observer の画面の対象（ページを開いたときに入口の Boot.tsx が一度だけ決める。ページの間は変えない）。
 * observer は tasks の画面の部品を読まないので、入口が決めた対象を値で受け取る。
 *
 *   project  観測の定義を読み書きするプロジェクト（通常の serve はそのプロジェクト、プロジェクトを跨ぐ serve は URL の /projects/<名前>）。
 *            apiBase は観測の定義の API の基点、headers は変える操作に添えるもの（プロジェクトを跨ぐ serve の登録世代）
 *   choose   プロジェクトを跨ぐ serve で、まだプロジェクトを選んでいない（/observer）。選ぶとそのプロジェクトの観測の一覧へ移る
 */
export type ObserverScope =
  | { kind: "project"; project?: string; apiBase: string; headers: Record<string, string>; tasksHref: string }
  | { kind: "choose"; projects: { name: string; href: string; error?: string }[] };

let scope: ObserverScope | undefined;

export function fixObserverScope(s: ObserverScope) {
  if (scope) throw new Error("観測の画面の対象はもう決まっています（切り替えはページごと移る）");
  scope = Object.freeze({ ...s });
}

export function observerScope(): ObserverScope {
  if (!scope) throw new Error("観測の画面の対象がまだ決まっていません");
  return scope;
}
