import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createExclusive, newRequestId, nowIso, withFileLock, writeFileAtomic } from "@infodb/p3-shared/node/fsutil.ts";
import {
  assignProcedureIds,
  migrateProcedures,
  type DefinitionInput,
  type Executable,
  type FileState,
  DEFINITION_FORMAT,
  DEFINITIONS_DIR,
  isDefinitionId,
  validateDefinitionInput,
  type DefinitionProblem,
  type ObservationDefinition,
} from "../shared/definition.ts";
import { isPreparationId, PREPARATION_FORMAT, PREPARATIONS_DIR, SLOT_LABEL, validatePreparationInput, type Preparation, type PreparationInput, type Slot } from "../shared/preparation.ts";

/**
 * 観測の定義と準備の保存（docs/architecture.md「p3-observer」）。入口・アプリが解決したプロジェクトのデータのフォルダの下の
 * observer/definitions/（観測）と observer/preparations/（準備）に、1件ずつの JSON（<ID>.json）を置く。tasks の要望・タスク・設定には触れない。
 *
 *   書き込み（作成・更新・切り替え・削除）は observer/.lock で同じマシンの別のプロセスと1つずつにし、ロックの中で参照
 *   （前提の観測・使う準備・準備の名前の重複・準備を使う観測）を確かめる。更新は今の版を読み、添えた版と同じときだけ置き換える
 *   読めない・知らない形の版のファイルは一覧に理由を出し、更新しない（上書きで消さない）
 */
export type DefinitionErrorCode = "invalid" | "not_found" | "conflict" | "unreadable" | "in_use";

export class DefinitionError extends Error {
  constructor(
    readonly code: DefinitionErrorCode,
    message: string,
    readonly problems: DefinitionProblem[] = [],
    readonly current?: ObservationDefinition | Preparation,
  ) {
    super(message);
  }
}

export interface Listing<T> {
  items: T[];
  /** 読めないファイル（壊れた JSON・知らない形の版・形の違い）。消さずに理由だけ出す */
  unreadable: { file: string; reason: string }[];
}
export interface DefinitionListing {
  definitions: ObservationDefinition[];
  unreadable: Listing<unknown>["unreadable"];
}

type Meta = { id: string; rev: number; createdAt: string; createdBy: string; updatedAt: string; updatedBy: string };
type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string; missing?: true };
type Files = (repo: string, path: string) => FileState;

/** 1件1ファイルの JSON（観測と準備で共通）: 読む・一覧・作る・版を照らして置き換える・消す。書き込みは呼び出し側がロックの中で使う */
class DocFiles<T extends Meta> {
  constructor(
    readonly dir: string,
    private readonly k: { noun: string; prefix: string; isId: (v: string) => boolean; parse: (data: Record<string, unknown>, id: string) => Parsed<T> },
  ) {}
  private file = (id: string) => join(this.dir, `${id}.json`);

