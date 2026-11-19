import { ACCEPTANCE_KEYS, readAcceptance } from "../../shared/acceptance.ts";
import { BLOCK_KEYS, readBlock } from "../../shared/taskBlock.ts";
import { COMPLETION_KEYS, readCompletion } from "../../shared/completionRecord.ts";
import { PREMISE_KEYS, readPremises } from "../../shared/reviewCandidate.ts";
import { readRework, REWORK_KEYS } from "../../shared/reworkHistory.ts";
import { readRequirement, REQUIREMENT_KEYS } from "../../shared/requirementSource.ts";
import type { Request, Task } from "../../shared/types.ts";

/**
 * p3 が管理する frontmatter の項目のまとまり（受け入れ基準・停止・完了の記録・手戻り・要求の根拠・前提）。1 か所で定義し、次をここから作る:
 *   - 読む（normalize.ts）: まとまりごとの読む関数を順に当てる。読めない値は除いて、まとまりの problems の名前に理由を置く
 *   - 書き戻す（collection.ts の keepRaw）: problems があるまとまりの項目は、関係のない更新でファイルの元の値のまま書く
 *   - 書かない項目（collection.ts の derived）: problems はファイルに書かない（読むたびに決まる）
 *   - 入力から外す（requestOps.ts）: まとまりの項目と problems は CLI・API の値をそのまま書かない（操作でだけ変える。p3 が作る）
 * 項目の型・欠けたときの意味・壊れたときにどの操作を断るか（その文言）は、各まとまりの読む関数と操作の側（shared/*.ts・requestOps.ts）が持つ。
 * まとまりの一覧と差は docs/refactoring.md「壊れた値を消さずに残す」
 */
export interface FieldGroup<T> {
  /** まとまりの名前（文書とテストで指す） */
  name: string;
  /** ファイルに書く項目（壊れていたら元の値のまま書き戻す） */
  keys: readonly string[];
  /** 読めなかった理由の置き場所（ファイルには書かない） */
  problems: keyof T & string;
  /** frontmatter から読む（無ければ何も足さない。読めない値は除いて problems に理由） */
  read: (d: Record<string, unknown>) => Partial<T>;
}

export const TASK_FIELD_GROUPS: readonly FieldGroup<Task>[] = [
  { name: "受け入れ基準・証拠・基準の根拠", keys: ACCEPTANCE_KEYS, problems: "acceptanceProblems", read: readAcceptance },
  { name: "停止と履歴", keys: BLOCK_KEYS, problems: "blockProblems", read: readBlock },
  { name: "完了の記録", keys: COMPLETION_KEYS, problems: "completionProblems", read: readCompletion },
  { name: "手戻りの履歴", keys: REWORK_KEYS, problems: "reworkProblems", read: readRework },
];

export const REQUEST_FIELD_GROUPS: readonly FieldGroup<Request>[] = [
  { name: "要求の根拠・回答", keys: REQUIREMENT_KEYS, problems: "requirementProblems", read: readRequirement },
  { name: "完了の記録", keys: COMPLETION_KEYS, problems: "completionProblems", read: readCompletion },
  { name: "前提の変更", keys: PREMISE_KEYS, problems: "premiseProblems", read: readPremises },
];

/** まとまりを順に読んだ値（読む順は定義の順。後のまとまりが前の項目を上書きしない） */
export const readFieldGroups = <T>(groups: readonly FieldGroup<T>[], d: Record<string, unknown>): Partial<T> => Object.assign({}, ...groups.map((g) => g.read(d))) as Partial<T>;

/** 元の値のまま書き戻す項目（problems があるまとまりの項目） */
export const keepRawOf =
  <T>(groups: readonly FieldGroup<T>[]) =>
  (item: T): readonly string[] =>
    groups.flatMap((g) => ((item[g.problems] as unknown[] | undefined)?.length ? g.keys : []));

/** ファイルに書かない項目（problems） */
export const problemKeysOf = <T>(groups: readonly FieldGroup<T>[]): (keyof T)[] => [...new Set(groups.map((g) => g.problems))];

/** CLI・API の入力から外す項目（まとまりの項目と problems。p3 が操作でだけ変える） */
export const managedKeysOf = <T>(groups: readonly FieldGroup<T>[]): readonly string[] => [...new Set(groups.flatMap((g) => [...g.keys, g.problems]))];

/** 入力から p3 が管理する項目を外す（値をそのまま書く道を持たない） */
export function withoutManaged<T extends object, G>(input: T, groups: readonly FieldGroup<G>[]): T {
  const managed = new Set(managedKeysOf(groups));
  return Object.fromEntries(Object.entries(input).filter(([k]) => !managed.has(k))) as T;
}
