import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createExclusive, newRequestId, nowIso, withFileLock, writeFileAtomic } from "@infodb/p3-shared/node/fsutil.ts";
import {
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

  constructor(readonly dataDir: string) {
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

  async create(input: unknown, actor: string): Promise<ObservationDefinition> {
    const v = validateDefinitionInput(input);
    if (!v.ok) throw new DefinitionError("invalid", "観測の定義に誤りがあります", v.problems);
    for (let i = 0; i < 20; i++) {
      const at = nowIso();
      const def: ObservationDefinition = { format: DEFINITION_FORMAT, id: `obs-${newRequestId()}`, rev: 1, ...v.value, createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor };
      if (await createExclusive(this.file(def.id), serialize(def))) return def;
    }
    throw new Error("観測の定義の ID を採番できませんでした（もう一度実行してください）");
  }

  /** 今の版（expectedRev）を添えて置き換える。違えば conflict（今の定義を添える）。読めないファイルは上書きしない */
  async update(id: string, expectedRev: number, input: unknown, actor: string): Promise<ObservationDefinition> {
    if (!Number.isInteger(expectedRev) || expectedRev < 1) throw new DefinitionError("invalid", "更新には今の定義の版（rev。1 以上の整数）を添えてください", [{ path: "rev", message: "今の定義の版を添えてください" }]);
    const v = validateDefinitionInput(input);
    if (!v.ok) throw new DefinitionError("invalid", "観測の定義に誤りがあります", v.problems);
    return withFileLock(this.lock, async () => {
      const current = await this.get(id);
      if (current.rev !== expectedRev) {
        throw new DefinitionError("conflict", `観測の定義 ${id} は更新されています（今の版 ${current.rev}・添えた版 ${expectedRev}）。読み直してからやり直してください`, [], current);
      }
      const next: ObservationDefinition = { ...current, ...v.value, rev: current.rev + 1, updatedAt: nowIso(), updatedBy: actor };
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
  if (d.format !== DEFINITION_FORMAT) return { ok: false, reason: `知らない形の版です（format: ${JSON.stringify(d.format)}。この p3 が読めるのは ${DEFINITION_FORMAT}）。新しい p3 で作ったものなら、p3 を更新してください` };
  if (d.id !== id) return { ok: false, reason: `ファイル名と ID が違います（id: ${JSON.stringify(d.id)}）` };
  if (!Number.isInteger(d.rev) || (d.rev as number) < 1) return { ok: false, reason: "定義の版（rev）が正しくありません" };
  for (const k of ["createdAt", "createdBy", "updatedAt", "updatedBy"]) if (typeof d[k] !== "string") return { ok: false, reason: `${k} がありません` };
  const { format: _f, id: _i, rev: _r, createdAt: _ca, createdBy: _cb, updatedAt: _ua, updatedBy: _ub, ...content } = d;
  const v = validateDefinitionInput(content);
  if (!v.ok) return { ok: false, reason: `中身が正しくありません（${v.problems.map((p) => `${p.path}: ${p.message}`).join("・")}）` };
  return { ok: true, value: { format: DEFINITION_FORMAT, id, rev: d.rev as number, ...v.value, createdAt: d.createdAt as string, createdBy: d.createdBy as string, updatedAt: d.updatedAt as string, updatedBy: d.updatedBy as string } };
}