  async read(id: string): Promise<Parsed<T>> {
    let text: string;
    try {
      text = await readFile(this.file(id), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: `${this.k.noun}がありません: ${id}`, missing: true };
      return { ok: false, reason: (e as Error).message };
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: `JSON として読めません（${(e as Error).message}）` };
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, reason: "オブジェクトではありません" };
    const d = data as Record<string, unknown>;
    if (d.id !== id) return { ok: false, reason: `ファイル名と ID が違います（id: ${JSON.stringify(d.id)}）` };
    if (!Number.isInteger(d.rev) || (d.rev as number) < 1) return { ok: false, reason: "定義の版（rev）が正しくありません" };
    for (const m of ["createdAt", "createdBy", "updatedAt", "updatedBy"]) if (typeof d[m] !== "string") return { ok: false, reason: `${m} がありません` };
    return this.k.parse(d, id);
  }

  async list(): Promise<Listing<T>> {
    const names = await readdir(this.dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as string[];
      throw e;
    });
    const items: T[] = [];
    const unreadable: Listing<T>["unreadable"] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      const id = name.slice(0, -".json".length);
      const r = this.k.isId(id) ? await this.read(id) : { ok: false as const, reason: `${this.k.noun}のファイル名（${this.k.prefix}-<作成日>-<5文字>.json）ではありません` };
      if (r.ok) items.push(r.value);
      else unreadable.push({ file: name, reason: r.reason });
    }
    // 新しく作ったものを先に
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items, unreadable };
  }

  async get(id: string): Promise<T> {
    if (!this.k.isId(id)) throw new DefinitionError("not_found", `${this.k.noun}の ID ではありません: ${id}（${this.k.prefix}-<作成日>-<5文字>）`);
    const r = await this.read(id);
    if (r.ok) return r.value;
    throw new DefinitionError(r.missing ? "not_found" : "unreadable", r.missing ? r.reason : `${this.k.noun} ${id} を読めません: ${r.reason}`);
  }

  async create(make: (meta: Meta) => T, actor: string): Promise<T> {
    for (let i = 0; i < 20; i++) {
      const at = nowIso();
      const doc = make({ id: `${this.k.prefix}-${newRequestId()}`, rev: 1, createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor });
      if (await createExclusive(this.file(doc.id), serialize(doc))) return doc;
    }
    throw new Error(`${this.k.noun}の ID を採番できませんでした（もう一度実行してください）`);
  }

  /** 今の版（expectedRev）を確かめて置き換える。違えば conflict（今のものを添える）。読めないファイルは上書きしない */
  async replace(id: string, expectedRev: number, actor: string, f: (current: T) => Promise<T> | T): Promise<T> {
    const current = await this.checkRev(id, expectedRev);
    const next = { ...(await f(current)), rev: current.rev + 1, updatedAt: nowIso(), updatedBy: actor };
    await writeFileAtomic(this.file(id), serialize(next));
    return next;
  }

  async remove(id: string, expectedRev: number, check: (current: T) => Promise<void>): Promise<void> {
    await check(await this.checkRev(id, expectedRev));
    await unlink(this.file(id));
  }

  private async checkRev(id: string, expectedRev: number): Promise<T> {
    if (!Number.isInteger(expectedRev) || expectedRev < 1) throw new DefinitionError("invalid", "更新には今の版（rev。1 以上の整数）を添えてください", [{ path: "rev", message: "今の版を添えてください" }]);
    const current = await this.get(id);
    if (current.rev !== expectedRev) {
      throw new DefinitionError("conflict", `${this.k.noun} ${id} は更新されています（今の版 ${current.rev}・添えた版 ${expectedRev}）。読み直してからやり直してください`, [], current as unknown as ObservationDefinition | Preparation);
    }
    return current;
  }
}

const serialize = (d: unknown) => `${JSON.stringify(d, null, 2)}\n`;
const meta = (d: Record<string, unknown>) => ({ rev: d.rev as number, createdAt: d.createdAt as string, createdBy: d.createdBy as string, updatedAt: d.updatedAt as string, updatedBy: d.updatedBy as string });
const strip = ({ format: _f, id: _i, rev: _r, createdAt: _ca, createdBy: _cb, updatedAt: _ua, updatedBy: _ub, ...content }: Record<string, unknown>) => content;
const unknownFormat = (f: unknown, known: string) => `知らない形の版です（format: ${JSON.stringify(f)}。この p3 が読めるのは ${known}）。新しい p3 で作ったものなら、p3 を更新してください`;

function parseDefinition(d: Record<string, unknown>, id: string): Parsed<ObservationDefinition> {
  if (d.format !== DEFINITION_FORMAT && d.format !== 1 && d.format !== 2) return { ok: false, reason: unknownFormat(d.format, `1・2・${DEFINITION_FORMAT}`) };
  const content = strip(d);
  // 形の版 1・2 は読むときに今の形にする（書くのは更新のとき。2 までは前提の観測・使う準備が無い）
  const v = validateDefinitionInput(d.format === 1 ? { ...content, procedures: migrateProcedures(content.procedures) } : content);
  if (!v.ok) return { ok: false, reason: `中身が正しくありません（${v.problems.map((p) => `${p.path}: ${p.message}`).join("・")}）` };
  return { ok: true, value: { format: DEFINITION_FORMAT, id, ...v.value, ...meta(d) } };
}

function parsePreparation(d: Record<string, unknown>, id: string): Parsed<Preparation> {
  if (d.format !== PREPARATION_FORMAT) return { ok: false, reason: unknownFormat(d.format, String(PREPARATION_FORMAT)) };
  const v = validatePreparationInput(strip(d));
  if (!v.ok) return { ok: false, reason: `中身が正しくありません（${v.problems.map((p) => `${p.path}: ${p.message}`).join("・")}）` };
  return { ok: true, value: { format: PREPARATION_FORMAT, id, ...v.value, ...meta(d) } };
}

