import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ACCESS_TOKEN_ENV,
  CONTAINER_WORKSPACE,
  DEFAULT_IMAGE,
  UsageLimitError,
  WorkspaceSession,
  dockerCommand,
  type WorkspaceEvent,
} from "@infodb/codex-workspace";
import { APP_NAME, chatgptAccount, ChatGptAuthError, CODEX_TOKEN_MIN_VALID_MS, type ChatGptAccount } from "../chatgpt.ts";
import type { MachineSettings } from "../machineSettings.ts";
import { redact } from "../redact.ts";
import { ensureCodexImage } from "./codexImage.ts";
import { renderManuscripts, type Renderer } from "./uiRender.ts";
import { describeMapping, diagnoseLaunch, mapPath, type PathMapping } from "./diagnose.ts";
import { prepareLaunch } from "./launch.ts";
import { hideConfigPath } from "../userConfig.ts";
import { CONTAINER_DATA, containerEnv, developerInstructions, entryMissing, preflightPrompt } from "./instructions.ts";
import { type EngineOutcome, type EngineStatus, type PreflightEngine, type PreflightJob } from "./engine.ts";

const run = promisify(execFile);

/** initialize で名乗る版（P3 の package.json） */
const P3_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** どの認証で Codex を動かすか（docs/chatgpt-sign-in.md の「Preflight」） */
export type CodexAuth =
  | { mode: "chatgpt"; email?: string }
  | { mode: "legacy" }
  | { mode: "none"; reason: string };

export interface CodexWorkspaceConfig {
  /** 旧来: Codex の初期設定でサインインした auth.json（Docker ボリューム / ホストのファイル） */
  authVolume?: string;
  authFile?: string;
  /** codex.auth: legacy（P3_CODEX_AUTH=legacy）: ChatGPT に接続していても旧来の auth.json を使う */
  forceLegacy?: boolean;
  /** Sign in with ChatGPT の接続（既定は個人設定の chatgpt.json） */
  account?: ChatGptAccount;
  model?: string;
  effort?: string;
  /** "ローカル=ホスト" の対応（カンマ区切り）。Docker デーモンから見たパスへ変換する */
  pathMap: [string, string][];
  ensureImage: boolean;
  /** app-server を起こすコマンド（既定は codex-workspace の docker run）。テストで偽の app-server に差し替える。data: null はデータのフォルダを渡さない（ask） */
  command?: (m: { repos: HostMount[]; data: string | null; auth: CodexAuth["mode"] }) => string[];
  /** テスト用: 画面イメージの描画を差し替える（既定は描画のコンテナ） */
  render?: Renderer;
}

/** マシンごとの設定（環境変数と個人設定。→ machineSettings.ts）から */
export function codexConfig({ codex }: MachineSettings): CodexWorkspaceConfig {
  return {
    authVolume: codex.authVolume,
    authFile: codex.authFile,
    forceLegacy: codex.auth === "legacy",
    model: codex.model,
    effort: codex.effort,
    pathMap: codex.pathMap,
    ensureImage: codex.ensureImage,
  };
}

type Log = Parameters<PreflightEngine["run"]>[1];

/** 状態をためるときの鍵（設定が変われば確かめ直す） */
const settingsKey = (c: CodexWorkspaceConfig) =>
  JSON.stringify([c.authVolume, c.authFile, c.forceLegacy, c.model, c.effort, c.pathMap, c.ensureImage]);

/** 参照先1つのマウント（Docker のホストのパス → コンテナの中のパス。読むだけ） */
export interface HostMount {
  name: string;
  host: string;
  container: string;
}

/** dockerCommand に渡す仮のリポジトリ（ここを tmpfs に置き換える） */
const PLACEHOLDER = "/p3-placeholder";

/**
 * codex-workspace の docker run のマウントを、P3 の形にする:
 *   /workspace         tmpfs（Codex の cwd。何も置かない）
 *   /workspace/<名前>   参照先（読むだけ。リポジトリでもフォルダでもよい）
 *   /data              データのフォルダ（run のフォルダに書く）。null なら渡さない（ask: tmpfs だけ）
 */
