import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import type { Workspace } from "../server/store/workspace.ts";
import { parseFrontmatter } from "../server/store/frontmatter.ts";
import { writeFileAtomic } from "../server/store/fsutil.ts";
import { writeRepoEntry } from "../server/store/projectFile.ts";
import { loadUserConfig, setProjectNode, updateUserConfig } from "../server/userConfig.ts";
import { repoNameProblem } from "../shared/repos.ts";
import { UsageError } from "./project.ts";
import type { Workstream } from "../shared/types.ts";

/** 以前の形式のまま。p3 migrate で移す（CLI は使い方の誤りと同じく終了コード 1） */
export class NeedsMigrationError extends UsageError {}

/** 以前の形式なら NeedsMigrationError（移し方を添える） */
export async function assertMigrated(ws: Workspace) {
  const reasons = await migrationReasons(ws);
  if (reasons.length) {
    throw new NeedsMigrationError(
      `このプロジェクトは以前の形式です（${reasons.join(" / ")}）。p3 migrate で新しい形式に移してください（--name で本体の参照先の名前を決められます）`,
    );
  }
}

/** プロジェクトが以前の形式か（理由。新しい形式なら空） */
export async function migrationReasons(ws: Workspace): Promise<string[]> {
  const reasons = (await ws.legacyProjectKeys()).map((k) => `project.yaml に以前の項目 ${k} があります`);
  if (!ws.project.repos.length) reasons.push("参照先（project.yaml の repos）がありません");
  return reasons;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|-+$/g, "");

/**
 * 以前の形式のプロジェクトを、新しい形式に一度で移す（何度実行してもよい。移すものが無ければ何もしない）。
 *   project.yaml: repo（手元のリポジトリ）と worktreeDir を外し、参照先が無ければ本体を参照先として足す
 *   個人設定: このプロジェクトの repos.main（以前の名前）を本体の参照先の名前に付け替える。無ければ project.yaml の repo の場所を登録する
 *   要望: workstream（1つのブランチ）→ workstreams.<本体>。作業ツリー（worktree）の記録は外す
 *   タスク・タスク案: 作業先（repo）が無ければ本体にする
 * 本体の名前は --name、無ければ手元のリポジトリのフォルダ名。git のブランチ・作業ツリー・アーカイブしたタスクは変えない。
 */
export async function migrate(ws: Workspace, projectName: string | undefined, cwd: string, o: { name?: string }) {
  const file = join(ws.dataDir, "project.yaml");
  const raw = (YAML.parse(await readFile(file, "utf8").catch(() => "")) ?? {}) as Record<string, unknown>;
  const user = await loadUserConfig();
  const personal = projectName ? user.projects[projectName] : undefined;
  const legacyRepo =
    typeof raw.repo === "string" && raw.repo ? (isAbsolute(raw.repo) ? raw.repo : resolve(ws.dataDir, raw.repo)) : undefined;
  const localMain = personal?.repos.main ?? (personal ? Object.values(personal.repos)[0] : undefined) ?? legacyRepo;
  const done: string[] = [];

  // 本体の参照先
  let primary = ws.project.repos.find((r) => r.writable)?.name ?? ws.project.repos[0]?.name;
  if (!primary) {
    primary = o.name ?? (slug(basename(localMain ?? cwd)) || "main");
    const problem = repoNameProblem(primary);
    if (problem) throw new Error(`本体の参照先の名前: ${problem}（--name で指定してください）`);
    await writeRepoEntry(file, primary, { name: primary, role: "本体", readFirst: true, writable: true, map: [] });
    done.push(`参照先 ${primary}（本体）を足しました`);
  } else if (o.name && o.name !== primary) {
    throw new Error(`参照先は既にあります（${ws.project.repos.map((r) => r.name).join(", ")}）。--name は参照先が無いときだけ使います`);
  }

  // project.yaml の以前の項目を外す（コメントとほかの項目は残す）
  const legacyKeys = ["repo", "worktreeDir"].filter((k) => k in raw);
  if (legacyKeys.length) {
    const doc = YAML.parseDocument(await readFile(file, "utf8"));
    for (const k of legacyKeys) doc.delete(k);
    await writeFileAtomic(file, doc.toString({ lineWidth: 0 }));
    done.push(`project.yaml から ${legacyKeys.join("・")} を外しました`);
  }

  // 個人設定: repos.main → 本体の名前（このマシンのパスだけ。共有しない）
  if (projectName && personal) {
    const repos = { ...personal.repos };
    let changed = false;
    if (!repos[primary] && localMain) {
      repos[primary] = localMain;
      changed = true;
    }
    if (primary !== "main" && "main" in repos && !ws.project.repos.some((r) => r.name === "main")) {
      delete repos.main;
      changed = true;
    }
    if (changed) {
      await updateUserConfig((doc, now) => {
        const cur = now.projects[projectName];
        if (cur) setProjectNode(doc, projectName, { dir: cur.dir, repos });
      });
      done.push(`個人設定のこのマシンのパスを 参照先 ${primary} に付け替えました`);
    }
  }

  await ws.reloadAll();

  // 要望・タスク・タスク案
  let requests = 0;
  let tasks = 0;
  let drafts = 0;
  for (const r of ws.requests.list()) {
    const { data } = parseFrontmatter(await readFile(ws.requests.path(r.id), "utf8"));
    const old = data.workstream as Record<string, unknown> | undefined;
    const streams = (data.workstreams ?? {}) as Record<string, Record<string, unknown>>;
    const hasWorktree = Object.values(streams).some((w) => w && typeof w === "object" && "worktree" in w);
    if (old || hasWorktree) {
      const next: Record<string, Workstream> = { ...(r.workstreams ?? {}) };
      if (old && typeof old.branch === "string" && !next[primary]) next[primary] = { branch: old.branch };
      await ws.requests.update(r.id, { workstreams: next }, { actor: "migrate" });
      requests++;
    }
    const col = ws.tasksOf(r.id);
    for (const t of col.list()) {
      const { data: td } = parseFrontmatter(await readFile(col.path(t.id), "utf8"));
      if (!("repo" in td)) {
        await col.update(t.id, { repo: primary }, { actor: "migrate" });
        tasks++;
      }
    }
    const runs = await readdir(join(ws.requestsDir, r.id, "preflight")).catch(() => [] as string[]);
    for (const run of runs) {
      for (const d of await ws.preflight.loadDrafts(r.id, run).catch(() => [])) {
        if (d.repo === undefined) {
          await ws.preflight.saveDraft(r.id, run, { ...d, repo: primary });
          drafts++;
        }
      }
    }
  }
  if (requests) done.push(`要望 ${requests} 件のブランチを 参照先 ${primary} の分に移しました（作業ツリーの記録は外しました）`);
  if (tasks) done.push(`タスク ${tasks} 件の作業先を ${primary} にしました`);
  if (drafts) done.push(`タスク案 ${drafts} 件の作業先を ${primary} にしました`);
  await ws.reloadAll();
  return {
    data: { primary, changes: done },
    text: done.length ? ["新しい形式に移しました:", ...done.map((d) => `  ${d}`)].join("\n") : "新しい形式です（移すものはありません）",
  };
}
