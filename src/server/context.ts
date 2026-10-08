import { fileURLToPath } from "node:url";
import { ProjectIndex } from "./intel/index.ts";
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
}

/** サーバと CLI が共有する組み立て。どちらもデータディレクトリのファイルを直接読み書きする */
export async function openProject(dataDir: string): Promise<PcubeContext> {
  const ws = new Workspace(dataDir);
  await ws.load();
  const index = new ProjectIndex(ws);
  const engines: Partial<Record<PreflightEngine["name"], PreflightEngine>> = { mock: new MockEngine() };
  const codexCfg = codexConfigFromEnv();
  if (codexCfg) engines.codex = new CodexWorkspaceEngine(codexCfg);
  const defaultEngine = (process.env.PCUBE_PREFLIGHT_ENGINE as PreflightEngine["name"]) ?? (codexCfg ? "codex" : "mock");
  const preflight = new PreflightService(ws, index, engines, defaultEngine);
  return { ws, index, preflight };
}
