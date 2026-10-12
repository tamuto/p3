import { useState, type Dispatch, type SetStateAction } from "react";
import { type Request } from "../../../shared/types.ts";
import { Badge, Button, inputCls } from "../ui.tsx";
import { api, ApiError, failureOf } from "../../lib/api.ts";
import { discardDraft, draftOf, editDraft, isDirty, sameBody, type Draft } from "../../lib/draft.ts";
import { bodySaveErrorText, excerpt } from "../../lib/requestEdit.ts";
import { ExternalChange } from "./ExternalChange.tsx";

/** 要望の本文の表示と編集 */

/**
 * 要望の本文。「本文を編集」で入力欄にし、「本文を保存」で保存する（ぼかしただけでは保存しない）。どの状態でも編集でき、空にもできる。
 * 保存は編集を始めたときの rev で行い、外で変わっていれば競合として入力を残す。評価のあとで変えると、その評価からはタスク化できない
 */
export function BodyEditor({
  request,
  draft,
  setDraft,
  editing,
  setEditing,
  gone,
  running,
  hasRuns,
  onSaved,
  onConflict,
}: {
  request: Request;
  draft: Draft<string>;
  setDraft: Dispatch<SetStateAction<Draft<string>>>;
  editing: boolean;
  setEditing: (v: boolean) => void;
  gone: boolean;
  running: boolean;
  hasRuns: boolean;
  onSaved: () => void;
  onConflict: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const dirty = isDirty(draft, sameBody);
  const id = `request-body-${request.id}`;

  function open() {
    // 編集を始めるときは今の本文から
    setDraft((d) => (isDirty(d, sameBody) ? d : draftOf(request.body, request.rev)));
    setMessage(null);
    setEditing(true);
  }

  function cancel() {
    setDraft((d) => discardDraft(d));
    setMessage(null);
    setEditing(false);
  }

  async function save() {
    if (busy) return;
    if (gone) return setMessage({ error: true, text: bodySaveErrorText(new ApiError(404, "", null)) });
    if (!dirty) return cancel();
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api.patchRequest(request.id, { body: draft.value, rev: draft.baseRev });
      setDraft(draftOf(saved.body, saved.rev));
      setEditing(false);
      setMessage({
        error: false,
        text: hasRuns
          ? "本文を保存しました。今の内容で評価するには「もう一度 Preflight」を実行してください（既存のタスク・成果物・ステータスはそのまま残ります）"
          : "本文を保存しました。次の Preflight でこの内容を評価します",
      });
      onSaved();
    } catch (e) {
      setMessage({ error: true, text: bodySaveErrorText(e) });
      if (failureOf(e) === "rev_conflict") onConflict();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {editing ? (
          <label htmlFor={id} className="font-semibold">
            要望の本文
          </label>
        ) : (
          <h2 className="font-semibold">要望の本文</h2>
        )}
        {editing ? dirty && <Badge tone="amber">未保存</Badge> : <Button onClick={open}>本文を編集</Button>}
      </div>
      {editing ? (
        <>
          <textarea
            id={id}
            rows={8}
            className={inputCls}
            value={draft.value}
            readOnly={busy}
            onChange={(e) => setDraft((d) => editDraft(d, e.target.value))}
            onKeyDown={(e) => e.key === "Escape" && !dirty && cancel()}
          />
          <ExternalChange label="本文" draft={draft} eq={sameBody} show={(v) => excerpt(v)} onDiscard={() => (setDraft((d) => discardDraft(d)), setMessage(null))} />
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-600 dark:text-slate-400">
            <li>保存すると、この内容が次の Preflight の評価対象になります。</li>
            {running && <li>実行中の評価には、始めたときの内容が使われます。</li>}
            {hasRuns && <li>保存しても既存のタスク・成果物・ステータスは残ります。評価のあとで変えると、その評価からはタスク化できません（もう一度 Preflight）。</li>}
            {hasRuns && <li>再評価では保存済みのメモも渡します。置き換えるタスクは、タスク化のときに選びます。</li>}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={busy || gone} onClick={() => void save()}>
              {busy ? "保存中…" : "本文を保存"}
            </Button>
            <Button disabled={busy} onClick={cancel}>
              キャンセル
            </Button>
          </div>
        </>
      ) : (
        <p className="break-words whitespace-pre-wrap">{request.body.trim() ? request.body : <span className="text-slate-400">（本文なし）</span>}</p>
      )}
      {message && (
        <p role={message.error ? "alert" : "status"} className={message.error ? "text-rose-600" : "text-emerald-700 dark:text-emerald-400"}>
          {message.text}
        </p>
      )}
    </div>
  );
}