export function withMounts(command: string[], repos: HostMount[], data: string | null): string[] {
  const at = command.indexOf(`type=bind,src=${PLACEHOLDER},dst=${CONTAINER_WORKSPACE}`);
  if (at < 0) throw new Error("codex-workspace の docker run にリポジトリのマウントが見つかりません");
  return [
    ...command.slice(0, at),
    `type=tmpfs,dst=${CONTAINER_WORKSPACE}`,
    ...repos.flatMap((r) => ["--mount", `type=bind,src=${r.host},dst=${r.container},readonly`]),
    ...(data === null ? [] : ["--mount", `type=bind,src=${data},dst=${CONTAINER_DATA}`]),
    ...command.slice(at + 1),
  ];
}

/**
 * Codex が返す変更のパス（/data/...・/workspace/<名前>/...・cwd の /workspace からの相対）をローカルの絶対パスへ戻す。
 * 参照先に当たらない /workspace の中（tmpfs）はコンテナの中のパスのまま返す（想定外の変更として知らせる）
 */
function localPath(job: PreflightJob, p: string) {
  if (p === CONTAINER_DATA || p.startsWith(`${CONTAINER_DATA}/`)) return join(job.dataDir, p.slice(CONTAINER_DATA.length));
  const abs = p.startsWith("/") ? p : `${CONTAINER_WORKSPACE}/${p}`;
  for (const r of job.refs) {
    const base = `${CONTAINER_WORKSPACE}/${r.mount}`;
    if (r.local && (abs === base || abs.startsWith(`${base}/`))) return join(r.local, abs.slice(base.length));
  }
  return abs;
}

/**
 * llmcs の codex-workspace（TypeScript 版。npm の @infodb/codex-workspace）で、Docker コンテナ内の
 * codex app-server に preflight を頼む。
 *
 * コンテナには管理対象リポジトリが /workspace、データディレクトリが /data としてマウントされる。
 * Codex はリポジトリのコードを読み、/data の中の run ディレクトリへ評価とタスク案のファイルを書く。
 * データディレクトリはリポジトリの外にあってもよい。
 */
export class CodexWorkspaceEngine implements PreflightEngine {
  readonly name = "codex" as const;

  private readonly account: ChatGptAccount;
  private readonly source: () => Promise<CodexWorkspaceConfig>;
  /** 最後に読めた設定（auth() の既定に使う） */
  private cfg: CodexWorkspaceConfig;

  /**
   * cfg: 決まった設定か、読むたびに今の設定を返す関数（serve: 個人設定を Preflight を始めるたび・状態を見るたびに読み直す）。
   * account（ChatGPT の接続）は関数が返す値ではなく、ここで渡したもの（無ければ既定）を共有する
   */
  constructor(cfg: CodexWorkspaceConfig | { load: () => Promise<CodexWorkspaceConfig>; account?: ChatGptAccount }) {
    if ("load" in cfg) {
      this.account = cfg.account ?? chatgptAccount();
      this.source = cfg.load;
      this.cfg = { pathMap: [], ensureImage: true };
    } else {
      this.account = cfg.account ?? chatgptAccount();
      this.source = async () => cfg;
      this.cfg = cfg;
    }
  }

  async snapshot(): Promise<PreflightEngine> {
    let cfg: CodexWorkspaceConfig;
    try {
      cfg = await this.config();
    } catch (e) {
      throw new Error(`個人設定を読めないので Preflight を始めません（Docker は起動していません）: ${hideConfigPath(e)}`, { cause: e });
    }
    return new CodexWorkspaceEngine({ ...cfg, account: this.account });
  }

  /** 今の設定（読めなければ SettingsError など。その Preflight は始めない） */
  private async config(): Promise<CodexWorkspaceConfig> {
    this.cfg = await this.source();
    return this.cfg;
  }

  private checked?: { at: number; key: string; status: EngineStatus };

