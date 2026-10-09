import { fileURLToPath } from "node:url";
import { ProjectIndex } from "./intel/index.ts";
import { ChatGptAccount } from "./chatgpt/account.ts";
import { CodexWorkspaceEngine, codexConfigFromEnv } from "./preflight/codexEngine.ts";
import type { PreflightEngine } from "./preflight/engine.ts";
import { MockEngine } from "./preflight/mockEngine.ts";
import { PreflightService } from "./preflight/service.ts";
import { Workspace } from "./store/workspace.ts";

/** pcube 本体（このリポジトリ）のルート */
export const PCUBE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * マシンごとの設定（Codex の認証・パス対応など）は pcube 本体の .env に置く。
 * プロジェクト（データディレクトリ）側には置かない: 認証情報をプロジェクトの git に入れないため。
 */
export function loadMachineEnv() {
  try {
    process.loadEnvFile(`${PCUBE_ROOT}.env`);
  } catch {
    // .env は任意
  }
}

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
 */
export async function openProject(dataDir: string, opts: { repoRoot?: string } = {}): Promise<PcubeContext> {
  const ws = new Workspace(dataDir, opts.repoRoot);
  await ws.load();
  const index = new ProjectIndex(ws);
  // 既定は Codex（ChatGPT プランか旧来の auth.json。どちらも無ければ使えない理由と次にすることを出す）。
  // Mock は PCUBE_PREFLIGHT_ENGINE=mock か --engine mock で明示したときだけ（認証の失敗を Mock の成功に見せない）
  const chatgpt = new ChatGptAccount();
  const engines: Partial<Record<PreflightEngine["name"], PreflightEngine>> = {
    codex: new CodexWorkspaceEngine({ ...codexConfigFromEnv(), account: chatgpt }),
    mock: new MockEngine(),
  };
  const preflight = new PreflightService(ws, index, engines, process.env.PCUBE_PREFLIGHT_ENGINE === "mock" ? "mock" : "codex");
  return { ws, index, preflight, chatgpt };
}
