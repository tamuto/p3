import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createExclusive, newRequestId, nowIso, withFileLock, writeFileAtomic } from "@infodb/p3-shared/node/fsutil.ts";
import {
  assignProcedureIds,
  migrateProcedures,
  type DefinitionInput,
  type FileState,
  DEFINITION_FORMAT,
  DEFINITIONS_DIR,
  isDefinitionId,
  validateDefinitionInput,
  type DefinitionProblem,
  type ObservationDefinition,
} from "../shared/definition.ts";

/**
 * 観測の定義の保存（docs/architecture.md「p3-observer」）。入口・アプリが解決したプロジェクトのデータのフォルダの下の observer/definitions/ に、
 * 定義ごとの JSON（<ID>.json）を置く。tasks の要望・タスク・設定には触れない。
 *
 *   作成: ID を採番し、同じ名前のファイルが無いときだけ作る（O_EXCL）
 *   更新: observer/.lock で同じマシンの別のプロセスと1つずつにし、ロックの中で今の版を読み、添えた版と同じときだけ置き換える
 *   読めない・知らない形の版のファイルは一覧に理由を出し、更新しない（上書きで消さない）
 */
export type DefinitionErrorCode = "invalid" | "not_found" | "conflict" | "unreadable";

export class DefinitionError extends Error {
  constructor(
    readonly code: DefinitionErrorCode,
    message: string,
    readonly problems: DefinitionProblem[] = [],
    readonly current?: ObservationDefinition,
  ) {
    super(message);
  }
}

export interface DefinitionListing {
  definitions: ObservationDefinition[];
  /** 読めないファイル（壊れた JSON・知らない形の版・形の違い）。消さずに理由だけ出す */
  unreadable: { file: string; reason: string }[];
}

export class DefinitionStore {
  readonly dir: string;
  private readonly lock: string;

  /** files: 参照先の中でファイルの有無を照らす（入口が参照先のこのマシンのパスから作る。無ければ確かめない） */
  constructor(
    readonly dataDir: string,
    private readonly files?: (repo: string, path: string) => FileState,
  ) {
    this.dir = join(dataDir, DEFINITIONS_DIR);
    this.lock = join(dataDir, "observer", ".lock");
  }

  private file(id: string) {
    return join(this.dir, `${id}.json`);
  }