  /**
   * 認証の選び方: 1. P3_CODEX_AUTH=legacy と旧来の設定 → 旧来 / 2. ChatGPT に接続済み → ChatGPT /
   * 3. 旧来の設定だけ → 旧来（移行期間の互換）/ 4. どれも無い → 使えない（サインインを案内する）
   */
  async auth(cfg: CodexWorkspaceConfig = this.cfg): Promise<CodexAuth> {
    const legacy = !!(cfg.authVolume || cfg.authFile);
    if (cfg.forceLegacy && legacy) return { mode: "legacy" };
    const s = await this.account.status();
    if (s.connected) {
      if (!s.planAllowed) return { mode: "none", reason: "ChatGPT プランの利用が許可されていません。もう一度サインインして、プランの利用に同意してください" };
      return { mode: "chatgpt", email: s.email };
    }
    if (legacy) return { mode: "legacy" };
    return {
      mode: "none",
      reason: s.registered
        ? "ChatGPT の接続が切れています。サインインし直してください（設定画面の「Continue with ChatGPT」か p3 chatgpt login）"
        : "ChatGPT にサインインしてください（設定画面の「Continue with ChatGPT」か p3 chatgpt login）",
    };
  }

  /**
   * 使えるか: Docker が動くか、認証情報（ボリューム / ファイル）があるか、イメージがあるか。
   * イメージが無くても、初回の Preflight で作るので使える扱いにする。結果は1分ためる。
   */
  async status(): Promise<EngineStatus> {
    let cfg: CodexWorkspaceConfig;
    try {
      cfg = await this.config();
    } catch (e) {
      // 個人設定が読めない: 直す場所を出す（ためない。直せば次の問い合わせで戻る）
      this.checked = undefined;
      return { name: "codex", ok: false, detail: `個人設定を読めないので Preflight を始められません: ${(e as Error).message}` };
    }
    // 接続のファイルが変われば（CLI でサインイン・解除した）・個人設定が変われば、すぐ確かめ直す
    const key = `${await this.account.mtime()}:${settingsKey(cfg)}`;
    if (this.checked && this.checked.key === key && Date.now() - this.checked.at < 60_000) return this.checked.status;
    const auth = await this.auth(cfg);
    const ng = (detail: string): EngineStatus => ({ name: "codex", ok: false, detail, auth: auth.mode });
    let status: EngineStatus;
    try {
      if (auth.mode === "none") throw new Error(auth.reason);
      await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
      if (cfg.authVolume) {
        await run("docker", ["volume", "inspect", cfg.authVolume], { timeout: 5000 }).catch(() => {
          throw new Error(`認証情報のボリューム ${cfg.authVolume} がありません`);
        });
      }
      const image = await run("docker", ["image", "inspect", "--format", "{{.Created}}", DEFAULT_IMAGE], { timeout: 5000 })
        .then((r) => `イメージ ${DEFAULT_IMAGE}（${r.stdout.trim().slice(0, 10)} 作成）`)
        .catch(() => `イメージ ${DEFAULT_IMAGE} は初回の実行で作ります`);
      const by =
        auth.mode === "chatgpt"
          ? `ChatGPT プラン（${auth.email ?? "サインイン済み"}）`
          : `旧来の認証 ${cfg.authVolume ? `ボリューム ${cfg.authVolume}` : cfg.authFile}`;
      status = {
        name: "codex",
        ok: true,
        auth: auth.mode,
        account: auth.mode === "chatgpt" ? auth.email : undefined,
        detail: `Codex（codex-workspace）で評価します · ${by} · ${image}${cfg.model ? ` · モデル ${cfg.model}` : ""}`,
      };
    } catch (e) {
      const msg = (e as NodeJS.ErrnoException).code === "ENOENT" ? "docker コマンドがありません" : (e as Error).message.split("\n")[0];
      status = ng(`Codex を使えません: ${msg}`);
    }
    this.checked = { at: Date.now(), key, status };
    return status;
  }

  hostPath(local: string): string {
    return mapPath(this.cfg.pathMap, local).host;
  }

  async run(job: PreflightJob, log: Log, signal: AbortSignal): Promise<EngineOutcome> {
    return this.authorized("Preflight", log, (a) => this.runWith(a.cfg, job, a.auth, a.env, a.log, signal));
  }

