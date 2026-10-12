import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../../shared/types.ts";
import { api, type AttachmentList } from "../lib/api.ts";
import { useServerEvents } from "../lib/live.ts";
import { ATTACH_ACCEPT, attachmentUrl, emptyAttachForm, formatBytes, formatLabel, submitAttach, type AttachForm } from "../lib/uiMaterials.ts";
import { Badge, Button, buttonCls, inputCls, Section } from "./ui.tsx";

/**
 * 要望の添付（次の Preflight に渡すもの）。画像・xlsx を足し・外し・原本を取る。
 * 入力は失敗しても残す（選び直さずに再試行できる）。ほかの欄（メモ・タスク案）の入力には触らない
 */
export function AttachmentsPanel({ requestId, tick }: { requestId: string; tick: number }) {
  const [list, setList] = useState<AttachmentList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<AttachForm>(emptyAttachForm);
  const [removing, setRemoving] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = () =>
    void api.attachments(requestId).then(
      (l) => (setList(l), setLoadError(null)),
      (e: Error) => setLoadError(`添付の一覧を取れません: ${e.message}`),
    );
  useEffect(reload, [requestId, tick]);
  useServerEvents((e) => {
    if (e.type === "changed" && e.kind === "attachment" && e.request === requestId) reload();
  });

  async function send() {
    setForm((f) => ({ ...f, busy: true, error: null }));
    const next = await submitAttach(form, (f) => api.addAttachment(requestId, f));
    setForm(next);
    if (!next.error) {
      if (fileInput.current) fileInput.current.value = "";
      reload();
    }
  }

  async function remove(a: Attachment) {
    if (!window.confirm(`${a.name} を外しますか？（実行済みの Preflight に固定した資料は残ります）`)) return;
    setRemoving(a.id);
    try {
      await api.removeAttachment(requestId, a.id);
      reload();
    } catch (e) {
      setLoadError(`外せませんでした: ${(e as Error).message}`);
    } finally {
      setRemoving(null);
    }
  }

  const items = list?.items ?? [];
  return (
    <Section title={`添付（次の Preflight に渡す）${items.length ? ` ${items.length}` : ""}`}>
      <div className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Preflight を始めるときに、その時点の添付を run に固定して Codex に渡します。実行済みの run の資料は変わりません。
          今の画面が要るときは、撮った画像を添付してください。PNG / JPEG / xlsx{list ? `（${list.limits.count} 件・合計 ${formatBytes(list.limits.totalBytes)} まで）` : ""}
        </p>
        {items.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 py-2">
                <Badge>{formatLabel(a)}</Badge>
                <span className="min-w-0 break-all font-medium">{a.name}</span>
                <span className="min-w-0 break-words text-sm text-slate-500">
                  {[a.description, a.source && `出典: ${a.source}`, formatBytes(a.bytes), a.createdBy].filter(Boolean).join(" · ")}
                </span>
                <span className="ml-auto flex gap-2">
                  <a href={attachmentUrl(requestId, a.id)} className={buttonCls("ghost")} {...(a.format === "xlsx" ? { download: a.name } : { target: "_blank", rel: "noreferrer" })}>
                    原本
                  </a>
                  <Button variant="ghost" disabled={removing === a.id} onClick={() => void remove(a)}>
                    外す
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {list?.invalid.map((i) => (
          <p key={i.id} className="text-sm text-rose-600">
            読めない添付: {i.id}（{i.error}）
          </p>
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="text-slate-500">ファイル</span>
            <input
              ref={fileInput}
              type="file"
              accept={ATTACH_ACCEPT}
              className="max-w-full text-sm"
              onChange={(e) => setForm((f) => ({ ...f, file: e.target.files?.[0] ?? null, error: null }))}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm sm:max-w-xs">
            <span className="text-slate-500">説明</span>
            <input className={inputCls} value={form.description} placeholder="例: 今の一覧画面" onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm sm:max-w-xs">
            <span className="text-slate-500">出典</span>
            <input className={inputCls} value={form.source} placeholder="例: 本番の画面" onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} />
          </label>
          <Button variant="primary" disabled={!form.file || form.busy} onClick={() => void send()}>
            {form.busy ? "添付中…" : "添付する"}
          </Button>
        </div>
        {form.error && (
          <p role="alert" className="text-sm text-rose-600">
            添付できませんでした: {form.error}（入力は残しています。直してもう一度押してください）
          </p>
        )}
        {loadError && <p className="text-sm text-rose-600">{loadError}</p>}
      </div>
    </Section>
  );
}