  /** 1つのファイルを読む。読めなければ理由を返す */
  private async read(id: string): Promise<{ ok: true; value: ObservationDefinition } | { ok: false; reason: string; missing?: true }> {
    let text: string;
    try {
      text = await readFile(this.file(id), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: `観測の定義がありません: ${id}`, missing: true };
      return { ok: false, reason: (e as Error).message };
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: `JSON として読めません（${(e as Error).message}）` };
    }
    return parseStored(data, id);
  }

  async list(): Promise<DefinitionListing> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { definitions: [], unreadable: [] };
      throw e;
    }
    const definitions: ObservationDefinition[] = [];
    const unreadable: DefinitionListing["unreadable"] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      const id = name.slice(0, -".json".length);
      if (!isDefinitionId(id)) {
        unreadable.push({ file: name, reason: "観測の定義のファイル名（obs-<作成日>-<5文字>.json）ではありません" });
        continue;
      }
      const r = await this.read(id);
      if (r.ok) definitions.push(r.value);
      else unreadable.push({ file: name, reason: r.reason });
    }
    // 新しく作ったものを先に
    definitions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { definitions, unreadable };
  }

  async get(id: string): Promise<ObservationDefinition> {
    if (!isDefinitionId(id)) throw new DefinitionError("not_found", `観測の定義の ID ではありません: ${id}（obs-<作成日>-<5文字>）`);
    const r = await this.read(id);
    if (r.ok) return r.value;
    throw new DefinitionError(r.missing ? "not_found" : "unreadable", r.missing ? r.reason : `観測の定義 ${id} を読めません: ${r.reason}`);
  }

  /** 入力を確かめ、手順に識別子を付け、履歴は今の定義のものだけを残す（入力の履歴は使わない）。新規予定のファイルは今の実行方法に使えない */
  private content(input: unknown, current?: ObservationDefinition): DefinitionInput {
    const v = validateDefinitionInput(input);
    if (!v.ok) throw new DefinitionError("invalid", "観測の定義に誤りがあります", v.problems);
    const procedures = assignProcedureIds(v.value.procedures).map(({ history: _h, ...p }) => {
      const history = current?.procedures.find((c) => c.id === p.id)?.history;
      return history ? { ...p, history } : p;
    });
    const planned = procedures.flatMap((p, i) => (p.run.kind !== "ai-instruction" && p.run.kind !== "command" && this.files?.(p.run.repo, p.run.path) === "planned" ? [i] : []));
    if (planned.length) {
      throw new DefinitionError("invalid", "観測の定義に誤りがあります", planned.map((i) => ({ path: `procedures[${i}].run.path`, message: "このファイルはまだありません（新規予定）。今の実行方法には使えないので、置き換え候補に書いてください" })));
    }
    return { ...v.value, procedures };
  }

  async create(input: unknown, actor: string): Promise<ObservationDefinition> {
    const content = this.content(input);
    for (let i = 0; i < 20; i++) {
      const at = nowIso();
      const def: ObservationDefinition = { format: DEFINITION_FORMAT, id: `obs-${newRequestId()}`, rev: 1, ...content, createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor };
      if (await createExclusive(this.file(def.id), serialize(def))) return def;
    }
    throw new Error("観測の定義の ID を採番できませんでした（もう一度実行してください）");
  }

  /** 今の版（expectedRev）を添えて置き換える。違えば conflict（今の定義を添える）。読めないファイルは上書きしない */
  async update(id: string, expectedRev: number, input: unknown, actor: string): Promise<ObservationDefinition> {
    return this.change(id, expectedRev, actor, (current) => this.content(input, current));
  }

  /**
   * 手順を置き換え候補のスクリプトに切り替える。ファイルが参照先の中に有ること（files で照らす）・今の版・確かめた呼び出し方と結果の根拠が要る。
   * 今の実行方法と呼び出し方が同じ更新で切り替わり、置き換える前の実行方法は履歴に残る
   */
  async switchProcedure(id: string, expectedRev: number, pid: string, confirm: { invoke?: string; evidence?: string }, actor: string): Promise<ObservationDefinition> {
    return this.change(id, expectedRev, actor, (current) => {
      const i = current.procedures.findIndex((p) => p.id === pid);
      const p = current.procedures[i];
      const at = `procedures[${i}]`;
      if (!p) throw new DefinitionError("not_found", `手順がありません: ${pid}`);
      const rep = p.replacement;
      if (!rep) throw new DefinitionError("invalid", `手順 ${pid} に置き換え候補がありません`, [{ path: `${at}.replacement`, message: "置き換え候補がありません" }]);
      const invoke = confirm.invoke?.trim() || rep.invoke;
      const problems = [
        ...(this.files?.(rep.repo, rep.path) !== "exists" ? [{ path: `${at}.replacement.path`, message: `${rep.repo}:${rep.path} が参照先の中に有ることを確かめられません（${this.files ? "まだ無い・読めない" : "参照先を読めない"}）` }] : []),
        ...(!invoke ? [{ path: "invoke", message: "確かめた呼び出し方を書いてください" }] : []),
        ...(!confirm.evidence?.trim() ? [{ path: "evidence", message: "その呼び出し方で測定値が出ることを確かめた結果を書いてください" }] : []),
      ];
      if (problems.length) throw new DefinitionError("invalid", `手順 ${pid} を切り替えられません`, problems);
      const sw = { at: nowIso(), by: actor, from: p.run, invoke: invoke!, evidence: confirm.evidence!.trim() };
      const next = { id: p.id, title: p.title, measures: p.measures, run: { kind: rep.kind, repo: rep.repo, path: rep.path, invoke: invoke! }, history: [...(p.history ?? []), sw] };
      return { ...current, procedures: current.procedures.map((x, j) => (j === i ? next : x)) };
    });
  }

  /** 今の版（expectedRev）を確かめて置き換える。違えば conflict（今の定義を添える）。読めないファイルは上書きしない */
  private change(id: string, expectedRev: number, actor: string, f: (current: ObservationDefinition) => DefinitionInput): Promise<ObservationDefinition> {
    if (!Number.isInteger(expectedRev) || expectedRev < 1) throw new DefinitionError("invalid", "更新には今の定義の版（rev。1 以上の整数）を添えてください", [{ path: "rev", message: "今の定義の版を添えてください" }]);
    return withFileLock(this.lock, async () => {
      const current = await this.get(id);
      if (current.rev !== expectedRev) {
        throw new DefinitionError("conflict", `観測の定義 ${id} は更新されています（今の版 ${current.rev}・添えた版 ${expectedRev}）。読み直してからやり直してください`, [], current);
      }
      const { title, category, description, expected, measures, procedures } = f(current);
      const { expected: _old, ...rest } = current;
      const next: ObservationDefinition = { ...rest, title, category, description, ...(expected ? { expected } : {}), measures, procedures, format: DEFINITION_FORMAT, rev: current.rev + 1, updatedAt: nowIso(), updatedBy: actor };
      await writeFileAtomic(this.file(id), serialize(next));
      return next;
    }, { busyMessage: "観測の定義のロックを待ちきれませんでした（別のプロセスが更新しています）" });
  }
}

const serialize = (d: ObservationDefinition) => `${JSON.stringify(d, null, 2)}\n`;

/** 保存したファイルの中身を確かめる（形の版・ID・版・記録と、中身は登録と同じ検証） */
function parseStored(data: unknown, id: string): { ok: true; value: ObservationDefinition } | { ok: false; reason: string } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, reason: "オブジェクトではありません" };
  const d = data as Record<string, unknown>;
  if (d.format !== DEFINITION_FORMAT && d.format !== 1) return { ok: false, reason: `知らない形の版です（format: ${JSON.stringify(d.format)}。この p3 が読めるのは 1・${DEFINITION_FORMAT}）。新しい p3 で作ったものなら、p3 を更新してください` };
  if (d.id !== id) return { ok: false, reason: `ファイル名と ID が違います（id: ${JSON.stringify(d.id)}）` };
  if (!Number.isInteger(d.rev) || (d.rev as number) < 1) return { ok: false, reason: "定義の版（rev）が正しくありません" };
  for (const k of ["createdAt", "createdBy", "updatedAt", "updatedBy"]) if (typeof d[k] !== "string") return { ok: false, reason: `${k} がありません` };
  const { format: _f, id: _i, rev: _r, createdAt: _ca, createdBy: _cb, updatedAt: _ua, updatedBy: _ub, ...content } = d;
  // 形の版 1 は読むときに今の形にする（書くのは更新のとき）
  const v = validateDefinitionInput(d.format === 1 ? { ...content, procedures: migrateProcedures(content.procedures) } : content);
  if (!v.ok) return { ok: false, reason: `中身が正しくありません（${v.problems.map((p) => `${p.path}: ${p.message}`).join("・")}）` };
  return { ok: true, value: { format: DEFINITION_FORMAT, id, rev: d.rev as number, ...v.value, createdAt: d.createdAt as string, createdBy: d.createdBy as string, updatedAt: d.updatedAt as string, updatedBy: d.updatedBy as string } };
}
