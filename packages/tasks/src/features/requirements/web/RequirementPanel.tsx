import { Alert } from "@infodb/p3-shared/web/ui.tsx";
import { requestRequirementView } from "../shared/requirementSource.ts";
import { api } from "../../../web/lib/api.ts";
import type { RequestData } from "../../../web/lib/requestData.tsx";
import { SourceList, SourceStateBadge } from "./RequirementSources.tsx";

/**
 * 要望の「要求の出典と確認」（任意の折り畳み欄）。根拠の記録ごとに対象・出典・根拠・確認の状態・確かめた人と日を見せ、足す・直す・
 * 確認を記録する・消す。記録なしを確認済みにしない。本文から前提を抜き出して確定しない。初回の登録の手数は増やさない（新規の画面には置かない）。
 * 保存は rev つき（他で変わっていれば 409。入力は残す）。未保存の間は Preflight の開始とタスク化を止める（onDirty）
 */
export function RequirementPanel({ data, onDirty, disabled }: { data: RequestData; onDirty: (dirty: boolean) => void; disabled?: boolean }) {
  const { request } = data;
  const view = requestRequirementView(request);
  const count = view.sources.length;
  return (
    <details className="group min-w-0 rounded-lg ring-1 ring-line" open={count > 0 || view.problems.length > 0 || undefined}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 font-semibold">
        要求の出典と確認（任意）
        <SourceStateBadge state={view.state} />
        <span className="text-base font-normal text-fg-4">{count ? `記録 ${count} 件` : "誰の要求か・承認された例などを残せます"}</span>
      </summary>
      <div className="min-w-0 space-y-3 px-4 pb-4">
        <p className="text-base text-fg-3">
          要求そのものが正しいか（計算式・規則・契約など）の根拠です。確かめた人は役割名で書きます。「確認記録あり」は申告で、P3 の保証ではありません。
          題・本文・記録を変えると「再確認が必要」になります。記録と回答は Preflight の評価対象に入ります。
        </p>
        {view.problems.map((p) => (
          <Alert key={p}>
            読めない記録: {p}（request.md を直すまで、ここからは変えられません）
          </Alert>
        ))}
        <SourceList
          label="要望"
          sources={view.sources}
          disabled={disabled || data.gone || view.problems.length > 0}
          onDirty={onDirty}
          onSave={async (ops) => {
            await api.saveSources(request.id, ops, request.rev);
            data.reload();
          }}
        />
      </div>
    </details>
  );
}
