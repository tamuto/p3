import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createExclusive, nowIso, withFileLock, writeFileAtomic } from "@infodb/p3-shared/node/fsutil.ts";
import { byNewest, checkKeyInput, checkValueInput, keyProblem, SYSTEM_KEYS, SYSTEM_PREFIX, systemKey, type KeySummary, type MetricKey, type MetricValue, type Problem, type SystemKey } from "../shared/metric.ts";

/**
 * 観測の項目キーと値の保存（docs/architecture.md「p3-observer」の「保存」）。プロジェクトのデータのフォルダの observer/metrics/ だけを読み書きする
 * （以前の観測の observer/definitions などは読まない・消さない）。
 *   keys/<キー>.json    利用者が登録した項目キー（システムの項目は SYSTEM_KEYS で、ファイルを持たない）
 *   values/<キー>.json  その項目の値の全部（{ format, key, seq, values }。seq は振った最後の番号）
 * 書き込みは observer/metrics/.lock の中で、読み直した値に当てる（キーの変更・削除と値の追加が重なっても、値のあるキーを消す・形を変えることは起きない）。
 * ロックは同じマシンのプロセスの間だけで、複数のマシンでの同時の更新は項目キーの版の照合だけに頼る。
 */
const FORMAT = 1;

export type MetricErrorCode = "invalid" | "not_found" | "conflict" | "in_use" | "forbidden" | "unreadable";
export class MetricError extends Error {
  constructor(
    readonly code: MetricErrorCode,
    message: string,
    readonly problems: Problem[] = [],
    readonly current?: MetricKey,
  ) {
    super(message);
  }
}

interface ValuesFile {
  format: number;
  key: string;
  seq: number;
  values: MetricValue[];
}