  /**
   * Preflight 以外の1回の頼みごと（リリースノートの要約など）。設定・認証・イメージ・起動の診断は Preflight と同じものを使い、
   * 参照先もデータのフォルダもマウントしない（/workspace は空の tmpfs で、終われば消える）。渡すのは依頼文だけで、
   * 結果は最後の応答の文。評価やタスク化はしない。結果を確かめて取り込むのは呼ぶ側
   */
  async ask(input: { instructions: string; prompt: string; label: string }, log: Log, signal: AbortSignal): Promise<AskResult> {
    return this.authorized(input.label, log, async ({ cfg, auth, env, log }) => {
      await this.prepareImage(cfg, log);
      const command =
        cfg.command?.({ repos: [], data: null, auth: auth.mode }) ??
        withMounts(dockerCommand(PLACEHOLDER, auth.mode === "chatgpt" ? { accessTokenEnv: ACCESS_TOKEN_ENV } : { authVolume: cfg.authVolume, authFile: cfg.authFile }), [], null);
      return this.launched(cfg, command, [], log, signal, (launch, onError) =>
        this.session(cfg, launch, env, log, onError, async (session) => {
          await checkUsage(session, auth, log);
          await session.startThread(input.instructions);
          log({ kind: "info", text: `スレッドを立てました (model: ${session.model})` });
          try {
            const result = await session.runTurn(input.prompt, { signal });
            if (result.status === "interrupted" || signal.aborted) throw new Error("中止しました");
            if (result.status !== "completed") throw new Error(`Codex が終わりませんでした（${result.status}）`);
            log({ kind: "info", text: `完了 (${result.seconds}s, ${result.commands.length} commands)` });
            return { message: result.message ?? "", seconds: result.seconds, usage: result.usage ?? undefined, model: session.model ?? undefined };
          } catch (e) {
            throw limitError(e, auth);
          }
        }),
      );
    });
  }

  /**
   * 頼む前の準備: 始めるときの設定に決め（途中で個人設定が変わっても、ほかの頼みごとには影響しない）、認証を選び、
   * ChatGPT プランならトークンを取る。渡したトークンそのものも、ログとエラーに残さない
   */
  private async authorized<T>(
    label: string,
    log: Log,
    fn: (a: { cfg: CodexWorkspaceConfig; auth: Exclude<CodexAuth, { mode: "none" }>; env?: Record<string, string>; log: Log }) => Promise<T>,
  ): Promise<T> {
    let cfg: CodexWorkspaceConfig;
    try {
      cfg = await this.config();
    } catch (e) {
      throw new Error(`個人設定を読めないので ${label} を始めません（Docker は起動していません）: ${hideConfigPath(e)}`, { cause: e });
    }
    const auth = await this.auth(cfg);
    if (auth.mode === "none") throw new CodexUnavailableError(auth.reason);
    // ChatGPT プラン: 1ターン（最長 30 分）より長く使えるトークンにしてから始める（実行の途中では更新しない）
    let env: Record<string, string> | undefined;
    if (auth.mode === "chatgpt") {
      try {
        env = { [ACCESS_TOKEN_ENV]: await this.account.accessToken(CODEX_TOKEN_MIN_VALID_MS) };
      } catch (e) {
        if (e instanceof ChatGptAuthError) this.checked = undefined;
        throw e;
      }
      log({ kind: "info", text: `ChatGPT プラン（${auth.email ?? "サインイン済み"}）で動かします` });
    }
    const secret = env?.[ACCESS_TOKEN_ENV];
    const safe: Log = (e) => log({ ...e, text: redact(e.text, [secret]) });
    try {
      return await fn({ cfg, auth, env, log: safe });
    } catch (e) {
      if (e instanceof Error) e.message = redact(e.message, [secret]);
      throw e;
    }
  }

  /** イメージが古ければ作り直す（個人設定で止められる） */
  private async prepareImage(cfg: CodexWorkspaceConfig, log: Log) {
    if (!cfg.ensureImage) return;
    log({ kind: "info", text: "コンテナのイメージを確かめています" });
    try {
      log({ kind: "info", text: `Codex ${await ensureCodexImage()}` });
    } catch (e) {
      // docker run の前（イメージの用意）で失敗した
      throw new Error(`Codex のイメージを用意できません（app-server を起こす前）: ${(e as Error).message}`, { cause: e });
    }
  }

