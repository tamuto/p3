import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api.ts";
import { type AppCtx } from "../../lib/appCtx.ts";
import { parentChoices } from "../../lib/progressTree.ts";
import { type RequestData } from "../../lib/requestData.tsx";
import { RequestStatusBadge } from "../RequestStatus.tsx";
import { Button, buttonCls, Field, inputCls, Section } from "../ui.tsx";

/**
 * 要望の親子（docs/architecture.md の「大きい要望の分割」）: 親の指定・付け替え・外す、子の一覧と移動、自分の値と配下の集計、
 * 対応済にできない理由・見送りで対象外の子・完了済の祖先・親子の問題。判定はサーバ（要望の詳細の completion・hierarchyIssues、
 * 進捗の subtree）が返すものを見せるだけで、ここで作り直さない。子に親の管理情報を同期して見せることはしない（作るときに写すだけ）
 */
export function Family({ ctx, data }: { ctx: AppCtx; data: RequestData }) {
  const { request } = data;
  const children = data.children ?? [];
  const ancestors = data.ancestors ?? [];
  const issues = data.hierarchyIssues ?? [];
  const row = ctx.requests.find((p) => p.request.id === request.id);
  const choices = parentChoices(
    ctx.requests.map((p) => p.request),
    request.id,
  );
  // 親の選択は保存するまで下書き（失敗したら入力を残す）
  const [parent, setParent] = useState(request.parent ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setParent(request.parent ?? ""), [request.parent]);
  const dirty = parent !== (request.parent ?? "");

  async function save() {
    if (data.gone) return setError("この要望は見つからないので保存しません");
    setSaving(true);
    try {
      const r = await api.patchRequest(request.id, { parent: parent || null, rev: request.rev });
      setError(null);
      setNote(
        [r.reopenedAncestors?.length ? `対応済だった ${r.reopenedAncestors.join(", ")} を進行中に戻しました（配下に未完了があるため）` : "", ...(r.warnings ?? []).map((w) => w.message)]
          .filter(Boolean)
          .join(" / ") || null,
      );
      data.reload();
      ctx.reload();
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { code?: string } | null)?.code : undefined;
      setError(
        code === "rev_conflict"
          ? "競合: 他で更新されています。選んだ親は残してあります。読み直してからもう一度保存してください"
          : `親を変えられませんでした: ${(e as Error).message}（選んだ親は残してあります）`,
      );
      data.reload();
    } finally {
      setSaving(false);
    }
  }

  const doneAncestors = request.status !== "resolved" && request.status !== "done" && request.status !== "rejected" ? ancestors.filter((a) => a.status === "done") : [];
  const structural = children.length > 0 && data.tasks.length === 0;

  return (
    <Section title="親子">
      <div className="space-y-4 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="親の要望" hint="子にしても、期限・マイルストーン・タグは作るときに写すだけで、その後は別々に変えます">
            <select className={`${inputCls} !w-auto max-w-full min-w-0 sm:min-w-80`} value={parent} disabled={saving || data.gone} onChange={(e) => setParent(e.target.value)}>
              <option value="">（なし）</option>
              {/* 今の親が一覧に無い（アーカイブ・読めない）ときも選んだままにする */}
              {request.parent && !choices.some((c) => c.id === request.parent) && <option value={request.parent}>{request.parent}（一覧にありません）</option>}
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}（{c.id}）
                </option>
              ))}
            </select>
          </Field>
          {dirty && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={saving} onClick={() => void save()}>
                {saving ? "保存中…" : parent ? "親を保存" : "親を外す"}
              </Button>
              <Button disabled={saving} onClick={() => (setParent(request.parent ?? ""), setError(null))}>
                取消
              </Button>
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="break-words text-rose-600">
            {error}
          </p>
        )}
        {note && (
          <p role="status" className="break-words text-sm text-amber-700 dark:text-amber-400">
            {note}
          </p>
        )}
        {issues.map((i) => (
          <p key={`${i.request}-${i.code}`} role="status" className="rounded-md bg-amber-50 px-3 py-2 break-words text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900">
            親子の問題: {i.message}（request.md の parent を直すか、親を選び直してください）
          </p>
        ))}
        {doneAncestors.map((a) => (
          <p key={a.id} role="status" className="rounded-md bg-amber-50 px-3 py-2 break-words text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900">
            祖先の {a.title}（{a.id}）は完了済ですが、この要望はまだ終わっていません。再開するなら、その要望のステータスを「進行中」に戻してください。
          </p>
        ))}

        {children.length > 0 && <ChildList ctx={ctx} data={data} />}

        {(children.length > 0 || ancestors.length > 0) && row && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>
              この要望自身: <strong>{row.done}/{row.total}</strong> タスク完了
            </span>
            {children.length > 0 && (
              <span>
                配下全体（自身を含む）: <strong>{row.subtree.done}/{row.subtree.total}</strong> タスク完了
              </span>
            )}
          </div>
        )}
        {children.length > 0 && (
          <p className="text-sm text-slate-500">全体の集計では各タスクを1回だけ数えます。子のタスクは親のボードには出ません（子の画面で見ます）。</p>
        )}
        {children.length > 0 && data.completion?.blocker && request.status !== "resolved" && request.status !== "done" && (
          <p role="status" className="rounded-md bg-amber-50 px-3 py-2 break-words text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900">
            対応済にできません: {data.completion.blocker}
          </p>
        )}
        {!!data.completion?.excluded.length && (
          <p className="text-sm break-words text-slate-600 dark:text-slate-400">
            見送りの子は完了の判定の対象外です: {data.completion.excluded.join(", ")}
          </p>
        )}
        {structural && (
          <p className="text-sm text-slate-500">
            自分のタスクが無い親です。リリースノートでは「構造の要望」として収録の判定に入り、変更の記録は各子の要望から入ります。
          </p>
        )}
        {!children.length && !ancestors.length && !issues.length && <p className="text-sm text-slate-500">親も子もありません。大きい要望は Preflight の分割の案から子に分けられます。</p>}
      </div>
    </Section>
  );
}