/** 観測と準備のファイルと、書き込みのロック（同じデータのフォルダの観測と準備で1つ） */
function observerFiles(dataDir: string) {
  const lock = join(dataDir, "observer", ".lock");
  return {
    defs: new DocFiles<ObservationDefinition>(join(dataDir, DEFINITIONS_DIR), { noun: "観測の定義", prefix: "obs", isId: isDefinitionId, parse: parseDefinition }),
    preps: new DocFiles<Preparation>(join(dataDir, PREPARATIONS_DIR), { noun: "準備", prefix: "prep", isId: isPreparationId, parse: parsePreparation }),
    locked: <T>(fn: () => Promise<T>) => withFileLock(lock, fn, { busyMessage: "観測の定義のロックを待ちきれませんでした（別のプロセスが更新しています）" }),
  };
}

/** 新規予定のファイルは今の実行方法に使えない（置き換え候補に書く） */
function plannedProblems(files: Files | undefined, list: [string, Executable | undefined][]): DefinitionProblem[] {
  return list.flatMap(([at, e]) =>
    e && e.run.kind !== "ai-instruction" && e.run.kind !== "command" && files?.(e.run.repo, e.run.path) === "planned"
      ? [{ path: `${at}.run.path`, message: "このファイルはまだありません（新規予定）。今の実行方法には使えないので、置き換え候補に書いてください" }]
      : [],
  );
}

/**
 * 実行できるものを置き換え候補のスクリプトに切り替える。ファイルが参照先の中に有ること（files で照らす）・確かめた呼び出し方と結果の根拠が要る。
 * 今の実行方法と呼び出し方が同じ更新で切り替わり、置き換える前の実行方法は履歴に残る
 */
function switched(e: Executable | undefined, at: string, label: string, confirm: { invoke?: string; evidence?: string }, files: Files | undefined, actor: string): Executable {
  const rep = e?.replacement;
  if (!e || !rep) throw new DefinitionError("invalid", `${label}に置き換え候補がありません`, [{ path: `${at}.replacement`, message: "置き換え候補がありません" }]);
  const invoke = confirm.invoke?.trim() || rep.invoke;
  const problems = [
    ...(files?.(rep.repo, rep.path) !== "exists" ? [{ path: `${at}.replacement.path`, message: `${rep.repo}:${rep.path} が参照先の中に有ることを確かめられません（${files ? "まだ無い・読めない" : "参照先を読めない"}）` }] : []),
    ...(!invoke ? [{ path: "invoke", message: "確かめた呼び出し方を書いてください" }] : []),
    ...(!confirm.evidence?.trim() ? [{ path: "evidence", message: "その呼び出し方で測定値が出ることを確かめた結果を書いてください" }] : []),
  ];
  if (problems.length) throw new DefinitionError("invalid", `${label}を切り替えられません`, problems);
  const sw = { at: nowIso(), by: actor, from: e.run, invoke: invoke!, evidence: confirm.evidence!.trim() };
  return { run: { kind: rep.kind, repo: rep.repo, path: rep.path, invoke: invoke! }, history: [...(e.history ?? []), sw] };
}

/** 入力の履歴は使わず、今のものの履歴を残す */
const keepHistory = <E extends Executable>({ history: _h, ...e }: E, current?: Executable): E => (current?.history ? { ...e, history: current.history } : e) as E;
const invalid = (problems: DefinitionProblem[], what = "観測の定義") => new DefinitionError("invalid", `${what}に誤りがあります`, problems);

export class DefinitionStore {
  private readonly f: ReturnType<typeof observerFiles>;
  /** files: 参照先の中でファイルの有無を照らす（入口が参照先のこのマシンのパスから作る。無ければ確かめない） */
  constructor(
    readonly dataDir: string,
    private readonly files?: Files,
  ) {
    this.f = observerFiles(dataDir);
    this.dir = this.f.defs.dir;
  }
  readonly dir: string;

  async list(): Promise<DefinitionListing> {
    const { items, unreadable } = await this.f.defs.list();
    return { definitions: items, unreadable };
  }

  get(id: string): Promise<ObservationDefinition> {
    return this.f.defs.get(id);
  }