  /**
   * 中継ごしに起こして（launcher.mjs）、すぐ終わったときの Docker の出力と終わり方を残す。
   * work には、中継ごしのコマンドと、app-server が終わったことによる失敗に診断を付ける onError を渡す
   */
  private async launched<T>(
    cfg: CodexWorkspaceConfig,
    command: string[],
    mappings: PathMapping[],
    log: Log,
    signal: AbortSignal,
    work: (command: string[], onError: (e: unknown, phase: "start" | "run") => Promise<unknown>) => Promise<T>,
  ): Promise<T> {
    const launch = await prepareLaunch(command);
    const diag = { image: DEFAULT_IMAGE, mappings, rules: cfg.pathMap.length };
    /** app-server が終わったことによる失敗なら、診断つきのエラーにする（それ以外は undefined） */
    const diagnosed = async (e: unknown, phase: "start" | "run") => {
      if (signal.aborted) return undefined;
      const ended = /app-server が終わりました/.test((e as Error)?.message ?? "");
      if (phase === "run" && !ended) return undefined;
      const r = await launch.result({ waitMs: 3000, stopIfRunning: phase === "start" });
      if (phase === "run" && !r.exit) return undefined;
      const d = diagnoseLaunch(r, { ...diag, phase });
      // 診断（d.message）はエラーとしてログに残る（PreflightService）。ここでは Docker の出力だけを出す
      if (d.stderr) log({ kind: "error", text: `Docker の出力:\n${d.stderr}` });
      return new Error(d.message, { cause: e });
    };
    try {
      return await work(launch.command, async (e, phase) => (await diagnosed(e, phase)) ?? e);
    } finally {
      await launch.cleanup();
    }
  }

  private async runWith(
    cfg: CodexWorkspaceConfig,
    job: PreflightJob,
    auth: Exclude<CodexAuth, { mode: "none" }>,
    env: Record<string, string> | undefined,
    log: Log,
    signal: AbortSignal,
  ): Promise<EngineOutcome> {
    const readable = job.refs.filter((r) => r.status === "ok" && r.local);
    const mappings: PathMapping[] = [
      ...readable.map((r) => ({ label: `参照先 ${r.name}`, local: r.local!, ...mapPath(cfg.pathMap, r.local!), container: `${CONTAINER_WORKSPACE}/${r.mount}` })),
      { label: "データ", local: job.dataDir, ...mapPath(cfg.pathMap, job.dataDir), container: CONTAINER_DATA },
    ];
    const repos: HostMount[] = readable.map((r, i) => ({ name: r.name, host: mappings[i].host, container: mappings[i].container }));
    const data = mappings.at(-1)!.host;
    log({ kind: "info", text: "パスの対応（個人設定の codex.pathMap）:" });
    for (const m of mappings) log({ kind: "info", text: `  ${describeMapping(m, cfg.pathMap.length)}` });
    for (const r of readable) for (const m of r.map) if (m.entry && entryMissing(r, m.entry)) log({ kind: "info", text: `入口のファイルがありません: ${r.name}:${m.entry}` });
    await this.prepareImage(cfg, log);

    const command =
      cfg.command?.({ repos, data, auth: auth.mode }) ??
      withMounts(
        dockerCommand(PLACEHOLDER, auth.mode === "chatgpt" ? { accessTokenEnv: ACCESS_TOKEN_ENV } : { authVolume: cfg.authVolume, authFile: cfg.authFile }),
        repos,
        data,
      );
    const outcome = await this.launched(cfg, command, mappings, log, signal, (launch, onError) =>
      this.session(cfg, launch, env, log, onError, (session) => this.turn(session, job, auth, log, signal)),
    );
    // 画面イメージ: Codex が書いた原稿を、Codex の後に P3 が描画のコンテナで PNG にする（Codex のコンテナに Docker は渡さない）。
    // 描けなくても評価は残す（取り込みで不足として扱う）
    await renderManuscripts(job.runDir, { pathMap: cfg.pathMap, signal, log, render: cfg.render });
    return outcome;
  }

