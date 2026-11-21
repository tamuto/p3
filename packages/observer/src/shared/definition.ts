/**
 * 観測の定義（何を観測し、どう確かめ、何を測るか）の型と入力の検証。CLI（p3 observer add / update）・API（/api/observer/definitions）・
 * 画面（/observer）が同じ検証を使う（docs/architecture.md「p3-observer」の観測の定義）。
 * 観測の実行・結果の保存・要望やタスクとの関連付けはまだ無い（別の要望）。
 */

/**
 * 保存の形の版（定義のファイルの format）。1〜3 は読むときに今の形に移し（1 は手順の形、2 までは前提の観測・使う準備が無い、3 までは期待の履歴・
 * 終了が無い）、更新のときに 4 で書く。知らない版のファイルは読むだけで上書きしない
 */
export const DEFINITION_FORMAT = 4;

/** 測定項目の型 */
export const MEASURE_TYPES = ["number", "boolean", "string"] as const;
export type MeasureType = (typeof MEASURE_TYPES)[number];
export const MEASURE_TYPE_LABEL: Record<MeasureType, string> = { number: "数値", boolean: "真偽値", string: "文字列" };

/** 実行方法の種別。スクリプト等が無いあいだは AI への指示で確かめ、毎回同じ動作で結果を機械的に処理できるようになったらファイル（スクリプト）に置き換える */
export const RUN_KINDS = ["ai-instruction", "command", "test", "ui-script", "script"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
/** ファイルで確かめる種別（置き換え候補になる） */
export const FILE_KINDS = ["test", "ui-script", "script"] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const RUN_KIND_LABEL: Record<RunKind, string> = { "ai-instruction": "AI への指示", command: "コマンド", test: "ユニットテスト", "ui-script": "画面操作スクリプト", script: "スクリプト" };

/** 何を測定・記録するか */
export interface Measure {
  /** 手順から参照する名前（定義の中で一意。英数字・_・-） */
  name: string;
  type: MeasureType;
  /** 数値の単位（type が number のときだけ。ms・件・% など） */
  unit?: string;
  description?: string;
}

/** AI への指示: AI か人がそのまま実行できる具体的なやること */
export interface AiRun {
  kind: "ai-instruction";
  /** 前提（起動しておくもの・用意するデータなど） */
  premise?: string;
  /** 対象（画面・コマンド・ファイル） */
  target: string;
  /** 順に行う操作（1つが1手） */
  steps: string[];
  /** 判定（何をもって期待どおりとするか） */
  judge: string;
  /** 測定値の記録方法（どの測定項目に何を書くか） */
  record: string;
}
/** コマンド: 実行名・引数・作業場所（参照先の名前と、その中の相対パス） */
export interface CommandRun {
  kind: "command";
  command: string;
  args: string[];
  repo?: string;
  cwd?: string;
}
/** ファイル（テスト・画面操作スクリプト・スクリプト）: 参照先の名前・その中の相対パス・呼び出し方 */
export interface FileRun {
  kind: FileKind;
  repo: string;
  path: string;
  invoke?: string;
}
export type Run = AiRun | CommandRun | FileRun;

/** 置き換え候補: 用意するスクリプト（既にあるものの再利用ならそのファイル）と、切り替えの条件 */
export interface Replacement {
  kind: FileKind;
  repo: string;
  path: string;
  /** そのファイルで再現する操作 */
  operation: string;
  /** 測定値の出力形式（機械的に処理できる形） */
  output: string;
  /** 同じ入力で結果を比べる条件 */
  compare: string;
  /** 切り替えの条件 */
  switchWhen: string;
  /** 呼び出し方の案 */
  invoke?: string;
}

/** 切り替えの履歴（置き換える前の実行方法と、確かめた呼び出し方・結果の根拠） */
export interface Switch {
  at: string;
  by: string;
  from: Run;
  invoke: string;
  evidence: string;
}

/** 実行できるもの（確認の手順と準備の確かめ・前処理・後処理で共通）。run が今の実行方法 */
export interface Executable {
  run: Run;
  replacement?: Replacement;
  history?: Switch[];
}

/** 確認の手順 */
export interface Procedure extends Executable {
  /** 手順の識別子（P1, P2 ...。定義の中で一意。保存の層が付ける） */
  id: string;
  title: string;
  /** この手順で得る測定項目（Measure の name） */
  measures: string[];
}

/** 登録・更新で受け取る中身（ID・版・記録は保存の層が付ける） */
export interface DefinitionInput {
  title: string;
  category: string;
  /** 観測内容（何を観測するか） */
  description: string;
  /** 期待する結果（どうなっていれば期待どおりか。任意） */
  expected?: string;
  /** 前提の観測（ほかの観測の ID）。前提が失敗したら、この観測は失敗ではなく未確認として扱う（実行の段階で扱う） */
  prerequisites?: string[];
  /** 使う準備の ID（入力は名前でもよく、保存の層が ID にする） */
  preparations?: string[];
  measures: Measure[];
  procedures: Procedure[];
}

/** 作業の帰属（タスクを起点にした操作のときだけ。入口・アプリが確かめて渡す） */
export interface WorkRef {
  request: string;
  task: string;
}

/** 期待の履歴の種類: 作成・期待の変更・終了 */
export const HISTORY_KINDS = ["created", "expected", "ended"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];
export const HISTORY_LABEL: Record<HistoryKind, string> = { created: "作成", expected: "期待の変更", ended: "終了" };

/** 期待の履歴の1件（保存の層だけが足す。足すだけで消さない） */
export interface HistoryEntry {
  kind: HistoryKind;
  at: string;
  by: string;
  reason?: string;
  /** 作成・期待の変更のときの期待（作成で期待が無ければ省く）と、変更の前の期待 */
  expected?: string;
  before?: string;
  /** 終了で、機械的な判定を移した外部の CI など */
  movedTo?: string;
  work?: WorkRef;
}

/** 終了（観測の役目を終えた。履歴と定義は読める） */
export interface Ending {
  at: string;
  by: string;
  reason: string;
  movedTo?: string;
}

/**
 * 期待を確定したとき（期待のある作成・期待の変更）の、現行の参照ファイルの内容の比較基準。詳細を開くたびに今の内容と比べ、
 * 期待を直さないまま変わったものを「期待の見直しが要るかもしれない」と出す（保存はしない）
 */
export interface Baseline {
  at: string;
  /** hash は内容の sha256（読めなかったものは無く、state が unverified） */
  files: { repo: string; path: string; hash?: string }[];
}

/** 推定の経緯（あとから作った観測の期待が、どの要望で決まったか。AI が根拠付きで推定し、利用者が確かめたときだけ残す。実作業の帰属ではない） */
export interface EstimatedOrigin {
  requests: string[];
  basis: string;
  confirmedAt: string;
  confirmedBy: string;
}

/** 保存した観測の定義（1つの定義が1つのファイル） */
export interface ObservationDefinition extends DefinitionInput {
  format: typeof DEFINITION_FORMAT;
  id: string;
  /** 期待の履歴（保存の層が書く。形の版 3 までのものには無い） */
  history?: HistoryEntry[];
  /** 終了していればその記録 */
  ended?: Ending;
  baseline?: Baseline;
  estimatedOrigin?: EstimatedOrigin;
  /** 定義の版（作成で 1。更新のたびに 1 増える。更新は今の版を添え、違えば断る） */
  rev: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** 前提の観測と使う準備の名前（見つからない・読めないものは名前が無い。詳細の表示用） */
export interface References {
  prerequisites: { id: string; title?: string }[];
  preparations: { id: string; name?: string }[];
}

/** 入力の誤り。path は項目の場所（title・measures[0].unit・procedures[1].run.path など） */
export interface DefinitionProblem {
  path: string;
  message: string;
}

/** 保存の層が書く項目（入力では受け付けず、読むときは形だけ確かめる） */
export const STORED_ONLY = ["history", "ended", "baseline", "estimatedOrigin"] as const;

export type ValidationResult = { ok: true; value: DefinitionInput } | { ok: false; problems: DefinitionProblem[] };

/** 定義の ID（obs-<作成日>-<乱数5文字>） */
export const DEFINITION_ID = /^obs-\d{6}-[0-9a-hjkmnp-tv-z]{5}$/;
export const isDefinitionId = (v: string) => DEFINITION_ID.test(v);

const MEASURE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const LIMIT = { name: 100, title: 200, category: 100, description: 10_000, unit: 30, text: 2_000, body: 20_000, items: 50, args: 100 };

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMeasureType = (v: unknown): v is MeasureType => (MEASURE_TYPES as readonly unknown[]).includes(v);

/** 相対パス（絶対パス・.. で外へ出るもの・空は不可） */
function badRelative(p: string): string | undefined {
  if (/^([A-Za-z]:)?[\\/]/.test(p) || p.startsWith("~")) return "参照先の中の相対パスで書いてください（絶対パスは使えません）";
  if (p.split(/[\\/]/).includes("..")) return "参照先の外を指す .. は使えません";
  return undefined;
}

/** 項目ごとの検証の部品（観測の定義と準備で共通）。誤りは add に足し、続けて確かめる */
export function fieldChecker(add: (path: string, message: string) => unknown) {
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
  const isKind = <K extends string>(list: readonly K[], v: unknown): v is K => (list as readonly unknown[]).includes(v);
  const relPath = (at: string, v: unknown, required: boolean) => {
    const p = text(at, v, LIMIT.text, required);
    const bad = p && badRelative(p);
    if (bad) add(at, bad);
    return p;
  };
  const only = (at: string, o: Record<string, unknown>, keys: string[]) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) add(`${at}.${k}`, `使わない項目です（${keys.join("・")}）`);
  };
  /** 文字列の並び（前後の空白を落とし、空と重複は誤り） */
  const strings = (at: string, v: unknown, max: number): string[] => {
    const out: string[] = [];
    if (v === undefined || v === null) return out;
    if (!Array.isArray(v)) return void add(at, "文字列の配列で渡してください"), out;
    if (v.length > LIMIT.items) add(at, `${LIMIT.items} 件までです`);
    v.forEach((x, j) => {
      const s = text(`${at}[${j}]`, x, max, true);
      if (s === undefined) return;
      if (out.includes(s)) add(`${at}[${j}]`, `同じものがあります: ${s}`);
      else out.push(s);
    });
    return out;
  };
  const runOf = (at: string, r: unknown): Run | undefined => {
    if (!isRecord(r)) return void add(at, "実行方法をオブジェクトで渡してください");
    if (!isKind(RUN_KINDS, r.kind)) return void add(`${at}.kind`, `種別は ${RUN_KINDS.join(" / ")} のどれかです`);
    if (r.kind === "ai-instruction") {
      only(at, r, ["kind", "premise", "target", "steps", "judge", "record"]);
      const steps: string[] = [];
      if (!Array.isArray(r.steps) || !r.steps.length) add(`${at}.steps`, "順に行う操作を1つ以上書いてください");
      else r.steps.forEach((x, j) => (typeof x === "string" && x.trim() ? steps.push(x.trim()) : add(`${at}.steps[${j}]`, "操作を文字列で書いてください")));
      const premise = text(`${at}.premise`, r.premise, LIMIT.text, false);
      return { kind: "ai-instruction", ...(premise ? { premise } : {}), target: text(`${at}.target`, r.target, LIMIT.text, true) ?? "", steps, judge: text(`${at}.judge`, r.judge, LIMIT.text, true) ?? "", record: text(`${at}.record`, r.record, LIMIT.text, true) ?? "" };
    }
    if (r.kind === "command") {
      only(at, r, ["kind", "command", "args", "repo", "cwd"]);
      const args: string[] = [];
      if (r.args !== undefined && !Array.isArray(r.args)) add(`${at}.args`, "引数は文字列の配列で渡してください");
      else ((r.args as unknown[] | undefined) ?? []).forEach((x, j) => (typeof x === "string" ? args.push(x) : add(`${at}.args[${j}]`, "引数は文字列で渡してください")));
      if (args.length > LIMIT.args) add(`${at}.args`, `引数は ${LIMIT.args} 個までです`);
      const repo = text(`${at}.repo`, r.repo, 100, false);
      const cwd = relPath(`${at}.cwd`, r.cwd, false);
      if (cwd && !repo) add(`${at}.repo`, "作業場所（cwd）を書くときは、その参照先を指定してください");
      return { kind: "command", command: text(`${at}.command`, r.command, LIMIT.text, true) ?? "", args, ...(repo ? { repo } : {}), ...(cwd ? { cwd } : {}) };
    }
    only(at, r, ["kind", "repo", "path", "invoke"]);
    const invoke = text(`${at}.invoke`, r.invoke, LIMIT.text, false);
    return { kind: r.kind, repo: text(`${at}.repo`, r.repo, 100, true) ?? "", path: relPath(`${at}.path`, r.path, true) ?? "", ...(invoke ? { invoke } : {}) };
  };
  const replacementOf = (at: string, r: unknown): Replacement | undefined => {
    if (r === undefined || r === null) return undefined;
    if (!isRecord(r)) return void add(at, "置き換え候補をオブジェクトで渡してください");
    only(at, r, ["kind", "repo", "path", "operation", "output", "compare", "switchWhen", "invoke"]);
    if (!isKind(FILE_KINDS, r.kind)) add(`${at}.kind`, `種別は ${FILE_KINDS.join(" / ")} のどれかです`);
    const t = (k: string, req = true) => text(`${at}.${k}`, r[k], LIMIT.text, req);
    const invoke = t("invoke", false);
    return { kind: r.kind as FileKind, repo: t("repo") ?? "", path: relPath(`${at}.path`, r.path, true) ?? "", operation: t("operation") ?? "", output: t("output") ?? "", compare: t("compare") ?? "", switchWhen: t("switchWhen") ?? "", ...(invoke ? { invoke } : {}) };
  };
  /** 実行方法・置き換え候補・切り替えの履歴（履歴は入力では使わず、保存の層が今の定義のものを残す） */
  const executableOf = (at: string, p: Record<string, unknown>): Executable | undefined => {
    const run = runOf(`${at}.run`, p.run);
    const replacement = replacementOf(`${at}.replacement`, p.replacement);
    const history = Array.isArray(p.history) ? (p.history as Switch[]) : undefined;
    return run && { run, ...(replacement ? { replacement } : {}), ...(history?.length ? { history } : {}) };
  };
  return { text, isKind, only, strings, executableOf };
}

