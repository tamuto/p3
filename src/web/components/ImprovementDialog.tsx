import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ImprovementSource } from "../../shared/qualityImprovement.ts";
import { api, ApiError } from "../lib/api.ts";
import { Button, cx, Field, inputCls } from "./ui.tsx";

type Preview = Awaited<ReturnType<typeof api.improvementPreview>>;

const KIND: Record<string, string> = { unset: "未設定", invalid: "読めない設定", violated: "違反", undetermined: "判断できない", exempt: "理由つきの除外" };

/**
 * 「改善要望の案を確認」ボタンと、品質の診断 → 原稿の確認・編集 → 明示の登録のダイアログ（core/qualityImprovement.ts）。
 * 診断と原稿の表示・編集だけでは何も作らない。登録の直前に診断の版を照らし、変わっていれば確かめ直してもらう。開いている登録先があれば
 * 案内して作らない。閉じた要望で扱った不足は、作り直すことを明示させる。未設定のまま続けるなら閉じるだけでよい
 */
export function ImprovementButton({ source, label = "改善要望の案を確認" }: { source: ImprovementSource; label?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        ref={opener}
        type="button"
        className="text-sm"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
          dialog.current?.showModal();
        }}
      >
        {label}
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="improvement-title"
        onClose={() => {
          setOpen(false);
          opener.current?.focus();
        }}
        className="m-auto max-h-[90vh] w-[min(calc(100vw-1rem),760px)] max-w-none rounded-lg bg-white p-0 text-slate-900 backdrop:bg-black/60 dark:bg-slate-900 dark:text-slate-100"
      >
        {open && <ImprovementForm source={source} onClose={() => dialog.current?.close()} />}
      </dialog>
    </>
  );
}

function ImprovementForm({ source, onClose }: { source: ImprovementSource; onClose: () => void }) {
  const [p, setP] = useState<Preview>();
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; request?: string } | null>(null);

  const load = async (keys?: string[]) => {
    try {
      const r = await api.improvementPreview(source, keys);
      setP(r);
      setPicked(r.picked);
      if (!edited || !keys) {
        setTitle(r.draft?.title ?? "");
        setBody(r.draft?.body ?? "");
        setEdited(false);
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  useEffect(() => {
    void load();
    // 開いたときだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (key: string, on: boolean) => {
    const next = on ? [...picked, key] : picked.filter((k) => k !== key);
    setPicked(next);
    // 原稿を直していなければ、選び直した不足で作り直す
    if (!edited && next.length) void load(next);
  };

  async function register() {
    if (!p) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.registerImprovement({ source, keys: picked, title, body, hash: p.hash, ...(reopen ? { reopenClosed: true } : {}) });
      setMsg({ ok: true, text: `要望を登録しました: ${r.request.id}`, request: r.request.id });
      void load(picked);
    } catch (e) {
      const b = e instanceof ApiError ? (e.body as { code?: string; existing?: { request: string } } | null) : null;
      if (b?.code === "diagnosis_changed") {
        setMsg({ ok: false, text: "原稿を作った後で診断が変わりました。最新の診断を読み直しました。確かめてからもう一度登録してください" });
        void load();
      } else setMsg({ ok: false, text: (e as Error).message, ...(b?.existing ? { request: b.existing.request } : {}) });
    } finally {
      setBusy(false);
    }
  }

  const registered = p ? Object.entries(p.registered).filter(([k]) => picked.includes(k)) : [];
  const closed = registered.filter(([, r]) => r.status === "done" || r.status === "rejected");
  return (
    <div className="flex max-h-[90vh] flex-col">
      <div className="flex items-start gap-3 border-b border-slate-200 p-3 sm:p-4 dark:border-slate-800">
        <h2 id="improvement-title" className="min-w-0 flex-1 font-semibold">
          品質の診断 → 改善要望の原稿の確認・編集 → 明示の登録
        </h2>
        <Button className="shrink-0" onClick={onClose}>
          閉じる
        </Button>
      </div>
      <div className="min-h-0 space-y-4 overflow-y-auto p-3 sm:p-4">
        {!p ? (
          <p className="text-slate-500">診断しています…</p>
        ) : (
          <>
            <section aria-label="品質の不足" className="space-y-1">
              <p className="font-medium">不足（選んだものだけを原稿にします。除外は既定で選びません）</p>
              {!p.findings.length && <p className="text-sm text-slate-500">不足はありません。</p>}
              <ul className="space-y-1">
                {p.findings.map((f) => (
                  <li key={f.key} className="flex min-w-0 items-start gap-2 text-sm">
                    <input type="checkbox" aria-label={`${f.key} を選ぶ`} checked={picked.includes(f.key)} disabled={busy} onChange={(e) => toggle(f.key, e.target.checked)} />
                    <span className="min-w-0 break-words">
                      <span className="font-mono">{f.quality ?? "設定"}</span> {KIND[f.kind]}（{f.target}・版 {f.version || "なし"}）: {f.reason}
                      {p.registered[f.key] && (
                        <span className="block text-slate-500">
                          登録済み: {p.registered[f.key].request}（{p.registered[f.key].title ?? ""}・{p.registered[f.key].status ?? "?"}）
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {p.notes.map((n) => (
                <p key={n} className="text-sm text-slate-500">
                  ※ {n}
                </p>
              ))}
            </section>
            {picked.length > 0 && (
              <>
                <Field label="要望の題">
                  <input className={inputCls} value={title} disabled={busy} onChange={(e) => (setTitle(e.target.value), setEdited(true))} />
                </Field>
                <Field label="要望の原稿">
                  <textarea rows={12} className={`${inputCls} font-mono text-sm`} value={body} disabled={busy} onChange={(e) => (setBody(e.target.value), setEdited(true))} />
                </Field>
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  表示・編集だけでは要望を作りません。登録の前に診断の版を照らし、変わっていれば確かめ直してもらいます。P3 は検査を実行していません。
                </p>
                {closed.length > 0 && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={reopen} onChange={(e) => setReopen(e.target.checked)} />
                    閉じた要望（{closed.map(([, r]) => r.request).join(", ")}）で扱った不足から、要望を作り直す
                  </label>
                )}
              </>
            )}
          </>
        )}
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={cx("text-sm break-words", msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600")}>
            {msg.text}
            {msg.request && (
              <Link to="/requests/$requestId" params={{ requestId: msg.request }} className="ml-2 underline">
                {msg.ok ? "要望を開く" : "既存の要望を開く"}
              </Link>
            )}
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 p-3 sm:p-4 dark:border-slate-800">
        <Button onClick={onClose}>閉じる（登録しない）</Button>
        <Button variant="primary" disabled={busy || !p || !picked.length || !title.trim()} onClick={() => void register()}>
          {busy ? "登録中…" : "要望を登録"}
        </Button>
      </div>
    </div>
  );
}
