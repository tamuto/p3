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

/**
 * サーバと CLI が共有する組み立て。どちらもデータのフォルダのファイルを直接読み書きする。
 * repoRoot: 手元のリポジトリ（個人設定）。省くと project.yaml の repo
 */
export async function openProject(dataDir: string, opts: { repoRoot?: string } = {}): Promise<PcubeContext> {
  const ws = new Workspace(dataDir, opts.repoRoot);
  await ws.load();
  const index = new ProjectIndex(ws);
  // エンジンは1つだけ。Codex が設定されていれば Codex、無ければ（または PCUBE_PREFLIGHT_ENGINE=mock なら）
  // Codex を使わずに画面とファイルの流れを確かめるための Mock
  const codexCfg = codexConfigFromEnv();
  const engine: PreflightEngine =
    codexCfg && process.env.PCUBE_PREFLIGHT_ENGINE !== "mock" ? new CodexWorkspaceEngine(codexCfg) : new MockEngine();
  const preflight = new PreflightService(ws, index, { [engine.name]: engine }, engine.name);
  return { ws, index, preflight };
}
