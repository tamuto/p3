import { useRef, useState } from "react";
import { ATTACHMENT_FORMATS, type PreflightRun, type UiMaterial } from "../../shared/types.ts";
import {
  draftAnchor,
  fixedAttachmentUrl,
  formatBytes,
  KIND_TONE,
  kindLabel,
  materialUrl,
  sortMaterials,
  uiStatusView,
} from "../lib/uiMaterials.ts";
import { Badge, Button, buttonCls, Empty, Section } from "./ui.tsx";

/**
 * 画面資料（その run の ui/）。提案・現状（添付）・仕様書から を分けて見せ、対象のタスク案へ移れる。
 * 画像は 要望 / run / 資料 ID の URL で取る（その run に固定したものだけ）
 */
export function UiMaterialsPanel({ requestId, run }: { requestId: string; run: PreflightRun }) {
  const view = uiStatusView(run);
  const items = sortMaterials(run.ui?.items ?? []);
  const [open, setOpen] = useState<UiMaterial | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const show = (m: UiMaterial) => {
    setOpen(m);
    dialog.current?.showModal();
  };
  return (
    <Section title="画面資料" aside={<Badge tone={view.tone}>{view.label}</Badge>}>
      <div className="space-y-3">
        {view.message && <p className="break-words text-sm text-slate-600 dark:text-slate-400">{view.message}</p>}
        {run.ui?.verdictAdjusted && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            必要な画面イメージが足りないので、判定を go から clarify にしました
          </p>
        )}
        {items.length > 0 ? (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((m) => (
              <li key={m.id} className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
                <button
                  type="button"
                  className="block h-44 w-full overflow-hidden border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950"
                  onClick={() => show(m)}
                  aria-label={`${m.title} を拡大`}
                >
                  <img src={materialUrl(requestId, run.id, m.id)} alt={m.title} loading="lazy" className="h-full w-full object-contain object-top" />
                </button>
                <div className="flex flex-1 flex-col gap-1.5 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={KIND_TONE[m.kind]}>{kindLabel(m.kind)}</Badge>
                    <span className="min-w-0 break-words font-medium">{m.title}</span>
                  </div>
                  <p className="text-slate-500">
                    {m.drafts.length > 0 && (
                      <>
                        対象{" "}
                        {m.drafts.map((k) => (
                          <a key={k} href={`#${draftAnchor(k)}`} className="mr-1 font-mono text-indigo-600 underline dark:text-indigo-400">
                            {k}
                          </a>
                        ))}
                        ·{" "}
                      </>
                    )}
                    {m.viewport ? `幅 ${m.viewport} · ` : ""}
                    {m.width}x{m.height} · {formatBytes(m.bytes)}
                  </p>
                  {m.source && <p className="break-words text-slate-500">出典: {m.source}</p>}
                  {m.assumptions.length > 0 && <p className="break-words text-slate-500">前提: {m.assumptions.join(" / ")}</p>}
                  {m.rendered && (
                    <p className="text-amber-700 dark:text-amber-400">
                      P3 が原稿から描いた画像です（Codex は画像を見ていません。読めるかを確かめてください）
                      {m.rendered.clipped ? "。縦に長いので上から切っています" : ""}
                    </p>
                  )}
                  {m.kind === "proposal" && <p className="text-slate-400">提案のイメージです（今の画面ではありません）</p>}
                  <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    <Button onClick={() => show(m)}>拡大</Button>
                    <a href={materialUrl(requestId, run.id, m.id)} target="_blank" rel="noreferrer" className={buttonCls("ghost")}>
                      画像を開く
                    </a>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          run.ui && run.ui.status !== "generating" && <Empty>画像はありません</Empty>
        )}
        {run.ui && run.ui.problems.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-500">取り込めなかった資料 {run.ui.problems.length} 件</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 break-words text-slate-600 dark:text-slate-400">
              {run.ui.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </details>
        )}
        <FixedAttachments requestId={requestId} run={run} />
      </div>
      <dialog
        ref={dialog}
        onClose={() => setOpen(null)}
        className="m-auto max-h-[95vh] w-[min(96vw,1400px)] max-w-none rounded-lg bg-white p-0 text-slate-900 backdrop:bg-black/60 dark:bg-slate-900 dark:text-slate-100"
        aria-label={open?.title ?? "画像"}
      >
        {open && (
          <div className="flex max-h-[95vh] flex-col">
            <div className="flex items-center gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
              <Badge tone={KIND_TONE[open.kind]}>{kindLabel(open.kind)}</Badge>
              <span className="min-w-0 flex-1 truncate font-medium">{open.title}</span>
              <a href={materialUrl(requestId, run.id, open.id)} target="_blank" rel="noreferrer" className={buttonCls("ghost")}>
                画像を開く
              </a>
              <Button autoFocus onClick={() => dialog.current?.close()}>
                閉じる
              </Button>
            </div>
            <div className="overflow-auto bg-slate-50 p-3 dark:bg-slate-950">
              <img src={materialUrl(requestId, run.id, open.id)} alt={open.title} className="mx-auto max-w-full" />
            </div>
          </div>
        )}
      </dialog>
    </Section>
  );
}

/** この run に固定した添付（後で添付を足し・消ししても変わらない） */
function FixedAttachments({ requestId, run }: { requestId: string; run: PreflightRun }) {
  const list = run.attachments ?? [];
  if (!list.length) return null;
  return (
    <div className="space-y-1 rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-950">
      <p className="font-medium">この run に固定した添付（Codex に渡したもの）</p>
      <ul className="space-y-1.5">
        {list.map((a) => {
          const x = a.extract;
          return (
            <li key={a.id} className="break-words">
              <span className="text-slate-500">{ATTACHMENT_FORMATS[a.format]}</span> {a.name}
              {a.description ? ` — ${a.description}` : ""}{" "}
              <a href={fixedAttachmentUrl(requestId, run.id, a.id)} className="text-indigo-600 underline dark:text-indigo-400">
                原本
              </a>
              {a.format === "xlsx" && (
                <span className="block text-slate-500">
                  {!x
                    ? "まだ取り出していません"
                    : x.error
                      ? `中身を取り出せませんでした（未読）: ${x.error}`
                      : `シート ${x.sheets}・セル ${x.cells}・画像 ${x.images.length} を取り出しました`}
                  {x?.unknownCells ? ` · 値が保存されていない数式 ${x.unknownCells}（未確認）` : ""}
                  {x?.truncated.length ? ` · 打ち切り: ${x.truncated.join(" / ")}` : ""}
                  {x?.unsupported.length ? ` · 扱っていないもの（未確認）: ${x.unsupported.join(" / ")}` : ""}
                  {x?.text && (
                    <>
                      {" "}
                      <a href={fixedAttachmentUrl(requestId, run.id, a.id, true)} target="_blank" rel="noreferrer" className="text-indigo-600 underline dark:text-indigo-400">
                        取り出した内容
                      </a>
                    </>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
