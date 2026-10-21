import { useEffect, useRef, useState } from "react";
import { compareMilestoneIds } from "../../../shared/milestoneOrder.ts";
import type { Milestone } from "../../../shared/types.ts";
import { api, saveErrorText } from "../../lib/api.ts";
import { useAppCtx } from "../../lib/appCtx.ts";
import { useUnsaved } from "../../lib/unsaved.ts";
import { Button, cx, inputCls } from "../ui.tsx";

/** 編集中の1行。orig は取り込んだときの ID（足した行には無い）。使用中・ノートありの判定は orig で見る */
interface Row {
  key: number;
  orig?: string;
  m: Milestone;
}

let nextKey = 0;
const rowsOf = (ms: readonly Milestone[]): Row[] => ms.map((m) => ({ key: nextKey++, orig: m.id, m }));
/** 行の key を ID のバージョンの降順に（shared/milestoneOrder.ts） */
const orderOf = (rows: readonly Row[]): number[] => [...rows].sort((a, b) => compareMilestoneIds(a.m.id, b.m.id)).map((r) => r.key);

/**
 * マイルストーンの追加・変更・削除とリリース済み（リリースノートの「マイルストーン」タブ）。保存は milestones だけを送る
 * （プロジェクトの基本は設定の画面が別に保存する）。消す・ID を変える規則はサーバ（requestOps.ts の checkMilestoneRemoval）のもので、
 * 画面は要望・ノートのある行の ID と削除を止めて理由を出すだけ。
 *
 *   - 行は取り込んだときに ID の降順に並べ、編集の間は動かさない（ID を書き換えても動かない。足した行は最後）。保存する順
 *     （project.yaml）は行の元の順のままで、表示のために並べ替えない。保存して取り込み直すと降順に並べ直す
 *   - 外（CLI・ほかの画面・エディタ）で変わったら、編集中でなければ取り込む。編集中は入力を残して知らせ、読み直しを選べる
 *   - 保存してもノートの本文・要望・タスクは変えない
 */
