import { isAbsolute } from "node:path";
import { loadUserSettings, userConfigPath, UserConfigError, type UserConfig } from "./userConfig.ts";

/**
 * マシンごとの設定（Codex の認証・パスの対応・Preflight の既定エンジン・serve の待ち受け）。
 *
 * 決め方（項目ごと）: CLI の明示（--port / --host / --engine）→ 環境変数（P3_*）→ 個人設定（config.yaml）→ 既定値。
 *   - 環境変数を空（P3_CODEX_MODEL=）にすると、個人設定の値を使わずに既定値に戻す（解除）
 *   - 読めない値は黙って捨てず、どこの何を直せばよいかをエラーにする
 *
 * 個人設定（~/.config/infodb-p3/config.yaml）の書き方:
 *
 *   codex:
 *     auth: auto                 # auto（ChatGPT に接続していれば ChatGPT、無ければ旧来）/ legacy（旧来の auth.json を使う）
 *     authVolume: codex-state    # 旧来: auth.json を入れた Docker ボリューム
 *     authFile: /home/me/.codex/auth.json   # 旧来: ホストの auth.json（authVolume とどちらか）
 *     pathMap:                   # このマシンのパス → Docker デーモンから見たパス（DevContainer のとき）
 *       /workspaces: /home/me/workspaces
 *     model: gpt-5.5
 *     effort: medium
 *     ensureImage: true          # false で、Preflight の前のイメージの作り直し（1日ごと）を止める
 *   preflight:
 *     engine: codex              # codex / mock
 *   serve:
 *     host: 0.0.0.0
 *     port: 4310
 *
 * ChatGPT のトークンはここに置かない（chatgpt.json。所有者だけが読める権限）。
 * P3_ACTOR・P3_REQUEST は操作ごとの指定なので、環境変数（と --actor / --req）だけで決める。
 */
export interface MachineSettings {
  codex: {
    auth: CodexAuthChoice;
    authVolume?: string;
    authFile?: string;
    pathMap: [string, string][];
    model?: string;
    effort?: string;
    ensureImage: boolean;
  };
  preflight: { engine: EngineChoice };
  serve: { host: string; port: number };
}

export type CodexAuthChoice = "auto" | "legacy";
export type EngineChoice = "codex" | "mock";

/** 環境変数と個人設定の対応（README の対照表と同じ） */
export const SETTING_KEYS = {
  "codex.auth": "P3_CODEX_AUTH",
  "codex.authVolume": "P3_CODEX_AUTH_VOLUME",
  "codex.authFile": "P3_CODEX_AUTH_FILE",
  "codex.pathMap": "P3_CODEX_PATH_MAP",
  "codex.model": "P3_CODEX_MODEL",
  "codex.effort": "P3_CODEX_EFFORT",
  "codex.ensureImage": "P3_CODEX_ENSURE_IMAGE",
  "preflight.engine": "P3_PREFLIGHT_ENGINE",
  "serve.host": "P3_HOST",
  "serve.port": "P3_PORT",
} as const;
type Key = keyof typeof SETTING_KEYS;

export const DEFAULT_SETTINGS: MachineSettings = {
  codex: { auth: "auto", pathMap: [], ensureImage: true },
  preflight: { engine: "codex" },
  serve: { host: "0.0.0.0", port: 4310 },
};

/** 設定の値が読めない（CLI は使い方の誤りと同じく終了コード 1）。configPath: 読んだ個人設定のファイル（共有の記録から外すため） */
export class SettingsError extends Error {
  configPath?: string;
}

export interface SettingsOverrides {
  host?: string;
  port?: string;
}

type Env = Record<string, string | undefined>;

/** どこから来た値か（エラーの案内に使う） */
type Raw = { value: unknown; from: string } | { value: undefined; from: "default" };

/**
 * マシンごとの設定を、呼ぶたびに読み直す（serve を起動し直さずに、個人設定の変更を次の Preflight から効かせる）。
 * 読めなければ SettingsError（直すファイルと項目を添える）。CLI の明示（--port / --host）は起動のときの値のまま渡す
 */
export interface SettingsSource {
  get(): Promise<MachineSettings>;
  /** 個人設定のファイル（案内に出す） */
  path: string;
}

export function machineSettingsSource(opts: { path?: string; env?: Env; cli?: SettingsOverrides } = {}): SettingsSource {
  const path = opts.path ?? userConfigPath();
  return {
    path,
    async get() {
      try {
        return resolveMachineSettings(await loadUserSettings(path), opts.env ?? process.env, opts.cli ?? {});
      } catch (e) {
        const err =
          e instanceof UserConfigError
            ? new SettingsError(e.message)
            : e instanceof SettingsError && e.message.includes("個人設定")
              ? new SettingsError(`${e.message}（${path}）`)
              : e;
        if (err instanceof SettingsError) err.configPath = path;
        throw err;
      }
    },
  };
}

