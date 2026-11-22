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
import { Badge, Button, buttonCls, Empty, PlainButton, Section } from "@infodb/p3-shared/web/ui.tsx";

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
        {view.message && <p className="break-words text-base text-fg-3">{view.message}</p>}
        {run.ui?.verdictAdjusted && (
          <p className="rounded-md bg-warn-soft px-3 py-2 text-base text-warn-strong">
            必要な画面イメージが足りないので、判定を go から clarify にしました
          </p>
        )}
        {items.length > 0 ? (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((m) => (
              <li key={m.id} className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-surface ring-1 ring-line">
                <PlainButton className="block h-44 w-full overflow-hidden border-b border-line bg-page" onClick={() => show(m)} aria-label={`${m.title} を拡大`}>
                  <img src={materialUrl(requestId, run.id, m.id)} alt={m.title} loading="lazy" className="h-full w-full object-contain object-top" />
                </PlainButton>
                <div className="flex flex-1 flex-col gap-1.5 p-3 text-base">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={KIND_TONE[m.kind]}>{kindLabel(m.kind)}</Badge>
                    <span className="min-w-0 break-words font-medium">{m.title}</span>
                  </div>
                  <p className="text-fg-4">
                    {m.drafts.length > 0 && (
                      <>
                        対象{" "}
                        {m.drafts.map((k) => (
                          <a key={k} href={`#${draftAnchor(k)}`} className="mr-1 font-mono text-accent underline">
                            {k}
                          </a>
                        ))}
                        ·{" "}
                      </>
                    )}
                    {m.viewport ? `幅 ${m.viewport} · ` : ""}
                    {m.width}x{m.height} · {formatBytes(m.bytes)}
                  </p>
                  {m.source && <p className="break-words text-fg-4">出典: {m.source}</p>}
                  {m.assumptions.length > 0 && <p className="break-words text-fg-4">前提: {m.assumptions.join(" / ")}</p>}
                  {m.rendered && (
                    <p className="text-warn">
                      P3 が原稿から描いた画像です（Codex は画像を見ていません。読めるかを確かめてください）
                      {m.rendered.clipped ? "。縦に長いので上から切っています" : ""}
                    </p>
                  )}
                  {m.kind === "proposal" && <p className="text-fg-4">提案のイメージです（今の画面ではありません）</p>}
                  <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    <Button onClick={() => show(m)}>拡大</Button>
                    <a href={materialUrl(requestId, run.id, m.id)} target="_blank" rel="noreferrer" className={buttonCls("secondary")}>
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
          <details className="text-base">
            <summary className="cursor-pointer text-fg-4">取り込めなかった資料 {run.ui.problems.length} 件</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 break-words text-fg-3">
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
        className="m-auto max-h-[95vh] w-[min(96vw,1400px)] max-w-none rounded-lg bg-surface p-0 text-fg-strong backdrop:bg-black/60"
        aria-label={open?.title ?? "画像"}
      >
        {open && (
          <div className="flex max-h-[95vh] flex-col">
            <div className="flex items-center gap-2 border-b border-line p-3">
              <Badge tone={KIND_TONE[open.kind]}>{kindLabel(open.kind)}</Badge>
              <span className="min-w-0 flex-1 truncate font-medium">{open.title}</span>
              <a href={materialUrl(requestId, run.id, open.id)} target="_blank" rel="noreferrer" className={buttonCls("secondary")}>
                画像を開く
              </a>
              <Button autoFocus onClick={() => dialog.current?.close()}>
                閉じる
              </Button>
            </div>
            <div className="overflow-auto bg-page p-3">
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
    <div className="space-y-1 rounded-md bg-page p-3 text-base">
      <p className="font-medium">この run に固定した添付（Codex に渡したもの）</p>
      <ul className="space-y-1.5">
        {list.map((a) => {
          const x = a.extract;
          return (
            <li key={a.id} className="break-words">
              <span className="text-fg-4">{ATTACHMENT_FORMATS[a.format]}</span> {a.name}
              {a.description ? ` — ${a.description}` : ""}{" "}
              <a href={fixedAttachmentUrl(requestId, run.id, a.id)} className="text-accent underline">
                原本
              </a>
              {a.format === "xlsx" && (
                <span className="block text-fg-4">
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
                      <a href={fixedAttachmentUrl(requestId, run.id, a.id, true)} target="_blank" rel="noreferrer" className="text-accent underline">
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
