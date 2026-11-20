import { type DefinitionProblem, type Executable, fieldChecker, isRecord, LIMIT } from "./definition.ts";

/**
 * 準備（観測の前後で状態を作る・戻すもの）の型と入力の検証。CLI（p3 observer prep）・API（/api/observer/preparations）・画面
 * （/observer/preparations）が同じ検証を使う（docs/architecture.md「p3-observer」の準備）。1つの準備が1つのファイルで、観測から名前か ID で参照する。
 * 確かめ・前処理・後処理は確認の手順と同じ実行方法（AI への指示 → 安定したらスクリプトへの切り替えと履歴）を使う
 */
export const PREPARATION_FORMAT = 1;
export const PREPARATIONS_DIR = "observer/preparations";

/** 実行できる3つの項目（確かめ: 使える状態かの確認 / 前処理: 既知の状態に戻す・作る / 後処理: できるときにやる片付け） */
export const SLOTS = ["check", "setup", "teardown"] as const;
export type Slot = (typeof SLOTS)[number];
export const SLOT_LABEL: Record<Slot, string> = { check: "確かめ", setup: "前処理", teardown: "後処理" };
export const SLOT_HINT: Record<Slot, string> = {
  check: "使える状態かを確かめる（応答の確認など）",
  setup: "始める前に既知の状態に戻す・作る（作るデータには実行ごとに一意な名前を付ける）",
  teardown: "できるときにやる片付け（失敗したら片付ける前に証跡を取る）",
};

export interface PreparationInput {
  /** 観測から参照する名前（プロジェクトの中で一意。前後の空白を除いた完全一致） */
  name: string;
  description?: string;
  check?: Executable;
  setup?: Executable;
  teardown?: Executable;
  /** 占有（同時に走らせないもの。データ・アカウントなどを自由な文字列で） */
  exclusive: string[];
}

export interface Preparation extends PreparationInput {
  format: typeof PREPARATION_FORMAT;
  id: string;
  rev: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export const PREPARATION_ID = /^prep-\d{6}-[0-9a-hjkmnp-tv-z]{5}$/;
export const isPreparationId = (v: string) => PREPARATION_ID.test(v);

/** 登録・更新の中身を確かめる（誤りは項目ごとに全部返す。名前の重複は保存の層がロックの中で確かめる） */
export function validatePreparationInput(input: unknown): { ok: true; value: PreparationInput } | { ok: false; problems: DefinitionProblem[] } {
  const problems: DefinitionProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });
  if (!isRecord(input)) return { ok: false, problems: [{ path: "", message: "準備は JSON のオブジェクトで渡してください" }] };
  const { text, only, strings, executableOf } = fieldChecker(add);
  const known = ["name", "description", ...SLOTS, "exclusive"];
  for (const k of Object.keys(input)) if (!known.includes(k)) add(k, `知らない項目です（${known.join("・")}）`);
  const name = text("name", input.name, LIMIT.name, true) ?? "";
  if (isPreparationId(name)) add("name", "準備の ID と同じ形の名前は使えません（ID と区別できないため）");
  const description = text("description", input.description, LIMIT.description, false);
  const exclusive = strings("exclusive", input.exclusive, LIMIT.name);
  const slots: Partial<Record<Slot, Executable>> = {};
  for (const s of SLOTS) {
    const v = input[s];
    if (v === undefined || v === null) continue;
    if (!isRecord(v)) {
      add(s, `${SLOT_LABEL[s]}はオブジェクトで渡してください`);
      continue;
    }
    only(s, v, ["run", "replacement", "history"]);
    const e = executableOf(s, v);
    if (e) slots[s] = e;
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { name, ...(description ? { description } : {}), ...slots, exclusive } };
}
