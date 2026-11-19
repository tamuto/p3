import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";

/**
 * データのフォルダの監視（補助）。外からの編集（エディタ・AI・Codex・git pull）を画面に早く出すためのもので、正しさはこれに頼らない
 * （画面の「再読み込み」reloadAll で保証する）。そのため、監視が壊れても serve と実行中の Preflight は止めない。
 *
 * fs.promises.watch は使わない: Node 22 の Linux の再帰監視（JS の実装 internal/fs/recursive_watch）は、見張っている途中で
 * フォルダが消えると（Preflight が drafts/ を作り直すときなど）ウォッチャーに 'error' を出す。promises.watch の非同期イテレータは
 * 'error' を聞かないので、未処理の 'error' イベントとしてプロセスごと落ちる（for await の try/catch には届かない）。
 * ここではコールバック式の fs.watch を自分で持ち、'error' を必ず受け止める。
 *
 * 失敗のときの決まり（docs/architecture.md の「データのフォルダの監視」）:
 *   - 入れ子のフォルダ・ファイルが消えた ENOENT（データのフォルダ自体はある）: 一時的なものとして監視を続ける。ログは間引く
 *   - それ以外の監視中のエラー・開始の失敗: 監視を閉じ、待ってから立て直す（retryMs から倍にして maxRetryMs まで）
 *   - 続けて maxFailures 回失敗したら、立て直しをやめてログに残す（API と再読み込みはそのまま使える）。
 *     stableMs より長く動いた後の失敗は、続けての失敗に数えない
 *   - 変更を読み込む処理（onChange）の失敗はログに残すだけ（次の変更か再読み込みで反映）
 *   - close の後は、監視・遅らせた通知・立て直しの予定を全部やめ、何も起こさない
 */
export interface DataWatcherOptions {
  /** 監視の作り方（テストが失敗を起こすために差し替える。既定は node:fs の watch） */
  watch?: (dir: string, options: { recursive: true; persistent: boolean }, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher;
  /** ログ（既定は console.error） */
  log?: (message: string) => void;
  /** 同じファイルの続けての変更をまとめる時間 */
  debounceMs?: number;
  retryMs?: number;
  maxRetryMs?: number;
  maxFailures?: number;
  stableMs?: number;
  /** 一時的な ENOENT のログを間引く間隔 */
  quietMs?: number;
}

export const WATCH_DEFAULTS = { debounceMs: 80, retryMs: 1_000, maxRetryMs: 30_000, maxFailures: 5, stableMs: 60_000, quietMs: 60_000 } as const;

export type WatchState = "idle" | "watching" | "retrying" | "stopped" | "closed";

export class DataWatcher {
  private watcher: FSWatcher | undefined;
  private pending = new Map<string, NodeJS.Timeout>();
  private retryTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private startedAt = 0;
  private lastQuietLog = 0;
  private quieted = 0;
  private closed = false;
  state: WatchState = "idle";
  private readonly o: Required<Omit<DataWatcherOptions, "watch" | "log">> & Pick<Required<DataWatcherOptions>, "watch" | "log">;

  constructor(
    readonly dir: string,
    /** データのフォルダからの相対パスの変更 */
    private onChange: (rel: string) => Promise<void> | void,
    options: DataWatcherOptions = {},
  ) {
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as DataWatcherOptions;
    this.o = { ...WATCH_DEFAULTS, watch: fsWatch, log: (m) => console.error(m), ...given };
  }

  start() {
    if (this.closed || this.watcher) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    let w: FSWatcher;
    try {
      w = this.o.watch(this.dir, { recursive: true, persistent: true }, (_event, filename) => this.changed(filename));
    } catch (e) {
      this.fail(e, "監視を始められません");
      return;
    }
    // 'error' は必ず聞く（聞かないと未処理のイベントとしてプロセスが落ちる）
    w.on("error", (e) => this.onError(w, e));
    this.watcher = w;
    this.startedAt = Date.now();
    this.state = "watching";
  }

  close() {
    this.closed = true;
    this.state = "closed";
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.dropWatcher();
  }

  private changed(filename: string | Buffer | null) {
    if (this.closed || !filename) return;
    const f = String(filename);
    if (f.endsWith(".tmp") || f.includes(".archive")) return;
    clearTimeout(this.pending.get(f));
    this.pending.set(
      f,
      setTimeout(() => {
        this.pending.delete(f);
        if (this.closed) return;
        Promise.resolve()
          .then(() => this.onChange(f))
          .catch((e) => this.o.log(`[watch] ${this.dir}: 変更の読み込みに失敗しました（${f}）。次の変更か画面の「再読み込み」で反映します: ${message(e)}`));
      }, this.o.debounceMs),
    );
  }

  private onError(w: FSWatcher, e: unknown) {
    if (this.closed || w !== this.watcher) return;
    // 入れ子のフォルダ・ファイルが見ている途中で消えた（データのフォルダはある）: 監視は続く
    if (code(e) === "ENOENT" && existsSync(this.dir)) {
      const now = Date.now();
      if (now - this.lastQuietLog >= this.o.quietMs) {
        const more = this.quieted ? `（ほかに ${this.quieted} 件）` : "";
        this.o.log(`[watch] ${this.dir}: 見ている途中でフォルダかファイルが消えました。監視は続けます${more}: ${message(e)}`);
        this.lastQuietLog = now;
        this.quieted = 0;
      } else this.quieted++;
      return;
    }
    this.fail(e, "監視でエラーが起きました");
  }

  private fail(e: unknown, what: string) {
    this.dropWatcher();
    if (this.closed) return;
    if (this.startedAt && Date.now() - this.startedAt >= this.o.stableMs) this.failures = 0;
    this.startedAt = 0;
    this.failures++;
    if (this.failures > this.o.maxFailures) {
      this.state = "stopped";
      this.o.log(
        `[watch] ${this.dir}: ${what}。続けて ${this.o.maxFailures + 1} 回失敗したので監視をやめます（serve は続きます。外での変更は画面の「再読み込み」で反映してください）: ${message(e)}`,
      );
      return;
    }
    const wait = Math.min(this.o.retryMs * 2 ** (this.failures - 1), this.o.maxRetryMs);
    this.state = "retrying";
    this.o.log(`[watch] ${this.dir}: ${what}。${wait} ミリ秒後に立て直します（${this.failures}/${this.o.maxFailures}）: ${message(e)}`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.start();
    }, wait);
  }

  private dropWatcher() {
    const w = this.watcher;
    this.watcher = undefined;
    if (!w) return;
    try {
      w.close();
    } catch {
      // 閉じるのに失敗しても、もう使わない
    }
  }
}

const code = (e: unknown) => (e && typeof e === "object" && "code" in e ? String(e.code) : undefined);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
