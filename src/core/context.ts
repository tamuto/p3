import { fileURLToPath } from "node:url";
import { chatgptAccount, type ChatGptAccount } from "./chatgpt.ts";
import { CodexWorkspaceEngine, codexConfig } from "./preflight/codexEngine.ts";
import { fixedSettings, machineSettingsSource, type MachineSettings, type SettingsSource } from "./machineSettings.ts";
import type { PreflightEngine } from "./preflight/engine.ts";
import { MockEngine } from "./preflight/mockEngine.ts";
import { PreflightService } from "./preflight/service.ts";
import { Workspace } from "./store/workspace.ts";
import { ReleaseGenerator } from "./releaseNotes/generate.ts";
import { MockSummarizer } from "./releaseNotes/mockSummarizer.ts";

/** p3 本体（パッケージ）のルート */
export const P3_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface P3Context {
  ws: Workspace;
  preflight: PreflightService;
  /** リリースノートの要約の生成（Codex の接続を Preflight と共有する） */
  releaseGenerator: ReleaseGenerator;
  /** ChatGPT の接続（このマシン。サインインの待ち受けを Codex エンジンと共有する） */
  chatgpt?: ChatGptAccount;
  /** 個人設定に登録したプロジェクト名（参照先のこのマシンのパスを書くため。登録していなければ無い） */
  projectName?: string;
}

/**
 * サーバと CLI が共有する組み立て。どちらもデータのフォルダのファイルを直接読み書きする。
 * repos: 参照先の名前 → このマシンのパス（個人設定）
 * settings: マシンごとの設定（環境変数と個人設定から。.env は読まない）。省くと個人設定から、Preflight を始めるたび・
 *   エンジンの状態を見るたびに読み直す（serve を起動し直さずに効く）。MachineSettings を渡すとその値に決める（テストなど）。
 *   プロジェクト（データのフォルダ）側には置かない: 認証情報をプロジェクトの git に入れないため
 */
export async function openProject(
  dataDir: string,
  opts: { repos?: Record<string, string>; settings?: MachineSettings | SettingsSource; projectName?: string } = {},
): Promise<P3Context> {
  const source = !opts.settings ? machineSettingsSource() : "get" in opts.settings ? opts.settings : fixedSettings(opts.settings);
  // 初めの値（画面の表示の既定エンジン）。読めなくても開ける（Preflight を始めるときに設定のエラーとして知らせる）
  const initial = await source.get().catch(() => undefined);
  const ws = new Workspace(dataDir, opts.repos);
  await ws.load();
  // 既定は Codex（ChatGPT プランか旧来の auth.json。どちらも無ければ使えない理由と次にすることを出す）。
  // Mock は preflight.engine: mock（P3_PREFLIGHT_ENGINE=mock）か --engine mock で明示したときだけ（認証の失敗を Mock の成功に見せない）
  const chatgpt = chatgptAccount();
  const codex = new CodexWorkspaceEngine({ load: async () => codexConfig(await source.get()), account: chatgpt });
  const engines: Partial<Record<PreflightEngine["name"], PreflightEngine>> = { codex, mock: new MockEngine() };
  const preflight = new PreflightService(ws, engines, {
    initial: initial?.preflight.engine ?? "codex",
    load: async () => (await source.get()).preflight.engine,
  });
  // 要約の生成も Preflight と同じ接続と既定のエンジン（preflight.engine）を使う
  const releaseGenerator = new ReleaseGenerator(ws, { codex, mock: new MockSummarizer() }, { engine: async () => (await source.get()).preflight.engine });
  return { ws, preflight, releaseGenerator, chatgpt, projectName: opts.projectName };
}
