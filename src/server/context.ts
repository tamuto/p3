import { fileURLToPath } from "node:url";
import { ProjectIndex } from "./intel/index.ts";
import { ChatGptAccount } from "./chatgpt/account.ts";
import { CodexWorkspaceEngine, codexConfig } from "./preflight/codexEngine.ts";
import { resolveMachineSettings, type MachineSettings } from "./machineSettings.ts";
import { loadUserConfig } from "./userConfig.ts";
import type { PreflightEngine } from "./preflight/engine.ts";
import { MockEngine } from "./preflight/mockEngine.ts";
import { PreflightService } from "./preflight/service.ts";
import { Workspace } from "./store/workspace.ts";

/** pcube 本体（パッケージ）のルート */
export const PCUBE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface PcubeContext {
  ws: Workspace;
  index: ProjectIndex;
  preflight: PreflightService;
  /** ChatGPT の接続（このマシン。サインインの待ち受けを Codex エンジンと共有する） */
  chatgpt?: ChatGptAccount;
}

/**
 * サーバと CLI が共有する組み立て。どちらもデータのフォルダのファイルを直接読み書きする。
 * repoRoot: 手元のリポジトリ（個人設定）。省くと project.yaml の repo
 * settings: マシンごとの設定（環境変数と個人設定から。.env は読まない）。省くとここで読む。
 *   プロジェクト（データのフォルダ）側には置かない: 認証情報をプロジェクトの git に入れないため
 */
export async function openProject(dataDir: string, opts: { repoRoot?: string; settings?: MachineSettings } = {}): Promise<PcubeContext> {
  const settings = opts.settings ?? resolveMachineSettings(await loadUserConfig());
  const ws = new Workspace(dataDir, opts.repoRoot);
  await ws.load();
  const index = new ProjectIndex(ws);
  // 既定は Codex（ChatGPT プランか旧来の auth.json。どちらも無ければ使えない理由と次にすることを出す）。
  // Mock は preflight.engine: mock（PCUBE_PREFLIGHT_ENGINE=mock）か --engine mock で明示したときだけ（認証の失敗を Mock の成功に見せない）
  const chatgpt = new ChatGptAccount();
  const engines: Partial<Record<PreflightEngine["name"], PreflightEngine>> = {
    codex: new CodexWorkspaceEngine({ ...codexConfig(settings), account: chatgpt }),
    mock: new MockEngine(),
  };
  const preflight = new PreflightService(ws, index, engines, settings.preflight.engine);
  return { ws, index, preflight, chatgpt };
}
