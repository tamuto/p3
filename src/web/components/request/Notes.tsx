import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { type PreflightRun, type Request } from "../../../shared/types.ts";
import { Badge, Button, inputCls, Section } from "../ui.tsx";
import { api, type NotesInfo } from "../../lib/api.ts";
import { nextRunLabel, notesPanelState, submitNote } from "../../lib/notes.ts";
import { type AppCtx } from "../../lib/appCtx.ts";

/** Preflight へのメモ欄 */

export const NOTE_INPUT_ID = "preflight-note";

/** 確認事項からメモ欄へ（入力欄にカーソルを置く） */
export function focusNoteInput(e: { preventDefault: () => void }) {
  const el = document.getElementById(NOTE_INPUT_ID) as HTMLTextAreaElement | null;
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

/**
 * Preflight へのメモ（確認事項への回答・方針の変更）。保存すると次の Preflight に前回の結果と一緒に渡す。
 * 引き継ぎ元はいつも直近の run（過去の run を表示していても変わらない）なので、それを先に見せる。
 * 評価の下に置く（評価を読んでから書くため）。まだ一度も実行していなければ出さない。入力中の文は親が持つ。
 */
export function Notes({
  ctx,
  request,
  gone,
  hasHistory,
  running,
  engineOk,
  draft,
  onDraft,
  onStarted,
  blocked,
}: {
  ctx: AppCtx;
  request: Request;
  /** 実行を止める理由（未保存のタイトル・本文）。メモだけの保存は止めない */
  blocked: string | null;
  hasHistory: boolean;
  running: boolean;
  engineOk: boolean;
  draft: string;
  onDraft: Dispatch<SetStateAction<string>>;
  onStarted: (r: PreflightRun) => void;
  /** 要望が外で消された（入力は残し、保存はしない） */
  gone: boolean;
}) {
  const [info, setInfo] = useState<NotesInfo>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const pending = info?.notes.filter((n) => n.pending).length ?? 0;
  const st = notesPanelState({ hasHistory, running, engineOk, draft, busy, pending });

  useEffect(() => {
    // 取れなければ前の一覧のまま（入力中のメモには触らない）
    void api.notes(request.id).then(setInfo, () => undefined);
  }, [request.id, ctx.tick]);

  async function submit(run: boolean) {
    if (busy) return;
    if (gone) return setMessage({ error: true, text: "この要望は見つからないので保存しません。入力は残してあります" });
    setBusy(true);
    setMessage(null);
    try {
      const sent = draft;
      const r = await submitNote(api, request.id, sent, run);
      // 保存できたら入力を消す（再試行で同じメモを重ねて保存しない）。保存の前に失敗したら入力は残す。
      // 送った後に書き足していれば、その文は消さない
      onDraft((cur) => (cur === sent ? "" : cur));
      if (r.kind === "started") setMessage({ error: false, text: "メモを保存して、Preflight を始めました" });
      else if (r.kind === "not-started")
        setMessage({ error: true, text: `メモ ${r.note.id} は保存済みです（書き直しは不要）。Preflight を始められませんでした: ${r.error}` });
      else setMessage({ error: false, text: `メモ ${r.note.id} を保存しました。${running ? "実行中の評価ではなく、" : ""}次の Preflight に渡します` });
      if (r.kind === "started") onStarted(r.run);
      setInfo(await api.notes(request.id));
    } catch (e) {
      setMessage({ error: true, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // まだ実行しておらず、保存済みのメモも無ければ何も出さない
  if (st.mode === "intro" && !info?.notes.length && !info?.invalid.length) return null;

  return (
    <Section title="メモ（確認事項への回答・方針の変更）" aside={<span className="font-mono text-sm text-slate-400">requests/{request.id}/notes/*.md</span>}>
      <div className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        {info && (
          <>
            {info.notes.length > 0 && (
              <ul className="space-y-2">
                {info.notes.map((n) => (
                  <li key={n.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
                      <Badge tone={n.pending ? "amber" : "slate"}>{n.pending ? "次に渡す" : "渡し済み"}</Badge>
                      <span className="font-mono">{n.id}</span>
                      <span>{n.createdBy ?? "不明"}</span>
                      <span>{n.createdAt.slice(0, 16).replace("T", " ")}</span>
                    </div>
                    <p className="break-words whitespace-pre-wrap">{n.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {info.invalid.map((i) => (
              <p key={i.file} className="text-sm text-rose-600">
                読めないメモ（渡しません）: {i.file} — {i.error}
              </p>
            ))}
            {st.mode === "input" && <p className="text-sm text-slate-600 dark:text-slate-400">{nextRunLabel(info)}</p>}
          </>
        )}
        {st.hint && <p className="text-sm text-slate-600 dark:text-slate-400">{st.hint}</p>}
        {st.mode === "input" && (
          <>
            <textarea
              id={NOTE_INPUT_ID}
              rows={3}
              className={inputCls}
              value={draft}
              aria-label="Preflight へのメモ"
              placeholder="確認事項への回答や、方針の変更を書きます（例: 対象は CLI だけ。Web は不要）"
              onChange={(e) => onDraft(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={!st.canSaveAndRun || gone || !!blocked} title={blocked ?? undefined} onClick={() => void submit(true)}>
                保存して再実行
              </Button>
              <Button disabled={!st.canSaveOnly || gone} onClick={() => void submit(false)}>
                {running ? "メモだけ保存（次回に渡す）" : "メモだけ保存"}
              </Button>
            </div>
          </>
        )}
        {message && <p className={message.error ? "text-rose-600" : "text-emerald-700 dark:text-emerald-400"}>{message.text}</p>}
      </div>
    </Section>
  );
}

