import { Button } from "../ui.tsx";
import { isDirty, type Draft } from "../../lib/draft.ts";

/** 編集中に他で変わったことの知らせ（要望のタイトル・タグ・本文で共通） */

/** 編集中に外で変わったことを知らせる（入力はそのまま。捨てると最新の値にする） */
export function ExternalChange<V>({
  label,
  draft,
  eq,
  show = String,
  onDiscard,
}: {
  label: string;
  draft: Draft<V>;
  eq?: (a: V, b: V) => boolean;
  show?: (v: V) => string;
  onDiscard: () => void;
}) {
  if (!draft.external || !isDirty(draft, eq)) return null;
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
      <span className="min-w-0 break-words">
        編集中に{label}が他で変わりました（rev {draft.external.rev}: 「{show(draft.external.value)}」）。このまま保存すると競合になります。
      </span>
      <Button onClick={onDiscard}>入力を捨てて最新にする</Button>
    </p>
  );
}

