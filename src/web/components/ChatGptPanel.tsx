import { useEffect, useState } from "react";
import { api, type ChatGptState } from "../lib/api.ts";
import { CHATGPT_UI, chatgptView, firstNoticeSeen, markFirstNoticeSeen } from "../lib/chatgpt.ts";
import { Badge, Button, inputCls, Section } from "./ui.tsx";

/**
 * このマシン・この人の ChatGPT プランの接続（プロジェクトの設定とは別。個人設定の chatgpt.json）。
 * サインインの待ち受けは serve が行う。トークンは画面に来ない。設計: docs/chatgpt-sign-in.md
 */
export function ChatGptPanel({ tick }: { tick: number }) {
  const [s, setS] = useState<ChatGptState>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const [notice, setNotice] = useState(false);

  const load = () =>
    api.chatgpt().then(
      (x) => {
        setS(x);
        if (x.connected && x.planAllowed && !firstNoticeSeen()) setNotice(true);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => void load(), [tick]);
  // 待っている間は、変更通知が届かない場合に備えて読み直す
  useEffect(() => {
    if (!s?.pending) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [s?.pending]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function signIn() {
    // ポップアップを止められないよう、クリックの中で先に開いてから URL を入れる
    const win = window.open("", "_blank");
    await act(async () => {
      const r = await api.chatgptLogin();
      if (win) win.location.href = r.url;
      else window.open(r.url, "_blank");
    });
  }

  const view = s ? chatgptView(s) : undefined;
  return (
    <Section title="このマシンの接続（個人）">
      <div className="space-y-3 rounded-lg bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-lg font-semibold">{CHATGPT_UI.heading}</h3>
          {view === "connected" && <Badge tone="emerald">{CHATGPT_UI.active}</Badge>}
        </div>
        <p className="text-slate-600 dark:text-slate-400">
          Preflight の Codex を、あなたの ChatGPT プランに含まれる使用量で動かします（P3 の料金ではありません）。接続はこのマシンだけのもので、
          プロジェクトのデータには保存しません。
        </p>

        {notice && (
          <div className="space-y-2 rounded-md bg-sky-50 p-3 dark:bg-sky-950">
            <p className="font-medium">{CHATGPT_UI.firstTitle}</p>
            <p className="text-sm">Preflight の評価はあなたの ChatGPT プランの使用量を使います。使用量は ChatGPT の設定で確かめられます。</p>
            <Button onClick={() => (markFirstNoticeSeen(), setNotice(false))}>{CHATGPT_UI.gotIt}</Button>
          </div>
        )}

        {view === "connected" && (
          <div className="space-y-2">
            <p>
              <span className="font-medium">{s!.email ?? "サインイン済み"}</span>
              <span className="ml-2 text-sm text-slate-500">トークンは使うときに更新します</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <a className="text-indigo-600 underline" href={CHATGPT_UI.usageUrl} target="_blank" rel="noreferrer">
                {CHATGPT_UI.manageUsage}
              </a>
              <Button disabled={busy} onClick={() => void act(() => api.chatgptLogout())}>
                接続を解除
              </Button>
            </div>
          </div>
        )}

        {view === "no_plan" && (
          <p className="text-amber-700 dark:text-amber-400">
            {s!.email} でサインインしましたが、ChatGPT プランの利用が許可されていません。もう一度サインインして、プランの利用に同意してください。
          </p>
        )}
        {view === "signin_again" && <p className="text-amber-700 dark:text-amber-400">接続が切れています。サインインし直してください。</p>}

        {(view === "disconnected" || view === "no_plan" || view === "signin_again") && (
          <Button variant="primary" disabled={busy} onClick={() => void signIn()} className="!bg-black !text-white dark:!bg-white dark:!text-black">
            {CHATGPT_UI.button}
          </Button>
        )}

        {view === "pending" && (
          <div className="space-y-2">
            <p>
              ブラウザで ChatGPT にサインインし、プランの利用に同意してください。開かなければ{" "}
              <a className="text-indigo-600 underline" href={s!.pending!.url} target="_blank" rel="noreferrer">
                ここを開いてください
              </a>
              。（{new Date(s!.pending!.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} まで待ちます）
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={busy} onClick={() => void act(() => api.chatgptCancel())}>
                取り消す
              </Button>
            </div>
            <p className="text-sm text-slate-500">
              サインインの後に「接続できません」と表示されたら、そのページのアドレスバーの URL（{s!.pending!.redirectUri}?code=…）を貼ってください:
            </p>
            <div className="flex gap-2">
              <input className={inputCls} value={paste} placeholder="http://127.0.0.1:1455/auth/callback?code=…" onChange={(e) => setPaste(e.target.value)} />
              <Button disabled={busy || !paste.trim()} onClick={() => void act(async () => (await api.chatgptPaste(paste), setPaste("")))}>
                続ける
              </Button>
            </div>
          </div>
        )}

        {s?.lastError && !s.pending && <p className="text-rose-600">直前のサインイン: {s.lastError}</p>}
        {error && <p className="text-rose-600">{error}</p>}
        {s && (
          <p className="text-sm text-slate-500">
            Preflight: {s.engine.ok ? "●" : "✕"} {s.engine.detail}
          </p>
        )}
      </div>
    </Section>
  );
}
