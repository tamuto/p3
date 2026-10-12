import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../../shared/types.ts";
import { api, type AttachmentList } from "../lib/api.ts";
import { useServerEvents } from "../lib/live.ts";
import {
  ATTACH_ACCEPT,
  attachmentUrl,
  emptyAttachForm,
  formatBytes,
  formatLabel,
  setUnsentAttachments,
  submitAttach,
  unsentAttachments,
  type AttachForm,
  type checkPending,
  type PendingAttach,
} from "../lib/uiMaterials.ts";
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
  /** 作成時に添付できなかったもの */
  const [unsent, setUnsent] = useState<PendingAttach[]>(() => unsentAttachments(requestId));
  const [retrying, setRetrying] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const keepUnsent = (items: PendingAttach[]) => (setUnsent(items), setUnsentAttachments(requestId, items));

  async function retry(p: PendingAttach) {
    setRetrying(p.key);
    try {
      await api.addAttachment(requestId, { file: p.file, description: p.description, source: p.source });
      keepUnsent(unsent.filter((x) => x.key !== p.key));
      reload();
    } catch (e) {
      keepUnsent(unsent.map((x) => (x.key === p.key ? { ...x, error: (e as Error).message } : x)));
    } finally {
      setRetrying(null);
    }
  }

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
        {unsent.length > 0 && (
          <div role="alert" className="space-y-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">作成時に添付できなかったファイルがあります（要望は作成済みです）</p>
            <ul className="space-y-1.5">
              {unsent.map((p) => (
                <li key={p.key} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all font-medium">{p.file.name}</span>
                  <span className="min-w-0 flex-1 break-words">{p.error?.replace(`${p.file.name}: `, "")}</span>
                  <span className="flex gap-2">
                    <Button disabled={retrying === p.key} onClick={() => void retry(p)}>
                      {retrying === p.key ? "添付中…" : "付け直す"}
                    </Button>
                    <Button variant="ghost" onClick={() => keepUnsent(unsent.filter((x) => x.key !== p.key))}>
                      やめる
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-amber-800 dark:text-amber-300">この一覧はページを再読み込みすると消えます。そのときは下の欄から選び直してください</p>
          </div>
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

/**
 * 新しい要望の作成と同時に添付するファイル（作成の前に形式・大きさ・件数を知らせる。中身はサーバで確かめる）
 */
export function NewAttachments({
  items,
  onChange,
  check,
  disabled,
}: {
  items: PendingAttach[];
  onChange: (items: PendingAttach[]) => void;
  check: ReturnType<typeof checkPending>;
  disabled: boolean;
}) {
  const seq = useRef(0);
  const update = (key: string, patch: Partial<PendingAttach>) => onChange(items.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-slate-500 dark:text-slate-400">添付（任意。PNG / JPEG / xlsx。今の画面のスクリーンショットや仕様書など。Preflight に渡します）</legend>
      {items.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg bg-white px-3 ring-1 ring-slate-200 dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-800">
          {items.map((p, i) => (
            <li key={p.key} className="space-y-2 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-all font-medium">{p.file.name}</span>
                <span className="text-sm text-slate-500">{formatBytes(p.file.size)}</span>
                <Button variant="ghost" className="ml-auto" onClick={() => onChange(items.filter((x) => x.key !== p.key))}>
                  外す
                </Button>
              </div>
              {check.items[i] && <p className="text-sm text-rose-600">{check.items[i]}</p>}
              <div className="flex flex-wrap gap-2">
                <input className={`${inputCls} min-w-0 flex-1`} aria-label={`${p.file.name} の説明`} placeholder="説明（例: 今の一覧画面）" value={p.description} onChange={(e) => update(p.key, { description: e.target.value })} />
                <input className={`${inputCls} min-w-0 flex-1`} aria-label={`${p.file.name} の出典`} placeholder="出典（例: 本番の画面）" value={p.source} onChange={(e) => update(p.key, { source: e.target.value })} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {check.total && <p className="text-sm text-rose-600">{check.total}</p>}
      <input
        type="file"
        multiple
        accept={ATTACH_ACCEPT}
        aria-label="添付するファイルを選ぶ"
        className="max-w-full text-sm"
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])].map((file) => ({ key: `f${++seq.current}`, file, description: "", source: "" }));
          onChange([...items, ...picked]);
          e.target.value = "";
        }}
      />
    </fieldset>
  );
}
