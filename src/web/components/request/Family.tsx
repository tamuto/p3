import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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

        {children.length > 0 && (
          <div className="space-y-2">
            <p className="font-medium">子の要望（{children.length} 件）</p>
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {children.map((c) => (
                <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2">
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
                </li>
              ))}
            </ul>
          </div>
        )}

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
