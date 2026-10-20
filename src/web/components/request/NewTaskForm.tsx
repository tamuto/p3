import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { ProjectConfig, Request, Task } from "../../../shared/types.ts";
import { DIRECT_TASK_NOTE } from "../../../shared/directTask.ts";
import { defaultRepo, NO_REPO, repoChoices } from "../../../shared/workTarget.ts";
import { api } from "../../lib/api.ts";
import { Button, Field, inputCls } from "../ui.tsx";

/** タスクを足しても状態が変わらず、作業を始めるなら手で進行中にする要望 */
const BEFORE_ACTIVE: Request["status"][] = ["draft", "preflight", "reviewed"];

/**
 * Preflight を通さずに、要望へタスクを直接足す（未着手で作る）。Docker・ChatGPT・Preflight の成否によらず使える。
 * 作業先は作業先にできる参照先と「作業先なし」から選び、既定は CLI の `p3 new` と同じ（defaultRepo）。関係（依存・置き換え）は張らない。
 * ネイティブの dialog（Escape・取消で閉じる。閉じたら開いたボタンへフォーカスを戻すのは呼び出し側）
 */
export function NewTaskForm({
  dialog,
  request,
  project,
  onCreated,
  onFailed,
  onClose,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  request: Pick<Request, "id" | "status">;
  project: Pick<ProjectConfig, "repos">;
  /** 作った（reopened: 対応済から進行中に戻した） */
  onCreated: (task: Task, reopened: boolean) => void;
  /** 保存に失敗した。保存はできていて後の処理だけが失敗したこともあるので、一覧を読み直す */
  onFailed: () => void;
  onClose: () => void;
}) {
  const initialRepo = defaultRepo(project) ?? NO_REPO;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [repo, setRepo] = useState(initialRepo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  // 開くたびに空にする（取消・作成のあとに前の入力を残さない。失敗したときは閉じないので入力は残る）
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const reset = () => {
      if (d.open) return;
      setTitle("");
      setBody("");
      setRepo(initialRepo);
      setError(null);
    };
    d.addEventListener("close", reset);
    return () => d.removeEventListener("close", reset);
  }, [dialog, initialRepo]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // 保存中の二度押し（Enter の連打を含む）は送らない
    if (busyRef.current) return;
    if (!title.trim()) {
      setError("題を入れてください（空白だけの題では作れません）");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const input: Partial<Task> = { title: title.trim(), body, status: "todo" };
      if (project.repos.length) input.repo = repo === NO_REPO ? null : repo;
      const created = (await api.createTask(request.id, input)) as Task & { reopened?: string };
      onCreated(created, !!created.reopened);
      dialog.current?.close();
    } catch (err) {
      setError(
        `保存できませんでした: ${(err as Error).message}。タスクの一覧を読み直しました。同じタスクが未着手にできていないか確かめてから、もう一度保存してください。`,
      );
      onFailed();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const choices = repoChoices(project, repo === NO_REPO ? null : repo);
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      // 保存中は Escape で閉じない（閉じても保存は進むので、結果が見えなくなる）
      onCancel={(e) => busyRef.current && e.preventDefault()}
      aria-labelledby="new-task-title"
      className="m-auto max-h-[90vh] w-[min(calc(100vw-1rem),720px)] max-w-none rounded-lg bg-white p-0 text-slate-900 backdrop:bg-black/60 dark:bg-slate-900 dark:text-slate-100"
    >
      <form onSubmit={(e) => void submit(e)} className="flex max-h-[90vh] flex-col">
        <div className="border-b border-slate-200 p-3 sm:p-4 dark:border-slate-800">
          <h2 id="new-task-title" className="font-semibold">
            タスクを追加（Preflight を通さない）
          </h2>
          <p className="mt-1 text-sm text-slate-500">{DIRECT_TASK_NOTE}</p>
        </div>
        <div className="min-h-0 space-y-3 overflow-y-auto p-3 sm:p-4">
          <Field label="題">
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} autoFocus />
          </Field>
          <Field label="本文（作業内容・完了条件）">
            <textarea rows={8} className={`${inputCls} font-mono`} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
          </Field>
          {project.repos.length > 0 && (
            <Field label="作業先">
              <select className={inputCls} value={repo} onChange={(e) => setRepo(e.target.value)} disabled={busy}>
                {choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {BEFORE_ACTIVE.includes(request.status) && (
            <p className="text-sm text-slate-500">
              タスクを足しても要望のステータスは変わりません。作業を始めるときは、概要のタブでステータスを「進行中」にしてください。
            </p>
          )}
          {request.status === "resolved" && <p className="text-sm text-slate-500">対応済の要望に未着手のタスクを足すと、要望は進行中に戻ります。</p>}
          {error && (
            <p role="alert" className="text-rose-600">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 p-3 sm:p-4 dark:border-slate-800">
          <Button type="button" onClick={() => dialog.current?.close()} disabled={busy}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "作成中…" : "作成"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
