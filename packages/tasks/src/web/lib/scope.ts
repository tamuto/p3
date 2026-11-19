/**
 * この画面（ページ）が扱うプロジェクト。ページを開いたときに一度だけ決め、ページの間は変えない（Boot.tsx）。
 *
 *   single        通常の serve（API は /api、URL は今までどおり）
 *   all-projects  プロジェクトを跨ぐ serve。API は /api/projects/<名前>、URL は /projects/<名前>/...。
 *                 変える操作には登録世代を添え、登録が変わっていれば断られる（古い画面の保存を新しい登録先へ流さない）
 *
 * プロジェクトを切り替えるときはページごと移る（ProjectSwitcher）。前のプロジェクトの取得・通知・タイマーは、ページと一緒に
 * 消えるので、別のプロジェクトへ混ざらない
 */
export type ProjectScope = { mode: "single" } | { mode: "all-projects"; project: string; generation: string };

let scope: ProjectScope | undefined;

/** ページを開いたときに一度だけ呼ぶ */
export function fixScope(s: ProjectScope) {
  if (scope) throw new Error("この画面の対象はもう決まっています（切り替えはページごと移る）");
  scope = Object.freeze({ ...s });
}

export function currentScope(): ProjectScope {
  if (!scope) throw new Error("この画面の対象がまだ決まっていません");
  return scope;
}

/** API の基点 */
export const apiBase = () => {
  const s = currentScope();
  return s.mode === "single" ? "/api" : `/api/projects/${encodeURIComponent(s.project)}`;
};

/** 画面の URL の基点（ルーターの basepath） */
export const pageBase = (s: ProjectScope = currentScope()) => (s.mode === "single" ? "/" : projectPath(s.project));

/**
 * プロジェクトを跨ぐ serve の一覧を、登録が1つでも出す URL（ヘッダーの「プロジェクトの一覧…」・選び直しの案内から）。
 * 入口（/）は登録が1つで開けるなら一覧を飛ばす
 */
export const CHOOSER_URL = "/?list";

/** URL が一覧を出すよう求めている（?list） */
export const listRequested = (search: string) => new URLSearchParams(search).has("list");

/** プロジェクトを跨ぐ serve で、そのプロジェクトの画面の URL */
export const projectPath = (name: string) => `/projects/${encodeURIComponent(name)}`;

/** API に添えるヘッダー（登録世代） */
export const scopeHeaders = (): Record<string, string> => {
  const s = currentScope();
  return s.mode === "all-projects" ? { "x-p3-project-generation": s.generation } : {};
};

/** URL（/projects/<名前>/...）から、開こうとしているプロジェクトの名前 */
export function projectFromPath(pathname: string): string | undefined {
  const m = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}
