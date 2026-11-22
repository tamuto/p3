import { Alert, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createPreparation, fetchSuggestion } from "../../../lib/api.ts";
import { useLoad } from "../../../lib/useLoad.ts";
import { PreparationForm } from "../../../components/PreparationForm.tsx";

/**
 * /observer/preparations/new: 準備を登録する（名前・説明・占有と、確かめ・前処理・後処理）。
 * AI の提案の新しい準備の案から開いたとき（from: 観測の ID・sid: 提案・n: 何番目の案）は、案を入れた入力欄で確かめて保存し、
 * その観測の編集に戻って使う準備に足す（観測の保存をやめても、準備は登録済みとして残り、再利用できる）
 */
export const Route = createFileRoute("/observer/preparations/new")({
  component: NewPreparation,
  validateSearch: (s: Record<string, unknown>): { from?: string; sid?: string; n?: number } => ({
    from: typeof s.from === "string" ? s.from : undefined,
    sid: typeof s.sid === "string" ? s.sid : undefined,
    n: typeof s.n === "number" ? s.n : undefined,
  }),
});

function NewPreparation() {
  const navigate = useNavigate();
  const { from, sid, n } = Route.useSearch();
  const load = useLoad(async () => (from && sid ? (await fetchSuggestion(from, sid)).result?.newPreparations[n ?? 0]?.preparation : undefined), `${from}:${sid}:${n}`);
  return (
    <div className="w-full space-y-4 px-4 py-6 sm:px-6 lg:p-8">
      {from ? (
        <Link to="/observer/$id/edit" params={{ id: from }} className={linkCls}>
          ← 観測の編集へ戻る（準備を足さない）
        </Link>
      ) : (
        <Link to="/observer/preparations" className={linkCls}>
          ← 準備の一覧
        </Link>
      )}
      <h1 className="text-2xl font-bold">準備を登録</h1>
      {from && <p className="text-fg-3">AI の提案の新しい準備の案を入れています。確かめて直してから保存すると、観測の編集に戻り、使う準備に足します（観測の保存は編集の画面で行います）。</p>}
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>提案を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && (
        <PreparationForm
          initial={load.value}
          submitLabel="保存する"
          onSave={createPreparation}
          onSaved={(p) => void (from ? navigate({ to: "/observer/$id/edit", params: { id: from }, search: { addPreparation: p.id } }) : navigate({ to: "/observer/preparations/$pid", params: { pid: p.id } }))}
        />
      )}
    </div>
  );
}
