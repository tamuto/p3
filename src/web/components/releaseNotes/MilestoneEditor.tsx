import { useEffect, useRef, useState } from "react";
import { MILESTONE_GOAL_LIMITS, nextGoalId } from "../../../shared/milestoneGoals.ts";
import { compareMilestoneIds } from "../../../shared/milestoneOrder.ts";
import type { Milestone, MilestoneGoal } from "../../../shared/types.ts";
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
 *   - 保存は編集を始めたときの版（milestonesVersion）を付けて送る。その後に外で変わっていればサーバが断り（409）、入力は残す
 *   - 行の「目的・予定機能」を開くと、目的（複数行）と予定している機能・目標を編集できる（リリース済みでも変えられる）。予定機能の
 *     ID（G1, G2, ...）は足したときに振り、並べ替え・文言の変更で振り直さない。保存は全項目を送る（空なら消す）
 *   - 保存してもノートの本文・要望・タスクは変えない
 */
export function MilestoneEditor({
  noteIds,
  reviewIds = new Set(),
  unknownNotes,
  onDirtyChange,
}: {
  noteIds: ReadonlySet<string>;
  /** レビューの履歴のあるマイルストーン（ID の変更・削除はできない） */
  reviewIds?: ReadonlySet<string>;
  unknownNotes: readonly string[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const ctx = useAppCtx();
  const saved = ctx.info.project.milestones;
  const savedVersion = ctx.info.milestonesVersion;
  const [rows, setRows] = useState<Row[]>(() => rowsOf(saved));
  const [order, setOrder] = useState<number[]>(() => orderOf(rows));
  /** 編集を始めたときのマイルストーン（編集中に外で変わったかを見る） */
  const [base, setBase] = useState<readonly Milestone[]>(saved);
  /** base の版（保存のときに送る） */
  const [baseVersion, setBaseVersion] = useState(savedVersion);
  /** 目的・予定機能を開いている行の key */
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const added = useRef<HTMLInputElement | null>(null);
  const focusAdded = useRef(false);

  /** 行を作り直すとき、開いていた行（元の ID で見る）を開いたままにする */
  const keepOpen = (next: readonly Row[]) => {
    const ids = new Set(rows.filter((r) => open.has(r.key)).map((r) => r.orig ?? r.m.id));
    setOpen(new Set(next.filter((r) => ids.has(r.m.id)).map((r) => r.key)));
  };
  const reset = () => {
    const r = rowsOf(saved);
    keepOpen(r);
    setRows(r);
    setOrder(orderOf(r));
    setBase(saved);
    setBaseVersion(savedVersion);
    setDirty(false);
  };
  // 外で変わったら、編集中でなければ取り込む（保存の後もここで降順に並べ直す）
  useEffect(() => {
    if (dirty || JSON.stringify(saved) === JSON.stringify(base)) return;
    const r = rowsOf(saved);
    keepOpen(r);
    setRows(r);
    setOrder(orderOf(r));
    setBase(saved);
    setBaseVersion(savedVersion);
    // keepOpen は今の行と開いている行を読むだけ（取り込みのきっかけにしない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, savedVersion, base, dirty]);
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
  const toggle = (key: number) => setOpen((o) => (o.has(key) ? new Set([...o].filter((k) => k !== key)) : new Set([...o, key])));
  const add = () => {
    const key = nextKey++;
    edit([...rows, { key, m: { id: "", title: "" } }]);
    setOrder([...order, key]);
    focusAdded.current = true;
  };

  async function save() {
    setBusy(true);
    try {
      // 目的・予定機能も必ず送る（空は消す意味。キーを省くとサーバは今の値を残す）
      await api.saveProject({
        milestones: rows.map((r) => ({ ...r.m, purpose: r.m.purpose ?? "", goals: r.m.goals ?? [] })),
        milestonesVersion: baseVersion,
      });
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
    if (reviewIds.has(r.orig)) return "レビューの履歴があるので、ID の変更と削除はできません";
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
              <div className="w-full">
                <button
                  type="button"
                  className="text-sm text-slate-600 underline-offset-2 hover:underline dark:text-slate-300"
                  aria-expanded={open.has(key)}
                  aria-controls={`ms-goals-${key}`}
                  onClick={() => toggle(key)}
                >
                  {open.has(key) ? "▾" : "▸"} 目的・予定機能
                  <span className="ml-2 text-slate-400">{goalSummary(r.m)}</span>
                </button>
                {open.has(key) && (
                  <GoalsEditor
                    id={`ms-goals-${key}`}
                    m={r.m}
                    used={[...(base.find((b) => b.id === r.orig)?.goals ?? []), ...(r.m.goals ?? [])]}
                    onChange={(patch) => update(key, patch)}
                  />
                )}
              </div>
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
          編集中にマイルストーンが他で変わりました。このまま保存すると断られます（入力は残ります）。必要な入力を控えてから、最新を読み直してください。
          <Button variant="ghost" onClick={() => (reset(), setMsg(null))}>
            入力を捨てて最新を読み直す
          </Button>
        </div>
      )}
    </div>
  );
}

/** 閉じた行に出す、目的・予定機能の有無 */
function goalSummary(m: Milestone): string {
  const parts = [m.purpose ? "目的あり" : "目的なし", m.goals?.length ? `予定機能 ${m.goals.length} 件` : "予定機能なし"];
  return parts.join(" · ");
}

/**
 * 1つのマイルストーンの目的と予定している機能・目標の編集。used は ID を振るときに避ける ID（取り込んだときの予定機能と今の予定機能。
 * 消した直後に足しても同じ ID を使わない）
 */
function GoalsEditor({ id, m, used, onChange }: { id: string; m: Milestone; used: readonly MilestoneGoal[]; onChange: (patch: Partial<Milestone>) => void }) {
  const goals = m.goals ?? [];
  const setGoals = (next: MilestoneGoal[]) => onChange({ goals: next });
  const addRef = useRef<HTMLInputElement | null>(null);
  const focusAdded = useRef(false);
  useEffect(() => {
    if (!focusAdded.current) return;
    focusAdded.current = false;
    addRef.current?.focus();
  }, [goals.length]);
  const full = goals.length >= MILESTONE_GOAL_LIMITS.goals;
  return (
    <div id={id} className="mt-2 space-y-3 rounded-md bg-slate-50 p-3 dark:bg-slate-900">
      <label className="block">
        <span className="text-sm font-medium">目的</span>
        <textarea
          rows={4}
          className={cx(inputCls, "mt-1")}
          value={m.purpose ?? ""}
          maxLength={MILESTONE_GOAL_LIMITS.purpose}
          placeholder="このマイルストーンで目指すこと・解決したいこと"
          onChange={(e) => onChange({ purpose: e.target.value })}
        />
      </label>
      <div role="group" aria-label="予定している機能・目標">
        <p className="text-sm font-medium">予定している機能・目標</p>
        {!goals.length && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">まだありません。</p>}
        <div className="mt-1 space-y-2">
          {goals.map((g, i) => (
            <div key={g.id} className="flex items-center gap-2">
              <span className="w-10 shrink-0 font-mono text-sm text-slate-500">{g.id}</span>
              <input
                ref={i === goals.length - 1 ? addRef : undefined}
                aria-label={`予定機能 ${g.id}`}
                className={cx(inputCls, "!w-auto min-w-0 flex-1")}
                value={g.text}
                maxLength={MILESTONE_GOAL_LIMITS.goalText}
                onChange={(e) => setGoals(goals.map((x) => (x.id === g.id ? { ...x, text: e.target.value } : x)))}
              />
              <Button variant="ghost" aria-label={`予定機能 ${g.id} を削除`} onClick={() => setGoals(goals.filter((x) => x.id !== g.id))}>
                削除
              </Button>
            </div>
          ))}
        </div>
        <Button
          className="mt-2"
          disabled={full}
          title={full ? `予定機能は ${MILESTONE_GOAL_LIMITS.goals} 件までです` : undefined}
          onClick={() => {
            focusAdded.current = true;
            setGoals([...goals, { id: nextGoalId(used), text: "" }]);
          }}
        >
          ＋ 予定機能を追加
        </Button>
      </div>
    </div>
  );
}
