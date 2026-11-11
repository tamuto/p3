import { type RefObject } from "react";
import type { AcceptanceCriterion } from "../../../shared/acceptance.ts";
import { relationRole, type ProjectConfig, type ProposedTask } from "../../../shared/types.ts";
import { NO_REPO, repoChoices } from "../../../shared/workTarget.ts";
import { CriteriaRowsEditor, rowsEqual, rowsInvalid, rowsOf, type CriterionRow } from "../Acceptance.tsx";
import { Markdown } from "../Markdown.tsx";
import { Badge, Button } from "../ui.tsx";

/** 案の受け入れ基準の編集中の状態（一覧が持つ。詳細を閉じても入力は残る） */
export interface CriteriaEdit {
  /** 編集を始めたときの基準（保存の期待値） */
  base: AcceptanceCriterion[];
  rows: CriterionRow[];
  saving: boolean;
  error: string | null;
  /** 保存が他の変更とぶつかった（今の基準）。そのあいだは保存しない */
  conflict: AcceptanceCriterion[] | null;
}

export const criteriaEditDirty = (e: CriteriaEdit | undefined) => !!e && !rowsEqual(e.rows, rowsOf(e.base));

/**
 * タスク案の詳細。本文を Markdown として全文見せ、受け入れ基準をタスク化の前に直せる（保存・取消）。採否・題・作業先の変更は一覧のカードで行う。
 * ネイティブの dialog（Escape・閉じるで閉じる。閉じたら開いたボタンへフォーカスを戻すのは呼び出し側）
 */
export function DraftDetail({
  dialog,
  draft,
  project,
  onClose,
  done = false,
  edit,
  onEdit,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  draft: ProposedTask | null;
  project: Pick<ProjectConfig, "repos">;
  onClose: () => void;
  /** タスク化した後（基準は読むだけ） */
  done?: boolean;
  edit?: CriteriaEdit;
  onEdit?: {
    start: () => void;
    change: (rows: CriterionRow[]) => void;
    save: () => void;
    cancel: () => void;
    /** 他で変わった基準を元に、入力を残して直し直す */
    rebase: () => void;
  };
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
          <div className="min-h-0 space-y-6 overflow-y-auto p-3 sm:p-5">
            {draft.description.trim() ? <Markdown text={draft.description} /> : <p className="text-slate-500">本文なし</p>}
            <section aria-labelledby="draft-criteria-title" className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
              <h3 id="draft-criteria-title" className="font-semibold">
                受け入れ基準
              </h3>
              {!done && <p className="text-sm text-slate-500">タスク化する前に直せます。ここでは証拠は入力しません（作業した側が完了するときに残します）。</p>}
              {draft.acceptanceProblems?.length ? (
                <div role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-300">
                  <p>案の受け入れ基準に読めない値があります。直すまでこの案はタスク化できません（保存すると読めた項目で置き換えます）:</p>
                  <ul className="list-disc pl-5">
                    {draft.acceptanceProblems.map((p) => (
                      <li key={p} className="break-words">
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {edit && onEdit && !done ? (
                <div className="space-y-3">
                  <CriteriaRowsEditor rows={edit.rows} disabled={edit.saving} idPrefix={`draft-${draft.key}`} onChange={onEdit.change} />
                  {edit.conflict ? (
                    <div role="alert" className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      <p>編集中に受け入れ基準が他で変わりました。入力はそのままです（このままでは保存しません）。</p>
                      <p className="break-words">最新の基準: {edit.conflict.map((c) => `${c.id} ${c.text}`).join(" / ") || "なし"}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" className="text-sm" onClick={onEdit.rebase}>
                          最新に合わせて入力を残す
                        </Button>
                        <Button type="button" variant="ghost" className="text-sm" onClick={onEdit.cancel}>
                          入力を捨てる
                        </Button>
                      </div>
                    </div>
                  ) : (
                    criteriaEditDirty(edit) && (
                      <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        保存していない変更があります。保存してから採用内容を確かめてください。
                      </p>
                    )
                  )}
                  {edit.error && <p className="text-sm break-words text-rose-600">{edit.error}</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="primary" disabled={edit.saving || !!edit.conflict || rowsInvalid(edit.rows) || !criteriaEditDirty(edit)} onClick={onEdit.save}>
                      {edit.saving ? "保存中…" : "基準を保存"}
                    </Button>
                    <Button type="button" disabled={edit.saving} onClick={onEdit.cancel}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {draft.acceptanceCriteria?.length ? (
                    <ol className="space-y-1">
                      {draft.acceptanceCriteria.map((c) => (
                        <li key={c.id} className="flex min-w-0 gap-2">
                          <span className="shrink-0 font-mono text-sm text-slate-500">{c.id}</span>
                          <span className="min-w-0 break-words">{c.text}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-slate-500">受け入れ基準なし</p>
                  )}
                  {!done && onEdit && (
                    <Button type="button" className="text-sm" onClick={onEdit.start}>
                      {draft.acceptanceCriteria?.length ? "基準を編集" : "基準を足す"}
                    </Button>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      )}
    </dialog>
  );
}
