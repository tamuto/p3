/**
 * 観測の定義（何を観測し、どう確かめ、何を測るか）の型と入力の検証。CLI（p3 observer add / update）・API（/api/observer/definitions）・
 * 画面（/observer）が同じ検証を使う（docs/architecture.md「p3-observer」の観測の定義）。
 * 観測の実行・結果の保存・要望やタスクとの関連付けはまだ無い（別の要望）。
 */

/** 保存の形の版（定義のファイルの format）。知らない版のファイルは読むだけで上書きしない */
export const DEFINITION_FORMAT = 1;

/** 測定項目の型 */
export const MEASURE_TYPES = ["number", "boolean", "string"] as const;
export type MeasureType = (typeof MEASURE_TYPES)[number];
export const MEASURE_TYPE_LABEL: Record<MeasureType, string> = { number: "数値", boolean: "真偽値", string: "文字列" };

/** 確かめる手順の種別 */
export const PROCEDURE_KINDS = ["command", "test", "ui-script", "ai-instruction"] as const;
export type ProcedureKind = (typeof PROCEDURE_KINDS)[number];
export const PROCEDURE_KIND_LABEL: Record<ProcedureKind, string> = {
  command: "コマンド",
  test: "ユニットテスト",
  "ui-script": "画面操作スクリプト",
  "ai-instruction": "AI への指示",
};

/** 何を測定・記録するか */
export interface Measure {
  /** 手順から参照する名前（定義の中で一意。英数字・_・-） */
  name: string;
  type: MeasureType;
  /** 数値の単位（type が number のときだけ。ms・件・% など） */
  unit?: string;
  description?: string;
}

interface ProcedureBase {
  /** 手順の短い名前 */
  title: string;
  /** この手順で得る測定項目（Measure の name） */
  measures: string[];
}
/** コマンド: 実行名・引数・作業場所（参照先の名前と、その中の相対パス） */
export interface CommandProcedure extends ProcedureBase {
  kind: "command";
  command: string;
  args: string[];
  /** 作業場所の参照先（プロジェクトに登録した参照先の名前。省くと作業場所を決めない） */
  repo?: string;
  /** 参照先の中の相対パス（省くと参照先のルート） */
  cwd?: string;
}
/** ユニットテスト・画面操作スクリプト: 参照先の名前・その中の相対パス・必要なら呼び出し方 */
export interface FileProcedure extends ProcedureBase {
  kind: "test" | "ui-script";
  repo: string;
  path: string;
  /** 呼び出し方（例: pnpm vitest run <path>）。省くと決めない */
  invoke?: string;
}
/** AI への指示: 本文 */
export interface AiInstructionProcedure extends ProcedureBase {
  kind: "ai-instruction";
  body: string;
}
export type Procedure = CommandProcedure | FileProcedure | AiInstructionProcedure;

/** 登録・更新で受け取る中身（ID・版・記録は保存の層が付ける） */
export interface DefinitionInput {
  title: string;
  category: string;
  /** 観測内容（何を観測するか） */
  description: string;
  measures: Measure[];
  procedures: Procedure[];
}

