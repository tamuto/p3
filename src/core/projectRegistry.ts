import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ChatGptAccount } from "./chatgpt.ts";
import { openProject, type P3Context } from "./context.ts";
import type { SettingsSource } from "./machineSettings.ts";
import { inspectUserProjects, PROJECT_NAME, userConfigPath, type InvalidProjectEntry, type UserProject } from "./userConfig.ts";

/**
 * プロジェクトを跨ぐ serve（p3 serve --all-projects）が扱うプロジェクト。個人設定に登録した名前だけを対象にし、
 * 任意のパスは開かない。
 *
 *   - 一覧は refresh（明示の再取得）で個人設定から読み直す。壊れた・読めない個人設定は登録0件と区別して configError に、
 *     形の違う登録は invalid に理由を付けて出し、ほかの登録は使えるようにする
 *   - 開くのは使うとき（open）。同時に開こうとしたら1回にまとめ、失敗したら覚えずに次の open でやり直す（直したら戻る）
 *   - 同じデータのフォルダ（実体のパス）を複数の名前で登録していたら、どれも開かない（Preflight・生成を二重に動かさない）
 *   - 登録世代（generation）: 読み直したときに登録が無くなっていた・データのフォルダが変わっていたら変わる（読み直すまでの間に
 *     外して同じフォルダで付け直したものは同じ登録。書く先は同じ）。画面は変える操作に世代を添え、違えば断る（古い画面の保存を
 *     新しい登録先へ流さない）。参照先のパスだけの変更は今の文脈に反映して世代は変えない
 *   - 登録から外れた文脈には新しい要求を渡さず、実行中の Preflight・生成が終わるのを待ってから閉じる（取り消さない）
 */

export type RegistryErrorCode = "unknown" | "changed" | "duplicate" | "unavailable";

/** 開けない（unknown: 登録に無い / changed: 登録世代が違う / duplicate: 同じデータを複数の名前で登録 / unavailable: 開けない） */
export class RegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectListItem {
  name: string;
  generation: string;
  /** ok: 開ける（開いていなくてもよい） / error: 開けない（理由は error） */
  state: "ok" | "error";
  error?: string;
  /** 文脈を開いている */
  open: boolean;
}

export interface ProjectListing {
  projects: ProjectListItem[];
  invalid: InvalidProjectEntry[];
  /** 個人設定を読めない・壊れている（登録0件とは別） */
  configError?: string;
}

interface Entry {
  name: string;
  dir: string;
  repos: Record<string, string>;
  generation: string;
  /** 同じデータを別の名前でも登録している */
  duplicate?: string;
  ctx?: Promise<P3Context>;
  /** 直前に開けなかった理由（次の open でやり直す） */
  error?: string;
}

export interface RegistryOptions {
  settings: SettingsSource;
  /** サインインの待ち受け（全プロジェクトで1つ） */
  chatgpt: ChatGptAccount;
  configPath?: string;
  /** 開き方（テストで差し替える） */
  open?: typeof openProject;
}

export class ProjectRegistry {
  private entries = new Map<string, Entry>();
  private invalid: InvalidProjectEntry[] = [];
  private configError?: string;
  private counter = 0;
  private refreshing: Promise<ProjectListing> = Promise.resolve({ projects: [], invalid: [] });
  /** 登録から外れて、実行中の処理が終わるのを待っている文脈 */
  private retiring = new Set<Promise<void>>();
  private listeners = new Set<(kind: "projects" | "user" | "chatgpt") => void>();
  private closed = false;

  constructor(private opts: RegistryOptions) {}

  get chatgpt(): ChatGptAccount {
    return this.opts.chatgpt;
  }

  /** 個人設定から一覧を読み直す（同時に呼ばれたら順に） */
  refresh(): Promise<ProjectListing> {
    this.refreshing = this.refreshing.then(
      () => this.load(),
      () => this.load(),
    );
    return this.refreshing;
  }

