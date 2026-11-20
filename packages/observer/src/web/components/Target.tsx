import type { DefinitionTargetInfo } from "../lib/api.ts";

/** 登録先（どのプロジェクトのどこに保存するか）。一覧・詳細・登録・編集の画面の上に出す */
export function TargetLine({ target }: { target?: DefinitionTargetInfo }) {
  if (!target) return null;
  return (
    <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="observer-target">
      登録先: {target.project ? `プロジェクト ${target.project}` : "このプロジェクト"}
      <span className="ml-2 break-all font-mono">（{`${target.dataDir}/${target.dir}`}）</span>
    </p>
  );
}

export const linkCls = "text-sky-700 underline hover:text-sky-900 dark:text-sky-400";
export const primaryCls = "inline-block rounded bg-sky-600 px-3 py-1.5 font-medium text-white hover:bg-sky-700";