/**
 * 登録・更新の中身を確かめる。誤りは項目ごとに全部返す（最初の1つで止めない）。前後の空白は落とし、空の任意項目は省く。
 * 前提の観測・使う準備は形だけ確かめる（自分自身・循環・存在しない参照は、保存の層がロックの中で確かめる）
 */
export function validateDefinitionInput(input: unknown): ValidationResult {
  const problems: DefinitionProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });
  if (!isRecord(input)) return { ok: false, problems: [{ path: "", message: "観測の定義は JSON のオブジェクトで渡してください" }] };
  const { text, only, strings, executableOf } = fieldChecker(add);

  const known = ["title", "category", "description", "expected", "prerequisites", "preparations", "measures", "procedures"];
  for (const k of Object.keys(input)) if (!known.includes(k)) add(k, `知らない項目です（${known.join("・")}）`);

  const title = text("title", input.title, LIMIT.title, true) ?? "";
  // カテゴリは後から決めてよい（タイトルと観測内容だけで先に保存して ID を付ける）
  const category = text("category", input.category, LIMIT.category, false) ?? "";
  const description = text("description", input.description, LIMIT.description, true) ?? "";
  const expected = text("expected", input.expected, LIMIT.description, false);
  const prerequisites = strings("prerequisites", input.prerequisites, 100);
  prerequisites.forEach((r, j) => !isDefinitionId(r) && add(`prerequisites[${j}]`, `観測の ID（obs-<作成日>-<5文字>）ではありません: ${r}`));
  const preparations = strings("preparations", input.preparations, LIMIT.name);

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
    const ids = new Set<string>();
    rawProcedures.forEach((p, i) => {
      const at = `procedures[${i}]`;
      if (!isRecord(p)) return add(at, "確認の手順はオブジェクトで渡してください");
      only(at, p, ["id", "title", "measures", "run", "replacement", "history"]);
      let id = "";
      if (p.id !== undefined && p.id !== "") {
        if (typeof p.id !== "string" || !/^P\d{1,3}$/.test(p.id)) add(`${at}.id`, "手順の識別子は P1・P2 … の形です");
        else if (ids.has(p.id)) add(`${at}.id`, `同じ識別子の手順があります: ${p.id}`);
        else id = p.id;
        ids.add(String(p.id));
      }
      const refs: string[] = [];
      if (!Array.isArray(p.measures ?? [])) add(`${at}.measures`, "測定項目の名前の配列で渡してください");
      else
        ((p.measures as unknown[] | undefined) ?? []).forEach((r, j) => {
          if (typeof r !== "string" || !measureNames.has(r)) add(`${at}.measures[${j}]`, `定義に無い測定項目です: ${String(r)}`);
          else if (!refs.includes(r)) refs.push(r);
        });
      const e = executableOf(at, p);
      if (e) procedures.push({ id, title: text(`${at}.title`, p.title, LIMIT.title, true) ?? "", measures: refs, ...e });
    });
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { title, category, description, ...(expected ? { expected } : {}), ...(prerequisites.length ? { prerequisites } : {}), ...(preparations.length ? { preparations } : {}), measures, procedures } };
}