  list(): ProjectListing {
    const projects = [...this.entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e): ProjectListItem => {
        const error = e.duplicate ?? e.error;
        return { name: e.name, generation: e.generation, state: error ? "error" : "ok", ...(error ? { error } : {}), open: !!e.ctx };
      });
    return { projects, invalid: this.invalid, ...(this.configError ? { configError: this.configError } : {}) };
  }

  /** 登録した名前の文脈（必要なら開く）。generation を渡したら、今の登録世代と同じときだけ */
  async open(name: string, generation?: string): Promise<P3Context> {
    if (this.closed) throw new RegistryError("unavailable", "serve を止めています");
    const e = PROJECT_NAME.test(name) ? this.entries.get(name) : undefined;
    if (!e) throw new RegistryError("unknown", `プロジェクト「${name}」は個人設定に登録されていません（p3 project ls で確かめ、画面の一覧を読み直してください）`);
    if (generation !== undefined && generation !== e.generation) {
      throw new RegistryError("changed", `プロジェクト「${name}」の登録が変わりました（外した・付け直した・データのフォルダを変えた）。一覧を読み直して選び直してください（入力は送っていません）`);
    }
    if (e.duplicate) throw new RegistryError("duplicate", e.duplicate);
    if (!e.ctx) {
      e.ctx = (this.opts.open ?? openProject)(e.dir, { repos: e.repos, settings: this.opts.settings, projectName: e.name, chatgpt: this.opts.chatgpt });
      e.ctx.then(
        (ctx) => {
          e.error = undefined;
          void ctx.ws.watch();
          // 開いている間に登録から外れた・変わった: 新しい要求には使わせず閉じる
          if (this.entries.get(name) !== e || this.closed) this.retire(ctx);
        },
        (err: Error) => {
          // 覚えずに次の open でやり直す（フォルダを戻した・共有ドライブをつないだら使える）
          if (this.entries.get(name) === e) {
            e.ctx = undefined;
            e.error = err.message;
          }
        },
      );
    }
    try {
      const ctx = await e.ctx;
      if (this.entries.get(name) !== e) throw new RegistryError("changed", `プロジェクト「${name}」の登録が変わりました。一覧を読み直して選び直してください`);
      return ctx;
    } catch (err) {
      if (err instanceof RegistryError) throw err;
      throw new RegistryError("unavailable", `プロジェクト「${name}」を開けません: ${(err as Error).message}`);
    }
  }

  /** 開いている文脈（変更の知らせを全部へ流すため） */
  async openContexts(): Promise<P3Context[]> {
    const opened = await Promise.allSettled([...this.entries.values()].flatMap((e) => (e.ctx ? [e.ctx] : [])));
    return opened.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  }

  /** プロジェクトに属さない変更（一覧・テーマ・ChatGPT の接続）を知らせる。開いている全プロジェクトの画面にも流す */
  notify(kind: "projects" | "user" | "chatgpt") {
    for (const l of this.listeners) l(kind);
    if (kind === "projects") return;
    void this.openContexts().then((all) => all.forEach((ctx) => ctx.ws.emit({ type: "changed", kind })));
  }

  on(listener: (kind: "projects" | "user" | "chatgpt") => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 止める。新しい要求は断り、実行中の Preflight・生成を取り消して終わるまで待つ（timeoutMs まで）。監視を外す。
   * 待ちきれなかった数を返す
   */
  async close(opts: { timeoutMs?: number } = {}): Promise<{ pending: number }> {
    this.closed = true;
    const all = await this.openContexts();
    for (const e of this.entries.values()) e.ctx = undefined;
    const settle = Promise.all([
      ...all.map(async (ctx) => {
        await Promise.all([ctx.preflight.settle({ cancel: true }), ctx.releaseGenerator.settle({ cancel: true })]);
        ctx.ws.close();
      }),
      ...this.retiring,
    ]).then(() => false);
    const timedOut = await Promise.race([settle, new Promise<boolean>((r) => setTimeout(() => r(true), opts.timeoutMs ?? 10_000).unref())]);
    for (const ctx of all) ctx.ws.close();
    return { pending: timedOut ? all.reduce((n, c) => n + c.preflight.running() + c.releaseGenerator.running(), 0) : 0 };
  }

  private async load(): Promise<ProjectListing> {
    let projects: Record<string, UserProject>;
    try {
      const r = await inspectUserProjects(this.opts.configPath ?? userConfigPath());
      projects = r.projects;
      this.invalid = r.invalid;
      this.configError = undefined;
    } catch (e) {
      // 読めない・壊れている: 今の一覧と開いている文脈はそのまま（直して読み直せば戻る）
      this.configError = (e as Error).message;
      return this.list();
    }
    const before = this.list();
    for (const [name, e] of this.entries) {
      const next = projects[name];
      if (!next || next.dir !== e.dir) this.drop(name, e);
    }
    for (const [name, p] of Object.entries(projects)) {
      const cur = this.entries.get(name);
      if (cur) {
        // 参照先のパスだけの変更は今の文脈に反映する（次の Preflight から使う）
        if (JSON.stringify(cur.repos) !== JSON.stringify(p.repos)) {
          const old = cur.repos;
          cur.repos = { ...p.repos };
          void cur.ctx?.then((ctx) => {
            for (const k of Object.keys(old)) if (!(k in p.repos)) ctx.ws.setLocalRepo(k, null);
            for (const [k, v] of Object.entries(p.repos)) if (old[k] !== v) ctx.ws.setLocalRepo(k, v);
          }, () => undefined);
        }
        continue;
      }
      this.entries.set(name, { name, dir: p.dir, repos: { ...p.repos }, generation: this.nextGeneration(p.dir) });
    }
    await this.markDuplicates();
    const after = this.list();
    if (JSON.stringify(before) !== JSON.stringify(after)) this.notify("projects");
    return after;
  }

  /** 登録から外す。新しい要求には使わせず、実行中の処理が終わってから閉じる */
  private drop(name: string, e: Entry) {
    this.entries.delete(name);
    void e.ctx?.then((ctx) => this.retire(ctx), () => undefined);
  }

  private retire(ctx: P3Context) {
    const p = Promise.all([ctx.preflight.settle(), ctx.releaseGenerator.settle()]).then(() => ctx.ws.close());
    this.retiring.add(p);
    void p.finally(() => this.retiring.delete(p));
  }

  /** 同じ実体のフォルダを指す登録は、どれも開かない（どれを使うかは人が個人設定で決める） */
  private async markDuplicates() {
    const real = new Map<string, string[]>();
    for (const e of this.entries.values()) {
      const key = await realpath(e.dir).catch(() => e.dir);
      real.set(key, [...(real.get(key) ?? []), e.name]);
    }
    for (const names of real.values()) {
      for (const name of names) {
        const e = this.entries.get(name)!;
        const was = e.duplicate;
        e.duplicate =
          names.length > 1
            ? `同じデータのフォルダを複数の名前で登録しています: ${names.join(", ")}（二重に動かさないため、どれも開きません。p3 project rm <名前> で1つにしてください）`
            : undefined;
        // 重なりを外して開けるようになったら、別の登録として世代を変える
        if (was && !e.duplicate) e.generation = this.nextGeneration(e.dir);
        if (!was && e.duplicate && e.ctx) {
          const ctx = e.ctx;
          e.ctx = undefined;
          void ctx.then((c) => this.retire(c), () => undefined);
        }
      }
    }
  }

  private nextGeneration(dir: string): string {
    this.counter += 1;
    return `${createHash("sha256").update(dir).digest("hex").slice(0, 8)}-${this.counter}`;
  }
}
