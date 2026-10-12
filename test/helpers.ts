import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProjectConfig, type Request, type Task } from "../src/shared/types.ts";
import type { PcubeContext } from "../src/server/context.ts";
import { ProjectIndex } from "../src/server/intel/index.ts";
import type { PreflightEngine } from "../src/server/preflight/engine.ts";
import { MockEngine } from "../src/server/preflight/mockEngine.ts";
import { PreflightService } from "../src/server/preflight/service.ts";
import { writeProjectFile } from "../src/server/store/projectFile.ts";
import { Workspace } from "../src/server/store/workspace.ts";

export function tempDir(prefix = "pcube-test-"): string {
  // macOS などで /tmp がシンボリックリンクでも、git の返すパスと比べられるよう実体にする
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function gitInit(dir: string) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "user.email", "tester@example.com");
  git(dir, "config", "commit.gpgsign", "false");
}

export function projectConfig(patch: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "test",
    description: "テスト用のプロジェクト",
    repo: "..",
    repos: [],
    docs: [],
    milestones: [],
    branchPattern: "req/{id}-{slug}",
    worktreeDir: ".worktrees",
    preflight: { instructions: "" },
    ...patch,
  };
}

/** git リポジトリ + .pcube/ を作る */
export async function makeRepo(config: Partial<ProjectConfig> = {}) {
  const root = tempDir();
  gitInit(root);
  const dataDir = join(root, ".pcube");
  await mkdir(join(dataDir, "requests"), { recursive: true });
  await writeProjectFile(join(dataDir, "project.yaml"), projectConfig(config));
  return { root, dataDir };
}

/** openProject と同じ組み立て。エンジンは差し替えられる（既定は待ち時間なしの mock） */
export async function openTestProject(
  dataDir: string,
  engines: Partial<Record<PreflightEngine["name"], PreflightEngine>> = { mock: new MockEngine({ delay: 0 }) },
): Promise<PcubeContext> {
  const ws = new Workspace(dataDir);
  await ws.load();
  const index = new ProjectIndex(ws);
  const preflight = new PreflightService(ws, index, engines, engines.codex ? "codex" : "mock");
  return { ws, index, preflight };
}

export async function makeProject(config: Partial<ProjectConfig> = {}) {
  const repo = await makeRepo(config);
  return { ...repo, ctx: await openTestProject(repo.dataDir) };
}

export function newRequest(ctx: PcubeContext, r: Partial<Request> & { title: string } = { title: "要望" }, actor = "test") {
  return ctx.ws.requests.create({ status: "active", body: "", ...r }, actor);
}

export function newTask(ctx: PcubeContext, requestId: string, t: Partial<Task> & { title: string }, actor = "test") {
  return ctx.ws.tasksOf(requestId).create({ status: "todo", ...t }, actor);
}