/** 前提をたどると self に戻るか（観測の ID → 今の前提の並び）。循環の確かめと、提案の前提の候補から外すものに使う */
export function reachesSelf(definitions: { id: string; prerequisites?: string[] }[], self: string | undefined): (from: string) => boolean {
  const edges = new Map(definitions.map((d) => [d.id, d.prerequisites ?? []]));
  const reaches = (from: string, seen: Set<string>): boolean => from === self || (!seen.has(from) && (seen.add(from), (edges.get(from) ?? []).some((n) => reaches(n, seen))));
  return (from) => self !== undefined && reaches(from, new Set());
}

/** 誤りを人が読む文にする（CLI のエラー・画面の項目に付かない誤り） */
export const problemText = (problems: DefinitionProblem[]) => problems.map((p) => `${p.path || "（全体）"}: ${p.message}`).join("\n");

/** 保存の場所の説明（データのフォルダからの相対） */
export const DEFINITIONS_DIR = "observer/definitions";

/**
 * 形の版 1 の手順（kind と種別ごとの項目を手順に直に持つ）を今の形にする。AI への指示の本文は「順に行う操作」に入れ、足りない項目は
 * 未記入と書く（直すまで確定の保存で誤りになるので、移行した手順は見直してから保存する）。今の形の手順はそのまま
 */