export function MilestoneEditor({ noteIds, unknownNotes, onDirtyChange }: { noteIds: ReadonlySet<string>; unknownNotes: readonly string[]; onDirtyChange?: (dirty: boolean) => void }) {
  const ctx = useAppCtx();
  const saved = ctx.info.project.milestones;
  const [rows, setRows] = useState<Row[]>(() => rowsOf(saved));
  const [order, setOrder] = useState<number[]>(() => orderOf(rows));
  /** 編集を始めたときのマイルストーン（編集中に外で変わったかを見る） */
  const [base, setBase] = useState<readonly Milestone[]>(saved);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const added = useRef<HTMLInputElement | null>(null);
  const focusAdded = useRef(false);

  const reset = () => {
    const r = rowsOf(saved);
    setRows(r);
    setOrder(orderOf(r));
    setBase(saved);
    setDirty(false);
  };
  // 外で変わったら、編集中でなければ取り込む（保存の後もここで降順に並べ直す）
  useEffect(() => {
    if (dirty || JSON.stringify(saved) === JSON.stringify(base)) return;
    const r = rowsOf(saved);
    setRows(r);
    setOrder(orderOf(r));
    setBase(saved);
  }, [saved, base, dirty]);
  const changedElsewhere = dirty && JSON.stringify(saved) !== JSON.stringify(base);

  useUnsaved(dirty);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (!focusAdded.current) return;
    focusAdded.current = false;
    added.current?.focus();
  }, [order]);

  const edit = (next: Row[]) => {
    setRows(next);
    setDirty(true);
    setMsg(null);
  };
  const update = (key: number, patch: Partial<Milestone>) => edit(rows.map((r) => (r.key === key ? { ...r, m: { ...r.m, ...patch } } : r)));
  const remove = (key: number) => {
    edit(rows.filter((r) => r.key !== key));
    setOrder(order.filter((k) => k !== key));
  };
  const add = () => {
    const key = nextKey++;
    edit([...rows, { key, m: { id: "", title: "" } }]);
    setOrder([...order, key]);
    focusAdded.current = true;
  };

  async function save() {
    setBusy(true);
    try {
      await api.saveProject({ milestones: rows.map((r) => r.m) });
      setDirty(false);
      setMsg({ ok: true, text: "保存しました" });
      ctx.reload();
    } catch (e) {
      // 入力は残す（直して保存し直せる）
      setMsg({ ok: false, text: saveErrorText(e) });
    } finally {
      setBusy(false);
    }
  }

  /** そのマイルストーンに入っている要望の数 */
  const inMilestone = (id: string) => ctx.requests.filter((p) => p.request.milestone === id).length;
  /** 元の ID を変えられない・消せない理由（要望が使っている・ノートがある） */
  const lockOf = (r: Row): string | null => {
    if (r.orig === undefined) return null;
    const n = inMilestone(r.orig);
    if (n) return `要望 ${n} 件が使っているので、ID の変更と削除はできません（要望のマイルストーンを外してから）`;
    if (noteIds.has(r.orig)) return "リリースノートがあるので、ID の変更と削除はできません";
    return null;
  };
  const byKey = new Map(rows.map((r) => [r.key, r]));

  return (
    <div className="min-w-0 space-y-4">
      <p className="text-slate-500 dark:text-slate-400">
        複数の要望をまとめてリリースする単位です。要望の概要でマイルストーンを選ぶと、進捗画面でまとめて表示されます。リリースが終わったら「リリース済み」に
        チェックを付けて保存します（ノートの本文や要望の状態は変わりません）。
      </p>
      {!rows.length && <p className="rounded-md bg-slate-50 p-3 dark:bg-slate-900">マイルストーンがありません。「＋ マイルストーンを追加」で最初の1件を作れます。</p>}
      <ul className="space-y-3" aria-label="マイルストーンの一覧">
        {order.map((key) => {
          const r = byKey.get(key);
          if (!r) return null;
          const lock = lockOf(r);
          const count = inMilestone(r.orig ?? r.m.id);
          return (
            <li key={key} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
              <input
                ref={r.orig === undefined && key === order[order.length - 1] ? added : undefined}
                aria-label="ID"
                className={cx(inputCls, "!w-32 font-mono", lock && "bg-slate-50 text-slate-500 dark:bg-slate-800")}
                value={r.m.id}
                placeholder="v0.2"
                readOnly={!!lock}
                title={lock ?? undefined}
                onChange={(e) => update(key, { id: e.target.value })}
              />
              <input aria-label="名前" className={cx(inputCls, "!w-auto min-w-40 flex-1")} value={r.m.title} placeholder="名前" onChange={(e) => update(key, { title: e.target.value })} />
              <input aria-label="期限" type="date" className={`${inputCls} !w-44 shrink-0`} value={r.m.due ?? ""} onChange={(e) => update(key, { due: e.target.value || undefined })} />
              <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <input type="checkbox" checked={!!r.m.done} onChange={(e) => update(key, { done: e.target.checked || undefined })} />
                リリース済み
              </label>
              <span className="w-16 shrink-0 text-right text-sm text-slate-400">要望 {count}</span>
              <Button variant="ghost" disabled={!!lock} title={lock ?? undefined} onClick={() => remove(key)}>
                削除
              </Button>
              {lock && <p className="w-full text-sm text-slate-500 dark:text-slate-400">{lock}</p>}
            </li>
          );
        })}
      </ul>
      <Button onClick={add}>＋ マイルストーンを追加</Button>
      {unknownNotes.length > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          ⚠ project.yaml に無いマイルストーンのノート: {unknownNotes.join(", ")}（「リリースノート」タブで読めます。同じ ID のマイルストーンを足すと定義に戻ります）
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          保存
        </Button>
        <Button variant="ghost" disabled={!dirty || busy} onClick={() => (reset(), setMsg(null))}>
          元に戻す
        </Button>
        {msg && (
          <span role={msg.ok ? "status" : "alert"} className={cx(msg.ok ? "text-emerald-600" : "text-rose-600")}>
            {msg.ok ? msg.text : `保存できませんでした: ${msg.text}`}
          </span>
        )}
        {dirty && !msg && !changedElsewhere && <span className="text-slate-500">未保存の変更があります</span>}
      </div>
      {changedElsewhere && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-md bg-amber-50 p-3 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          編集中にマイルストーンが他で変わりました。保存するとこの画面の内容で上書きします。
          <Button variant="ghost" onClick={() => (reset(), setMsg(null))}>
            入力を捨てて最新を読み直す
          </Button>
        </div>
      )}
    </div>
  );
}
