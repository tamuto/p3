import type { RunPulse } from "../../../shared/types.ts";
import { runStateLabel } from "../../lib/preflightWatch.ts";
import { Badge, Button } from "../ui.tsx";

/**
 * 最新の Preflight が表示中の run と違うときの知らせ（実行ボタン・履歴の選択の直下）。表示・入力・タスク案の詳細は変えず、
 * 「新しい run を開く」で人が切り替える。フォーカスは奪わない（読み上げは polite）
 */
export function PreflightNotice({ run, fresh, onOpen }: { run: RunPulse; fresh: boolean; onOpen: () => void }) {
  const state = runStateLabel(run);
  return (
    <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-sky-50 p-4 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:ring-sky-900">
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <p className="font-medium">{fresh ? "新しい Preflight があります" : "表示中の評価は最新ではありません"}</p>
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm break-all">{run.id}</span>
          <Badge tone={state.tone}>{state.label}</Badge>
        </p>
        <p className="text-sm text-slate-500">今の評価を表示したままです。入力中の内容も残っています。</p>
      </div>
      <Button variant="primary" onClick={onOpen}>
        {fresh ? "新しい run を開く" : "最新の run を開く"}
      </Button>
    </div>
  );
}
