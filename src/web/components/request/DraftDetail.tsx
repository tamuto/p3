import { type RefObject } from "react";
import { relationRole, type ProjectConfig, type ProposedTask } from "../../../shared/types.ts";
import { NO_REPO, repoChoices } from "../../../shared/workTarget.ts";
import { Markdown } from "../Markdown.tsx";
import { Badge, Button } from "../ui.tsx";

/**
 * タスク案の詳細（読むだけ）。本文を Markdown として全文見せる。採否・題・作業先の変更は一覧のカードで行う。
 * ネイティブの dialog（Escape・閉じるで閉じる。閉じたら開いたボタンへフォーカスを戻すのは呼び出し側）
 */
export function DraftDetail({
  dialog,
  draft,
  project,
  onClose,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  draft: ProposedTask | null;
  project: Pick<ProjectConfig, "repos">;
  onClose: () => void;
}) {
  const repoLabel = draft && (repoChoices(project, draft.repo).find((c) => c.value === (draft.repo ?? NO_REPO))?.label ?? draft.repo);
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="draft-detail-title"
      className="m-auto max-h-[90vh] w-[min(calc(100vw-1rem),960px)] max-w-none rounded-lg bg-white p-0 text-slate-900 backdrop:bg-black/60 dark:bg-slate-900 dark:text-slate-100"
    >
      {draft && (
        <div className="flex max-h-[90vh] flex-col">
          <div className="flex items-start gap-3 border-b border-slate-200 p-3 sm:p-4 dark:border-slate-800">
            <h2 id="draft-detail-title" className="min-w-0 flex-1 font-semibold break-words">
              <span className="mr-2 font-mono text-slate-500">{draft.key}</span>
              {draft.title}
            </h2>
            <Button autoFocus className="shrink-0" onClick={() => dialog.current?.close()}>
              閉じる
            </Button>
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm sm:px-4 dark:border-slate-800 dark:bg-slate-950">
            <div className="flex gap-1">
              <dt className="sr-only">採否</dt>
              <dd>{draft.include ? "採用" : "不採用"}</dd>
            </div>
            {project.repos.length > 0 && (
              <div className="flex gap-1">
                <dt className="text-slate-500">作業先</dt>
                <dd>{repoLabel}</dd>
              </div>
            )}
            <div className="flex gap-1">
              <dt className="text-slate-500">依存先</dt>
              <dd className="font-mono">{draft.dependsOn.join(", ") || "なし"}</dd>
            </div>
            <div className="flex min-w-0 gap-1">
              <dt className="shrink-0 text-slate-500">{relationRole("supersedes", "out")}</dt>
              <dd className="min-w-0 font-mono break-all">{draft.supersedes.join(", ") || "なし"}</dd>
            </div>
            {draft.areas.length > 0 && (
              <div className="flex w-full min-w-0 flex-wrap gap-1">
                <dt className="sr-only">領域</dt>
                {draft.areas.map((a) => (
                  <dd key={a} className="min-w-0 max-w-full">
                    <Badge className="max-w-full font-mono whitespace-normal break-all">{a}</Badge>
                  </dd>
                ))}
              </div>
            )}
          </dl>
          <div className="min-h-0 overflow-y-auto p-3 sm:p-5">
            {draft.description.trim() ? <Markdown text={draft.description} /> : <p className="text-slate-500">本文なし</p>}
          </div>
        </div>
      )}
    </dialog>
  );
}