/** 保存した観測の定義（1つの定義が1つのファイル） */
export interface ObservationDefinition extends DefinitionInput {
  format: typeof DEFINITION_FORMAT;
  id: string;
  /** 定義の版（作成で 1。更新のたびに 1 増える。更新は今の版を添え、違えば断る） */
  rev: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** 入力の誤り。path は項目の場所（title・measures[0].unit・procedures[1].repo など） */
export interface DefinitionProblem {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; value: DefinitionInput } | { ok: false; problems: DefinitionProblem[] };

/** 定義の ID（obs-<作成日>-<乱数5文字>） */
export const DEFINITION_ID = /^obs-\d{6}-[0-9a-hjkmnp-tv-z]{5}$/;
export const isDefinitionId = (v: string) => DEFINITION_ID.test(v);

const MEASURE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LIMIT = { title: 200, category: 100, description: 10_000, unit: 30, text: 2_000, body: 20_000, items: 50, args: 100 };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMeasureType = (v: unknown): v is MeasureType => (MEASURE_TYPES as readonly unknown[]).includes(v);
const isProcedureKind = (v: unknown): v is ProcedureKind => (PROCEDURE_KINDS as readonly unknown[]).includes(v);

/** 相対パス（絶対パス・.. で外へ出るもの・空は不可） */
function badRelative(p: string): string | undefined {
  if (/^([A-Za-z]:)?[\\/]/.test(p) || p.startsWith("~")) return "参照先の中の相対パスで書いてください（絶対パスは使えません）";
  if (p.split(/[\\/]/).includes("..")) return "参照先の外を指す .. は使えません";
  return undefined;
}

/**
 * 登録・更新の中身を確かめる。誤りは項目ごとに全部返す（最初の1つで止めない）。前後の空白は落とし、空の任意項目は省く
 */
export function validateDefinitionInput(input: unknown): ValidationResult {
  const problems: DefinitionProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });
  if (!isRecord(input)) return { ok: false, problems: [{ path: "", message: "観測の定義は JSON のオブジェクトで渡してください" }] };

  const text = (path: string, v: unknown, max: number, required: boolean): string | undefined => {
    if (v === undefined || v === null || v === "") {
      if (required) add(path, "入力してください");
      return undefined;
    }
    if (typeof v !== "string") {
      add(path, "文字列で入力してください");
      return undefined;
    }
    const s = v.trim();
    if (!s) {
      if (required) add(path, "入力してください");
      return undefined;
    }
    if (s.length > max) add(path, `${max} 文字以内で入力してください`);
    return s;
  };

  const known = new Set(["title", "category", "description", "measures", "procedures"]);
  for (const k of Object.keys(input)) if (!known.has(k)) add(k, `知らない項目です（${[...known].join("・")}）`);

  const title = text("title", input.title, LIMIT.title, true) ?? "";
  const category = text("category", input.category, LIMIT.category, true) ?? "";
  const description = text("description", input.description, LIMIT.description, true) ?? "";

  const measures: Measure[] = [];
  const rawMeasures = input.measures ?? [];
  if (!Array.isArray(rawMeasures)) add("measures", "測定項目は配列で渡してください");
  else {
    if (rawMeasures.length > LIMIT.items) add("measures", `測定項目は ${LIMIT.items} 件までです`);
    const seen = new Set<string>();
    rawMeasures.forEach((m, i) => {
      const at = `measures[${i}]`;
      if (!isRecord(m)) return add(at, "測定項目はオブジェクトで渡してください");
      for (const k of Object.keys(m)) if (!["name", "type", "unit", "description"].includes(k)) add(`${at}.${k}`, "知らない項目です（name・type・unit・description）");
      const name = text(`${at}.name`, m.name, 64, true);
      if (name !== undefined) {
        if (!MEASURE_NAME.test(name)) add(`${at}.name`, "英数字で始まり、英数字・_・- だけの64文字以内にしてください");
        else if (seen.has(name)) add(`${at}.name`, `同じ名前の測定項目があります: ${name}`);
        seen.add(name);
      }
      let type: MeasureType | undefined;
      if (!isMeasureType(m.type)) add(`${at}.type`, `型は ${MEASURE_TYPES.join(" / ")} のどれかです`);
      else type = m.type;
      const unit = text(`${at}.unit`, m.unit, LIMIT.unit, false);
      if (unit !== undefined && type !== undefined && type !== "number") add(`${at}.unit`, "単位は数値の測定項目だけに付けられます");
      const desc = text(`${at}.description`, m.description, LIMIT.text, false);
      if (name !== undefined && type !== undefined) measures.push({ name, type, ...(unit !== undefined && type === "number" ? { unit } : {}), ...(desc !== undefined ? { description: desc } : {}) });
    });
  }
  const measureNames = new Set(measures.map((m) => m.name));

  const procedures: Procedure[] = [];
  const rawProcedures = input.procedures ?? [];
  if (!Array.isArray(rawProcedures)) add("procedures", "確認の手順は配列で渡してください");
  else {
    if (rawProcedures.length > LIMIT.items) add("procedures", `確認の手順は ${LIMIT.items} 件までです`);
    rawProcedures.forEach((p, i) => {
      const at = `procedures[${i}]`;
      if (!isRecord(p)) return add(at, "確認の手順はオブジェクトで渡してください");
      if (!isProcedureKind(p.kind)) return add(`${at}.kind`, `種別は ${PROCEDURE_KINDS.join(" / ")} のどれかです`);
      const fields: Record<ProcedureKind, string[]> = {
        command: ["command", "args", "repo", "cwd"],
        test: ["repo", "path", "invoke"],
        "ui-script": ["repo", "path", "invoke"],
        "ai-instruction": ["body"],
      };
      const allowed = ["kind", "title", "measures", ...fields[p.kind]];
      for (const k of Object.keys(p)) if (!allowed.includes(k)) add(`${at}.${k}`, `${PROCEDURE_KIND_LABEL[p.kind]}には使わない項目です（${allowed.join("・")}）`);
      const title = text(`${at}.title`, p.title, LIMIT.title, true) ?? "";
      const refs: string[] = [];
      const rawRefs = p.measures ?? [];
      if (!Array.isArray(rawRefs)) add(`${at}.measures`, "測定項目の名前の配列で渡してください");
      else
        rawRefs.forEach((r, j) => {
          if (typeof r !== "string" || !measureNames.has(r)) add(`${at}.measures[${j}]`, `定義に無い測定項目です: ${String(r)}`);
          else if (!refs.includes(r)) refs.push(r);
        });
      const base = { title, measures: refs };
      if (p.kind === "command") {
        const command = text(`${at}.command`, p.command, LIMIT.text, true) ?? "";
        const args: string[] = [];
        const rawArgs = p.args ?? [];
        if (!Array.isArray(rawArgs)) add(`${at}.args`, "引数は文字列の配列で渡してください");
        else {
          if (rawArgs.length > LIMIT.args) add(`${at}.args`, `引数は ${LIMIT.args} 個までです`);
          rawArgs.forEach((a, j) => (typeof a === "string" ? args.push(a) : add(`${at}.args[${j}]`, "引数は文字列で渡してください")));
        }
        const repo = text(`${at}.repo`, p.repo, 100, false);
        const cwd = text(`${at}.cwd`, p.cwd, LIMIT.text, false);
        if (cwd !== undefined) {
          const bad = badRelative(cwd);
          if (bad) add(`${at}.cwd`, bad);
          if (repo === undefined) add(`${at}.repo`, "作業場所（cwd）を書くときは、その参照先を指定してください");
        }
        procedures.push({ kind: "command", ...base, command, args, ...(repo !== undefined ? { repo } : {}), ...(cwd !== undefined ? { cwd } : {}) });
      } else if (p.kind === "test" || p.kind === "ui-script") {
        const repo = text(`${at}.repo`, p.repo, 100, true) ?? "";
        const path = text(`${at}.path`, p.path, LIMIT.text, true) ?? "";
        if (path) {
          const bad = badRelative(path);
          if (bad) add(`${at}.path`, bad);
        }
        const invoke = text(`${at}.invoke`, p.invoke, LIMIT.text, false);
        procedures.push({ kind: p.kind, ...base, repo, path, ...(invoke !== undefined ? { invoke } : {}) });
      } else {
        const body = text(`${at}.body`, p.body, LIMIT.body, true) ?? "";
        procedures.push({ kind: "ai-instruction", ...base, body });
      }
    });
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { title, category, description, measures, procedures } };
}

/** 誤りを人が読む文にする（CLI のエラー・画面の項目に付かない誤り） */
export const problemText = (problems: DefinitionProblem[]) => problems.map((p) => `${p.path || "（全体）"}: ${p.message}`).join("\n");

/** 保存の場所の説明（データのフォルダからの相対） */
export const DEFINITIONS_DIR = "observer/definitions";