  /**
   * 入力を確かめ、手順に識別子を付け、履歴は今の定義のものだけを残す。新規予定のファイルは今の実行方法に使えない。
   * 使う準備は名前か ID を ID にし、前提の観測は自分自身・循環・存在しない ID を断る（ロックの中で呼ぶ）
   */
  private async content(input: unknown, self?: ObservationDefinition): Promise<DefinitionInput> {
    const v = validateDefinitionInput(input);
    if (!v.ok) throw invalid(v.problems);
    const procedures = assignProcedureIds(v.value.procedures).map((p) => keepHistory(p, self?.procedures.find((c) => c.id === p.id)));
    const problems = plannedProblems(this.files, procedures.map((p, i) => [`procedures[${i}]`, p]));
    const preparations = await this.resolvePreparations(v.value.preparations ?? [], problems);
    await this.checkPrerequisites(self?.id, v.value.prerequisites ?? [], problems);
    if (problems.length) throw invalid(problems);
    const { preparations: _p, ...rest } = v.value;
    return { ...rest, ...(preparations.length ? { preparations } : {}), procedures };
  }

  private async resolvePreparations(refs: string[], problems: DefinitionProblem[]): Promise<string[]> {
    if (!refs.length) return [];
    const { items, unreadable } = await this.f.preps.list();
    const out: string[] = [];
    refs.forEach((r, j) => {
      const hit = items.find((p) => p.id === r) ?? items.find((p) => p.name === r);
      if (!hit) problems.push({ path: `preparations[${j}]`, message: `準備がありません: ${r}${unreadable.length ? `（読めない準備のファイルが ${unreadable.length} 件あります）` : ""}` });
      else if (out.includes(hit.id)) problems.push({ path: `preparations[${j}]`, message: `同じ準備を2回指定しています: ${r}` });
      else out.push(hit.id);
    });
    return out;
  }

  /** 前提の観測: 存在すること・自分自身でないこと・たどって自分に戻らないこと（ほかの観測の今の前提をたどる） */
  private async checkPrerequisites(self: string | undefined, refs: string[], problems: DefinitionProblem[]) {
    if (!refs.length) return;
    const { items } = await this.f.defs.list();
    const edges = new Map(items.map((d) => [d.id, d.prerequisites ?? []]));
    const reaches = (from: string, seen = new Set<string>()): boolean =>
      from === self || (!seen.has(from) && (seen.add(from), (edges.get(from) ?? []).some((n) => reaches(n, seen))));
    for (const [j, r] of refs.entries()) {
      const at = `prerequisites[${j}]`;
      if (r === self) problems.push({ path: at, message: "自分自身は前提にできません" });
      else if (!edges.has(r)) {
        const got = await this.f.defs.read(r);
        problems.push({ path: at, message: !got.ok && got.missing ? `観測がありません: ${r}` : `観測を読めないので確かめられません: ${r}` });
      } else if (self && reaches(r)) problems.push({ path: at, message: `前提が循環します（${r} の前提をたどるとこの観測に戻ります）` });
    }
  }

  async create(input: unknown, actor: string): Promise<ObservationDefinition> {
    return this.f.locked(async () => {
      const content = await this.content(input);
      return this.f.defs.create((m) => ({ format: DEFINITION_FORMAT, ...m, ...content }), actor);
    });
  }

  /** 今の版（expectedRev）を添えて置き換える。違えば conflict（今の定義を添える）。読めないファイルは上書きしない */
  async update(id: string, expectedRev: number, input: unknown, actor: string): Promise<ObservationDefinition> {
    return this.f.locked(() => this.f.defs.replace(id, expectedRev, actor, async (current) => ({ ...pick(current), format: DEFINITION_FORMAT, ...(await this.content(input, current)) })));
  }

  /** 手順を置き換え候補のスクリプトに切り替える（切り替えの決まりは switched） */
  async switchProcedure(id: string, expectedRev: number, pid: string, confirm: { invoke?: string; evidence?: string }, actor: string): Promise<ObservationDefinition> {
    return this.f.locked(() =>
      this.f.defs.replace(id, expectedRev, actor, (current) => {
        const i = current.procedures.findIndex((p) => p.id === pid);
        const p = current.procedures[i];
        if (!p) throw new DefinitionError("not_found", `手順がありません: ${pid}`);
        const next = { id: p.id, title: p.title, measures: p.measures, ...switched(p, `procedures[${i}]`, `手順 ${pid} `, confirm, this.files, actor) };
        return { ...current, format: DEFINITION_FORMAT, procedures: current.procedures.map((x, j) => (j === i ? next : x)) };
      }),
    );
  }
}