  /** 起こして、work（スレッドを立てて頼む）を行う。失敗は onError で診断をつけてから投げる */
  private async session<T>(
    cfg: CodexWorkspaceConfig,
    command: string[],
    env: Record<string, string> | undefined,
    log: Log,
    onError: (e: unknown, phase: "start" | "run") => Promise<unknown>,
    work: (session: WorkspaceSession) => Promise<T>,
  ): Promise<T> {
    let opened: WorkspaceSession;
    try {
      opened = await WorkspaceSession.open(command, {
        model: cfg.model,
        effort: cfg.effort,
        env,
        // ChatGPT プランでは、登録のときの agent_name_hint と同じ名前で名乗る
        clientInfo: { name: APP_NAME, title: "infodb p3", version: P3_VERSION },
        onEvent: (e) => logEvent(e, log),
      });
    } catch (e) {
      throw await onError(e, "start");
    }
    await using session = opened;
    try {
      return await work(session);
    } catch (e) {
      throw await onError(e, "run");
    }
  }

  private async turn(session: WorkspaceSession, job: PreflightJob, auth: Exclude<CodexAuth, { mode: "none" }>, log: Log, signal: AbortSignal): Promise<EngineOutcome> {
    await checkUsage(session, auth, log);
    const env = containerEnv(job);
    await session.startThread(developerInstructions(job, env));
    log({ kind: "info", text: `スレッドを立てました (model: ${session.model})` });
    try {
      const result = await session.runTurn(preflightPrompt(job, env), { signal });
      if (result.status === "interrupted") throw new Error("中止しました");
      log({ kind: "info", text: `完了 (${result.seconds}s, ${result.commands.length} commands, 変更 ${result.changed.length} files)` });
      return { changed: result.changed.map((p) => localPath(job, p)), usage: result.usage ?? undefined, threadModel: session.model ?? undefined };
    } catch (e) {
      throw limitError(e, auth);
    }
  }
}

/** ask の結果（最後の応答の文） */
export interface AskResult {
  message: string;
  seconds: number;
  usage?: Record<string, unknown>;
  model?: string;
}

/** Codex を使えない（未接続など。Docker は起動していない） */
export class CodexUnavailableError extends Error {}

/** Codex の使用量の上限（頼み直しても同じように失敗する） */
export class CodexUsageLimitError extends Error {}

/** 旧来の認証なら頼む前に使用量を読み、上限なら頼まない */
async function checkUsage(session: WorkspaceSession, auth: Exclude<CodexAuth, { mode: "none" }>, log: Log) {
  if (auth.mode === "legacy") {
    const usage = await session.usage();
    log({
      kind: "info",
      text: `使用量: ${Object.entries(usage.windows).map(([m, p]) => `${Number(m) / 60}h窓 ${p}%`).join(" / ")}`,
    });
    if (usage.reached) throw new CodexUsageLimitError(`Codex の使用量上限です: ${usage.reached}`);
  } else {
    // プラン利用では使用量を読む公式の API が無い。上限に当たればターンの失敗として分かる
    log({ kind: "info", text: "使用量: ChatGPT プランでは取得できません（上限に当たると失敗として知らせます）" });
  }
}

/** ターンの失敗のうち、使用量の上限を分かる文にする */
function limitError(e: unknown, auth: Exclude<CodexAuth, { mode: "none" }>): unknown {
  if (!(e instanceof UsageLimitError)) return e;
  return new CodexUsageLimitError(
    auth.mode === "chatgpt"
      ? "Usage limit reached: ChatGPT プランの使用量の上限に当たりました。Manage usage: https://chatgpt.com/settings/usage"
      : `Codex の使用量上限: ${e.message}`,
  );
}

function logEvent(e: WorkspaceEvent, log: Log) {
  if (!("item" in e)) {
    log({ kind: "error", text: JSON.stringify(e.error) });
    return;
  }
  const item = e.item as Record<string, any>;
  if (e.type === "commandExecution") {
    log({ kind: "command", text: `$ ${item.command}${item.exitCode ? `  (exit ${item.exitCode})` : ""}` });
  } else if (e.type === "fileChange") {
    for (const c of item.changes ?? []) log({ kind: "info", text: `✎ ${String(c.path).replace(/^\/workspace\//, "")}` });
  } else if (e.type === "agentMessage" && item.text) {
    log({ kind: "message", text: String(item.text).slice(0, 2000) });
  }
}

/** Codex に渡す依頼文（テストで確かめる） */
export const codexPrompt = (job: PreflightJob) => preflightPrompt(job, containerEnv(job));
