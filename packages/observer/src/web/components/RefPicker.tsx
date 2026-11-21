import { Alert, CheckGroup, Loading } from "@infodb/p3-shared/web/ui.tsx";
import type { DefinitionProblem } from "../../shared/definition.ts";
import { fetchDefinitions, fetchPreparations } from "../lib/api.ts";
import { useLoad } from "../lib/useLoad.ts";

export interface Refs {
  prerequisites: string[];
  preparations: string[];
}

/**
 * 前提の観測と使う準備を選ぶ欄（観測の登録と編集で共通）。選べるのはこのプロジェクトの観測（自分は除く）と準備。
 * 自分自身・循環・存在しない参照の誤り（保存の層が返す）は、該当する欄の下に出す。保存した参照が一覧に無ければ、ID のまま選んだ状態で出す
 */
export function RefPicker({ self, value, onChange, problems }: { self?: string; value: Refs; onChange: (v: Refs) => void; problems: DefinitionProblem[] }) {
  const load = useLoad(async () => ({ defs: (await fetchDefinitions()).definitions, preps: (await fetchPreparations()).items }));
  const err = (key: keyof Refs) =>
    problems
      .filter((p) => p.path === key || p.path.startsWith(`${key}[`))
      .map((p) => p.message)
      .join(" / ") || undefined;
  if (load.kind === "loading") return <Loading />;
  if (load.kind === "error") return <Alert>観測と準備の一覧を読めませんでした: {load.message}</Alert>;
  const keep = (opts: { value: string; label: string }[], chosen: string[]) => [...opts, ...chosen.filter((c) => !opts.some((o) => o.value === c)).map((c) => ({ value: c, label: `${c}（見つからない）` }))];
  return (
    <>
      <CheckGroup
        label="前提の観測（任意）"
        hint="先に通っていてこそ意味がある観測。前提が失敗したら、この観測は失敗ではなく未確認として扱う"
        empty="ほかの観測がありません。"
        options={keep(load.value.defs.filter((d) => d.id !== self && !d.ended).map((d) => ({ value: d.id, label: d.title })), value.prerequisites)}
        value={value.prerequisites}
        onChange={(prerequisites) => onChange({ ...value, prerequisites })}
        error={err("prerequisites")}
      />
      <CheckGroup
        label="使う準備（任意）"
        hint="観測の前後で状態を作る・戻すもの（準備の一覧で登録する）"
        empty="まだ準備がありません。"
        options={keep(load.value.preps.map((p) => ({ value: p.id, label: p.name })), value.preparations)}
        value={value.preparations}
        onChange={(preparations) => onChange({ ...value, preparations })}
        error={err("preparations")}
      />
    </>
  );
}