type Child = NonNullable<RequestData["children"]>[number];

/**
 * 子の一覧と表示順の並べ替え。並びはサーバが返す順（親の childOrder。shared/hierarchy.ts の orderSiblings）で、「上へ」「下へ」で
 * 下書きを作り、「順序を保存」で直下の子を全部送る。保存するまで下書きで、失敗・競合でも並べた順を残す（読み直した子に合わせて、
 * 下書きに無い子は後ろに足し、今は子でない ID は落とす）。表示の順で、着手できるかは表さない
 */
function ChildList({ ctx, data }: { ctx: AppCtx; data: RequestData }) {
  const { request } = data;
  const children = data.children ?? [];
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const byId = new Map(children.map((c) => [c.id, c]));
  // 下書きの順（今の子だけ）→ 下書きに無い今の子
  const shown: Child[] = draft ? [...draft.flatMap((id) => byId.get(id) ?? []), ...children.filter((c) => !draft.includes(c.id))] : children;
  const dirty = !!draft && shown.some((c, i) => c.id !== children[i]?.id);

  // 子の並びが下書きと同じになった（保存して読み直した）ら下書きを外す
  if (draft && draft.join(" ") === children.map((c) => c.id).join(" ")) setDraft(null);

  // 動かした行の同じボタンにフォーカスを戻す（端に着いて押せなくなったら反対のボタン）
  useEffect(() => {
    if (!focusKey) return;
    buttons.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  function move(index: number, by: -1 | 1) {
    const ids = shown.map((c) => c.id);
    const [id] = ids.splice(index, 1);
    const to = index + by;
    ids.splice(to, 0, id);
    setDraft(ids);
    setError(null);
    const c = byId.get(id)!;
    setMoved(`${c.title} を ${to + 1} 番目に移しました（保存していません）`);
    const atEdge = (by < 0 && to === 0) || (by > 0 && to === ids.length - 1);
    setFocusKey(`${id}:${atEdge ? (by < 0 ? "down" : "up") : by < 0 ? "up" : "down"}`);
  }

  async function save() {
    if (data.gone) return setError("この要望は見つからないので保存しません");
    setSaving(true);
    try {
      const r = await api.orderChildren(request.id, shown.map((c) => c.id), request.rev);
      // 下書きは、読み直した子の並びが保存した順になったら外す（読み直すまで前の順に戻して見せない）
      setDraft(r.children);
      setError(null);
      setMoved("子の表示順を保存しました");
      data.reload();
      ctx.reload();
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { code?: string } | null)?.code : undefined;
      setError(
        code === "rev_conflict"
          ? "競合: この要望は他で更新されています。並べた順は残してあります。読み直した内容を確かめて、もう一度保存してください"
          : code === "child_order_invalid"
            ? `子が変わりました: ${(e as Error).message}。並べた順は残してあります（新しい子は後ろに足しました）。確かめてもう一度保存してください`
            : `表示順を保存できませんでした: ${(e as Error).message}（並べた順は残してあります）`,
      );
      data.reload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="font-medium">子の要望（{children.length} 件・表示順）</p>
      <p className="text-sm text-slate-500">表示順は着手可能かを判定しません。子の本文にある前提を確認してください。</p>
      <ul className="divide-y divide-slate-200 dark:divide-slate-800" aria-label="子の要望（表示順）">
        {shown.map((c, i) => (
          <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span className="w-6 shrink-0 text-right font-mono text-sm text-slate-500" aria-hidden="true">
              {i + 1}.
            </span>
            <RequestStatusBadge status={c.status} size="sm" />
            <Link to="/requests/$requestId" params={{ requestId: c.id }} className="min-w-0 flex-1 basis-48 font-medium break-words underline">
              {c.title}
            </Link>
            <span className="font-mono text-sm text-slate-500">{c.id}</span>
            <span className="text-sm whitespace-nowrap text-slate-600 dark:text-slate-400">
              自分のタスク {c.tasks.done}/{c.tasks.total}
            </span>
            <Link to="/requests/$requestId/board" params={{ requestId: c.id }} className={buttonCls("ghost", "text-sm underline")}>
              ボード
            </Link>
            {shown.length > 1 && (
              <span className="flex gap-1">
                <Button
                  ref={(el) => void buttons.current.set(`${c.id}:up`, el)}
                  className="px-2 py-0.5 text-sm"
                  aria-label={`${c.title} を上へ`}
                  disabled={saving || data.gone || i === 0}
                  onClick={() => move(i, -1)}
                >
                  上へ
                </Button>
                <Button
                  ref={(el) => void buttons.current.set(`${c.id}:down`, el)}
                  className="px-2 py-0.5 text-sm"
                  aria-label={`${c.title} を下へ`}
                  disabled={saving || data.gone || i === shown.length - 1}
                  onClick={() => move(i, 1)}
                >
                  下へ
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {dirty && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "順序を保存"}
          </Button>
          <Button disabled={saving} onClick={() => (setDraft(null), setError(null), setMoved("並べ替えを取り消しました"))}>
            取消
          </Button>
          <span className="text-sm text-slate-500">保存していない並べ替えがあります</span>
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-rose-600">
          {error}
        </p>
      )}
      <p role="status" className="sr-only">
        {moved}
      </p>
    </div>
  );
}
