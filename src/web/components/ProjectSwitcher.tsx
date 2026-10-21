import { useEffect, useRef, useState, type ReactNode } from "react";
import { PROJECT_CHANGED_EVENT } from "../lib/api.ts";
import { CHOOSER_URL, currentScope, projectPath } from "../lib/scope.ts";
import { hasUnsaved, savesInFlight, savesSettled } from "../lib/unsaved.ts";
import { fetchProjects, type ProjectListing } from "./ProjectChooser.tsx";
import { Button, buttonCls } from "./ui.tsx";

/** 一覧へ（プロジェクトを選ぶ画面。登録が1つでも一覧を出す） */
const CHOOSER = CHOOSER_URL;

/**
 * プロジェクトを跨ぐ serve の、今のプロジェクトの表示と切り替え。選ぶ欄（picker）はヘッダーのロゴの横に、
 * 保存待ち・登録が変わった知らせ（notices）はヘッダーの下の全幅に置く（状態は1つ。置き場所だけ分ける）。
 * 通常の serve では何も出さない（どちらも null）。
 * 切り替えはページごと移る（前のプロジェクトの取得・通知を持ち込まない）。保存していない入力があれば確かめ、
 * 送っている保存は結果が決まるまで待つ。実行中の Preflight・生成は元のプロジェクトで続く。
 * 一覧は選ぶ欄を開いたときに読み直す
 */
export function useProjectSwitcher(): { picker: ReactNode; notices: ReactNode } {
  const scope = currentScope();
  const enabled = scope.mode === "all-projects";
  const current = scope.mode === "all-projects" ? scope.project : "";
  const [listing, setListing] = useState<ProjectListing | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  // 確かめている間の切り替え先。描き直す前に押されても取りこぼさないよう、押したときは ref から読む
  const targetRef = useRef<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [changed, setChanged] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const select = useRef<HTMLSelectElement>(null);

  const load = () => void fetchProjects().then(setListing, () => undefined);
  useEffect(() => {
    if (enabled) load();
  }, [enabled]);
  // 登録が変わった（外した・付け直した・データのフォルダを変えた）と API が断った
  useEffect(() => {
    const on = () => setChanged(true);
    window.addEventListener(PROJECT_CHANGED_EVENT, on);
    return () => window.removeEventListener(PROJECT_CHANGED_EVENT, on);
  }, []);

  if (!enabled) return { picker: null, notices: null };

  const go = async (to: string) => {
    if (savesInFlight()) {
      setWaiting(true);
      await savesSettled();
    }
    location.assign(to === CHOOSER ? CHOOSER : `${projectPath(to)}/`);
  };
  const choose = (to: string) => {
    if (to === current) return;
    if (hasUnsaved()) {
      targetRef.current = to;
      setTarget(to);
      dialog.current?.showModal();
      return;
    }
    void go(to);
  };

  const names = listing?.projects.map((p) => p.name) ?? [current];
  const picker = (
    <>
      {/* 長い名前は欄の幅で切る（狭い画面でも隠さない。全体は title と開いたプルダウンで読める） */}
      <select
        ref={select}
        aria-label="プロジェクト"
        value={current}
        onFocus={load}
        onChange={(e) => choose(e.target.value)}
        disabled={waiting}
        title={`${current}（切り替えても、実行中の Preflight・生成は元のプロジェクトで続きます。戻ると状態を読み直します）`}
        className="max-w-36 min-w-0 truncate rounded-md bg-white px-2 py-1 font-medium ring-1 ring-slate-300 sm:max-w-64 dark:bg-slate-900 dark:ring-slate-700"
      >
        {(names.includes(current) ? names : [current, ...names]).map((n) => (
          <option key={n} value={n} disabled={listing?.projects.find((p) => p.name === n)?.state === "error"}>
            {n}
          </option>
        ))}
        <option value={CHOOSER}>プロジェクトの一覧…</option>
      </select>

      <dialog
        ref={dialog}
        aria-labelledby="switch-title"
        onClose={() => {
          // close は閉じたあと遅れて届く。そのあいだに選び直して開き直していたら、今の確かめを消さない
          if (dialog.current?.open) return;
          setTarget(null);
          targetRef.current = null;
          if (select.current) select.current.value = current;
          select.current?.focus();
        }}
        className="m-auto w-[min(calc(100vw-1rem),480px)] max-w-none rounded-lg bg-white p-0 text-slate-900 backdrop:bg-black/60 dark:bg-slate-900 dark:text-slate-100"
      >
        <div className="space-y-3 p-4">
          <h2 id="switch-title" className="font-semibold">
            保存していない入力があります
          </h2>
          <p className="text-sm">
            「{target === CHOOSER ? "プロジェクトの一覧" : target}」へ切り替えると、このプロジェクトで保存していない入力は失われます（どこにも送りません）。
            実行中の Preflight・生成は、このプロジェクトで続きます。
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button autoFocus onClick={() => dialog.current?.close()}>
              このプロジェクトに残る
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const to = targetRef.current;
                dialog.current?.close();
                if (to) void go(to);
              }}
            >
              入力を破棄して切り替える
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );

  const notices = (
    <>
      {waiting && (
        <div role="status" className="bg-slate-50 px-5 py-1.5 text-sm text-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
          保存の完了を待っています…（終わったら切り替えます）
        </div>
      )}
      {changed && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-rose-50 px-5 py-2 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
          <span className="min-w-0 break-words">
            プロジェクト「{current}」の登録が変わりました（外した・付け直した・データのフォルダを変えた）。この画面からは保存しません（入力は送っていません）。一覧から選び直してください。
          </span>
          <a href={CHOOSER} className={buttonCls("ghost", "underline")}>
            プロジェクトの一覧へ
          </a>
        </div>
      )}
    </>
  );

  return { picker, notices };
}