/** 決まった設定（テストや、起動のときに一度だけ決めたいとき） */
export const fixedSettings = (settings: MachineSettings, path = userConfigPath()): SettingsSource => ({ path, get: async () => settings });

export function resolveMachineSettings(user: Pick<UserConfig, "settings">, env: Env = process.env, cli: SettingsOverrides = {}): MachineSettings {
  const pick = (key: Key, flag?: string): Raw => {
    if (flag !== undefined) return { value: flag, from: `--${key.split(".")[1]}` };
    const name = SETTING_KEYS[key];
    const e = env[name];
    if (e !== undefined) return e === "" ? { value: undefined, from: "default" } : { value: e, from: `環境変数 ${name}` };
    const [section, field] = key.split(".") as [keyof UserConfig["settings"], string];
    const v = user.settings[section]?.[field];
    return v === undefined || v === null || v === "" ? { value: undefined, from: "default" } : { value: v, from: `個人設定 ${key}` };
  };
  const text = (key: Key): string | undefined => {
    const r = pick(key);
    if (r.value === undefined) return undefined;
    if (typeof r.value !== "string" && typeof r.value !== "number") throw new SettingsError(`${r.from} は文字列で指定してください`);
    return String(r.value);
  };
  const oneOf = <T extends string>(key: Key, choices: readonly T[], def: T): T => {
    const v = text(key);
    if (v === undefined) return def;
    if (!(choices as readonly string[]).includes(v)) throw new SettingsError(`${pick(key).from} が読めません: ${v}（${choices.join(" / ")}）`);
    return v as T;
  };

  const ensure = pick("codex.ensureImage");
  const port = pick("serve.port", cli.port);
  const host = pick("serve.host", cli.host);
  return {
    codex: {
      auth: oneOf("codex.auth", ["auto", "legacy"] as const, DEFAULT_SETTINGS.codex.auth),
      authVolume: text("codex.authVolume"),
      authFile: text("codex.authFile"),
      pathMap: parsePathMap(pick("codex.pathMap")),
      model: text("codex.model"),
      effort: text("codex.effort"),
      ensureImage: ensure.value === undefined ? DEFAULT_SETTINGS.codex.ensureImage : parseBool(ensure),
    },
    preflight: { engine: oneOf("preflight.engine", ["codex", "mock"] as const, DEFAULT_SETTINGS.preflight.engine) },
    serve: {
      host: host.value === undefined ? DEFAULT_SETTINGS.serve.host : String(host.value),
      port: port.value === undefined ? DEFAULT_SETTINGS.serve.port : parsePort(port),
    },
  };
}

function parseBool(r: Raw): boolean {
  if (typeof r.value === "boolean") return r.value;
  const v = String(r.value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new SettingsError(`${r.from} が読めません: ${String(r.value)}（true / false。環境変数なら 1 / 0 も可）`);
}

function parsePort(r: Raw): number {
  const n = Number(r.value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new SettingsError(`${r.from} が読めません: ${String(r.value)}（1〜65535 のポート番号）`);
  return n;
}

const PATH_MAP_HINT =
  "個人設定は p3 user-config set codex.pathMap+=<このマシンのパス>=<Docker デーモンから見たパス> で1件ずつ。環境変数は <このマシンのパス>=<Docker デーモンから見たパス> をカンマ区切りで。例: /workspaces=/home/me/workspaces";

/** "ローカル=ホスト,..."（環境変数）か { ローカル: ホスト }（個人設定）。どちらも絶対パス */
function parsePathMap(r: Raw): [string, string][] {
  if (r.value === undefined) return [];
  let pairs: [string, string][];
  if (typeof r.value === "string") {
    pairs = r.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const at = s.indexOf("=");
        if (at < 0) throw new SettingsError(`${r.from} の「${s}」が読めません（${PATH_MAP_HINT}）`);
        return [s.slice(0, at).trim(), s.slice(at + 1).trim()];
      });
  } else if (typeof r.value === "object" && !Array.isArray(r.value)) {
    pairs = Object.entries(r.value as Record<string, unknown>).map(([k, v]) => {
      if (typeof v !== "string") throw new SettingsError(`${r.from} の「${k}」の値はパスの文字列で指定してください`);
      return [k, v];
    });
  } else {
    throw new SettingsError(`${r.from} は「このマシンのパス: Docker デーモンから見たパス」の対応で指定してください`);
  }
  for (const [local, host] of pairs) {
    if (!isAbsolute(local) || !host || !(isAbsolute(host) || /^[A-Za-z]:[\\/]/.test(host))) {
      throw new SettingsError(`${r.from} の「${local}=${host}」が読めません。どちらも絶対パスにしてください（${PATH_MAP_HINT}）`);
    }
  }
  return pairs;
}
