import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ProjectConfig, type Request, type Task } from "../src/shared/types.ts";
import type { PcubeContext } from "../src/server/context.ts";
import { ProjectIndex } from "../src/server/intel/index.ts";
import type { PreflightEngine } from "../src/server/preflight/engine.ts";
import { MockEngine } from "../src/server/preflight/mockEngine.ts";
import { PreflightService } from "../src/server/preflight/service.ts";
import { writeProjectFile, writeRepoEntry } from "../src/server/store/projectFile.ts";
import type { RepoRef } from "../src/shared/repos.ts";
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

/** テストのプロジェクトの本体の参照先（名前 main。作業先にでき、最初に読む） */
export const MAIN_REF: RepoRef = { name: "main", role: "本体", readFirst: true, writable: true, map: [] };

export function projectConfig(patch: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "test",
    description: "テスト用のプロジェクト",
    repos: [MAIN_REF],
    milestones: [],
    branchPattern: "req/{id}-{slug}",
    preflight: { instructions: "" },
    ...patch,
  };
}

/** project.yaml を書く（参照先の定義も） */
export async function writeTestProject(dataDir: string, config: Partial<ProjectConfig> = {}) {
  const cfg = projectConfig(config);
  const file = join(dataDir, "project.yaml");
  await writeProjectFile(file, cfg);
  for (const r of cfg.repos) await writeRepoEntry(file, r.name, r);
}

/** git リポジトリ + .pcube/ を作る。本体の参照先 main はこのリポジトリ（openTestProject が個人設定の代わりに渡す） */
export async function makeRepo(config: Partial<ProjectConfig> = {}) {
  const root = tempDir();
  gitInit(root);
  const dataDir = join(root, ".pcube");
  await mkdir(join(dataDir, "requests"), { recursive: true });
  await writeTestProject(dataDir, config);
  return { root, dataDir };
}

/** openProject と同じ組み立て。エンジンは差し替えられる（既定は待ち時間なしの mock） */
export async function openTestProject(
  dataDir: string,
  engines: Partial<Record<PreflightEngine["name"], PreflightEngine>> = { mock: new MockEngine({ delay: 0 }) },
  opts: { repos?: Record<string, string> } = {},
): Promise<PcubeContext> {
  // 個人設定のこのマシンのパスの代わり。既定は makeRepo のリポジトリ（.pcube の親）を main に
  const repos = opts.repos ?? (basename(dataDir) === ".pcube" ? { main: dirname(dataDir) } : {});
  const ws = new Workspace(dataDir, repos);
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