export class MetricStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "observer", "metrics");
  }
  private keyPath = (key: string) => join(this.dir, "keys", `${key}.json`);
  private valuesPath = (key: string) => join(this.dir, "values", `${key}.json`);
  private lock = <T>(fn: () => Promise<T>) => withFileLock(join(this.dir, ".lock"), fn);

  /** 項目キーの一覧（システムの項目は値が無くても出す）・値に付いたマイルストーン（絞り込みの選択肢）・読めないファイル */
  async list(milestone?: string): Promise<{ keys: KeySummary[]; milestones: string[]; unreadable: { file: string; reason: string }[] }> {
    const unreadable: { file: string; reason: string }[] = [];
    const names = await readdir(join(this.dir, "keys")).catch(() => [] as string[]);
    const user: MetricKey[] = [];
    for (const n of names.filter((f) => f.endsWith(".json")).sort()) {
      try {
        user.push(await this.readKey(n.slice(0, -5)));
      } catch (e) {
        unreadable.push({ file: `keys/${n}`, reason: (e as Error).message });
      }
    }
    const keys: KeySummary[] = [];
    const milestones = new Set<string>();
    for (const k of [...SYSTEM_KEYS, ...user]) {
      try {
        const all = (await this.readValues(k.key)).values;
        for (const v of all) if (v.milestone) milestones.add(v.milestone);
        const values = this.filter(all, milestone);
        keys.push({ ...k, count: values.length, ...(values[0] ? { latest: values[0] } : {}) });
      } catch (e) {
        unreadable.push({ file: `values/${k.key}.json`, reason: (e as Error).message });
        keys.push({ ...k, count: 0 });
      }
    }
    return { keys, milestones: [...milestones].sort(), unreadable };
  }

  /** 項目キーと値（新しい順） */
  async get(key: string, milestone?: string): Promise<{ key: MetricKey; values: MetricValue[] }> {
    const k = await this.requireKey(key);
    return { key: k, values: this.filter((await this.readValues(k.key)).values, milestone) };
  }

  async createKey(input: Record<string, unknown>, actor: string): Promise<MetricKey> {
    const { value, problems } = checkKeyInput(input, true);
    if (!value) throw new MetricError("invalid", "項目キーを登録できません", problems);
    return this.lock(async () => {
      const at = nowIso();
      const k: MetricKey = { ...value, rev: 1, createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor };
      if (!(await createExclusive(this.keyPath(k.key), json({ format: FORMAT, ...k })))) {
        throw new MetricError("invalid", `項目キー ${k.key} はもうあります`, [{ path: "key", message: "同じ項目キーがもうあります" }]);
      }
      return k;
    });
  }

  /** 変える（rev は読んだときの版。違えば競合で今の定義を返す）。値があるあいだは値の形を変えられない */
  async updateKey(key: string, rev: number, input: Record<string, unknown>, actor: string): Promise<MetricKey> {
    this.checkUserKey(key, "変えられません");
    return this.lock(async () => {
      const cur = await this.requireKey(key);
      if (cur.rev !== rev) throw new MetricError("conflict", `項目キー ${key} はほかで変わりました（今の版 ${cur.rev}）。読み直してやり直してください`, [], cur);
      const { value, problems } = checkKeyInput({ ...input, key }, false);
      if (!value) throw new MetricError("invalid", "項目キーを変えられません", problems);
      if (value.type !== cur.type && (await this.readValues(key)).values.length) {
        throw new MetricError("in_use", `項目キー ${key} には値があるので、値の形を変えられません（先に値を消す）`, [{ path: "type", message: "値があるあいだは変えられません" }]);
      }
      const next: MetricKey = { ...value, key, rev: cur.rev + 1, createdAt: cur.createdAt, createdBy: cur.createdBy, updatedAt: nowIso(), updatedBy: actor };
      await writeFileAtomic(this.keyPath(key), json({ format: FORMAT, ...next }));
      return next;
    });
  }

  /** 消す。値があれば断る（先に値を消す） */
  async deleteKey(key: string, rev: number): Promise<void> {
    this.checkUserKey(key, "消せません");
    await this.lock(async () => {
      const cur = await this.requireKey(key);
      if (cur.rev !== rev) throw new MetricError("conflict", `項目キー ${key} はほかで変わりました（今の版 ${cur.rev}）。読み直してやり直してください`, [], cur);
      const n = (await this.readValues(key)).values.length;
      if (n) throw new MetricError("in_use", `項目キー ${key} には値が ${n} 件あるので消せません（先に値を消す）`);
      await unlink(this.keyPath(key));
      await unlink(this.valuesPath(key)).catch(() => {});
    });
  }

  /** 利用者の値を足す（システムの項目には足せない） */
  async addValue(key: string, input: Record<string, unknown>, actor: string): Promise<MetricValue> {
    this.checkUserKey(key, "値を手で足せません");
    return this.lock(async () => {
      const k = await this.requireKey(key);
      const { value, problems } = checkValueInput(k.type, input, nowIso());
      if (!value) throw new MetricError("invalid", `項目キー ${key} に値を足せません`, problems);
      return this.append(key, value, actor);
    });
  }

  /** 利用者の値を消す（システムの値は消せない） */
  async deleteValue(key: string, id: string): Promise<void> {
    this.checkUserKey(key, "値を手で消せません");
    await this.lock(async () => {
      await this.requireKey(key);
      const f = await this.readValues(key);
      if (!f.values.some((v) => v.id === id)) throw new MetricError("not_found", `項目キー ${key} に値 ${id} はありません`);
      await writeFileAtomic(this.valuesPath(key), json({ ...f, values: f.values.filter((v) => v.id !== id) }));
    });
  }

  /**
   * システムの値を記録する（tasks の操作のその場で呼ぶ）。once のときは、同じ対象の値が既にあれば記録しない（重なりの確かめと追加を同じロックの中で行う）。
   * 記録しなかったら undefined
   */
  async recordSystem(key: SystemKey, v: { value: number; target: string; milestone?: string; by?: string }, opts: { once?: boolean } = {}): Promise<MetricValue | undefined> {
    const k = systemKey(key);
    if (!k) throw new MetricError("not_found", `システムの項目 ${key} はありません`);
    return this.lock(async () => {
      if (opts.once && (await this.readValues(key)).values.some((x) => x.target === v.target)) return undefined;
      const at = nowIso();
      return this.append(key, { at, value: v.value, target: v.target, ...(v.milestone ? { milestone: v.milestone } : {}) }, v.by ?? "p3");
    });
  }

  private async append(key: string, value: Omit<MetricValue, "id" | "by" | "recordedAt">, by: string): Promise<MetricValue> {
    const f = await this.readValues(key);
    const seq = f.seq + 1;
    const v: MetricValue = { id: `V${seq}`, ...value, by, recordedAt: nowIso() };
    await writeFileAtomic(this.valuesPath(key), json({ format: FORMAT, key, seq, values: [...f.values, v] }));
    return v;
  }

  private checkUserKey(key: string, what: string) {
    if (key.startsWith(SYSTEM_PREFIX)) throw new MetricError("forbidden", `${key} はシステムの項目なので${what}（p3 が記録します）`);
  }

  private filter = (values: MetricValue[], milestone?: string) => (milestone ? values.filter((v) => v.milestone === milestone) : values).slice().sort(byNewest);

  private async requireKey(key: string): Promise<MetricKey> {
    const sys = systemKey(key);
    if (sys) return sys;
    if (keyProblem(key)) throw new MetricError("not_found", `項目キー ${key} はありません`);
    return this.readKey(key);
  }

  private async readKey(key: string): Promise<MetricKey> {
    const text = await readFile(this.keyPath(key), "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new MetricError("not_found", `項目キー ${key} はありません`);
      throw e;
    });
    const raw = parse(text, `keys/${key}.json`);
    if (raw.format !== FORMAT || raw.key !== key || typeof raw.rev !== "number") throw new MetricError("unreadable", `keys/${key}.json の形が違います（format ${String(raw.format)}）`);
    const { value, problems } = checkKeyInput(raw, true);
    if (!value) throw new MetricError("unreadable", `keys/${key}.json が読めません: ${problems.map((p) => `${p.path}: ${p.message}`).join(" / ")}`);
    const meta = (k: "createdAt" | "createdBy" | "updatedAt" | "updatedBy") => (typeof raw[k] === "string" ? { [k]: raw[k] } : {});
    return { ...value, rev: raw.rev, ...meta("createdAt"), ...meta("createdBy"), ...meta("updatedAt"), ...meta("updatedBy") };
  }

  private async readValues(key: string): Promise<ValuesFile> {
    const text = await readFile(this.valuesPath(key), "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (text === undefined) return { format: FORMAT, key, seq: 0, values: [] };
    const raw = parse(text, `values/${key}.json`);
    if (raw.format !== FORMAT || raw.key !== key || typeof raw.seq !== "number" || !Array.isArray(raw.values)) {
      throw new MetricError("unreadable", `values/${key}.json の形が違います（format ${String(raw.format)}）。上書きしません`);
    }
    return raw as unknown as ValuesFile;
  }
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

function parse(text: string, file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // 下で断る
  }
  throw new MetricError("unreadable", `${file} が JSON として読めません。上書きしません`);
}