/** 保存の層が付ける項目だけ（中身は入れ替える） */
const pick = <T extends Meta>({ id, rev, createdAt, createdBy, updatedAt, updatedBy }: T) => ({ id, rev, createdAt, createdBy, updatedAt, updatedBy });

export class PreparationStore {
  private readonly f: ReturnType<typeof observerFiles>;
  constructor(
    readonly dataDir: string,
    private readonly files?: Files,
  ) {
    this.f = observerFiles(dataDir);
    this.dir = this.f.preps.dir;
  }
  readonly dir: string;

  list(): Promise<Listing<Preparation>> {
    return this.f.preps.list();
  }

  get(id: string): Promise<Preparation> {
    return this.f.preps.get(id);
  }

  /** この準備を使う観測（読めない観測のファイルは unreadable に出す） */
  async usedBy(id: string): Promise<{ definitions: Pick<ObservationDefinition, "id" | "title" | "rev">[]; unreadable: Listing<unknown>["unreadable"] }> {
    const { items, unreadable } = await this.f.defs.list();
    return { definitions: items.filter((d) => d.preparations?.includes(id)).map(({ id: i, title, rev }) => ({ id: i, title, rev })), unreadable };
  }

  /** 入力を確かめ、名前の重複を断り、履歴は今の準備のものだけを残す（ロックの中で呼ぶ） */
  private async content(input: unknown, self?: Preparation): Promise<PreparationInput> {
    const v = validatePreparationInput(input);
    if (!v.ok) throw invalid(v.problems, "準備");
    const value = { ...v.value };
    for (const s of ["check", "setup", "teardown"] as Slot[]) if (value[s]) value[s] = keepHistory(value[s], self?.[s]);
    const problems = plannedProblems(this.files, (["check", "setup", "teardown"] as Slot[]).map((s) => [s, value[s]]));
    const same = (await this.f.preps.list()).items.find((p) => p.name === value.name && p.id !== self?.id);
    if (same) problems.push({ path: "name", message: `同じ名前の準備があります: ${same.id}` });
    if (problems.length) throw invalid(problems, "準備");
    return value;
  }

  create(input: unknown, actor: string): Promise<Preparation> {
    return this.f.locked(async () => {
      const content = await this.content(input);
      return this.f.preps.create((m) => ({ format: PREPARATION_FORMAT, ...m, ...content }), actor);
    });
  }

  update(id: string, expectedRev: number, input: unknown, actor: string): Promise<Preparation> {
    return this.f.locked(() => this.f.preps.replace(id, expectedRev, actor, async (current) => ({ ...pick(current), format: PREPARATION_FORMAT, ...(await this.content(input, current)) })));
  }

  /** 確かめ・前処理・後処理のどれかを置き換え候補のスクリプトに切り替える（決まりは手順の切り替えと同じ） */
  async switchSlot(id: string, expectedRev: number, slot: Slot, confirm: { invoke?: string; evidence?: string }, actor: string): Promise<Preparation> {
    if (!(slot in SLOT_LABEL)) throw new DefinitionError("not_found", `準備の項目ではありません: ${slot}（check・setup・teardown）`);
    return this.f.locked(() => this.f.preps.replace(id, expectedRev, actor, (current) => ({ ...current, [slot]: switched(current[slot], slot, SLOT_LABEL[slot], confirm, this.files, actor) })));
  }

  /** 消す（今の版を添える）。使っている観測があれば断って示し、観測のファイルが読めず確かめられないときも断る */
  remove(id: string, expectedRev: number): Promise<void> {
    return this.f.locked(() =>
      this.f.preps.remove(id, expectedRev, async () => {
        const used = await this.usedBy(id);
        if (used.definitions.length) throw new DefinitionError("in_use", `この準備を使っている観測があります（${used.definitions.map((d) => `${d.id} ${d.title}`).join("・")}）。観測から外してから消してください`);
        if (used.unreadable.length) throw new DefinitionError("unreadable", `読めない観測のファイルがあり、この準備を使っていないことを確かめられません（${used.unreadable.map((u) => u.file).join("・")}）`);
      }),
    );
  }
}