export function migrateProcedures(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((p, i) => {
    if (!isRecord(p) || "run" in p || typeof p.kind !== "string") return p;
    const { kind, title, measures, body, ...rest } = p;
    const run = kind === "ai-instruction" ? { kind, target: "（未記入）", steps: [body], judge: "（未記入）", record: "（未記入）" } : { kind, ...rest };
    return { id: `P${i + 1}`, title, measures, run };
  });
}

/** 手順の識別子を付ける（無いものに、今ある中で一番大きい番号の次から） */
export function assignProcedureIds(list: Procedure[]): Procedure[] {
  let n = Math.max(0, ...list.map((p) => Number(p.id.slice(1)) || 0));
  return list.map((p) => (p.id ? p : { ...p, id: `P${++n}` }));
}

/** ファイルの有無（参照先の中で照らした結果）。exists 既にある / planned 新規予定（参照先は読めるがファイルが無い）/ unverified 確かめられない */
export type FileState = "exists" | "planned" | "unverified";
export const FILE_STATE_LABEL: Record<FileState, string> = { exists: "既にある", planned: "新規予定（まだ無い）", unverified: "未確認（参照先を読めない）" };
export const fileKey = (repo: string, path: string) => `${repo}:${path}`;

/** 定義の中で、ファイルを指す箇所（今の実行方法と置き換え候補） */
export function filesOf(procedures: { run: Run; replacement?: Replacement }[]): { repo: string; path: string }[] {
  return procedures.flatMap((p) => [...(p.run.kind !== "ai-instruction" && p.run.kind !== "command" ? [p.run] : []), ...(p.replacement ? [p.replacement] : [])]).map(({ repo, path }) => ({ repo, path }));
}
