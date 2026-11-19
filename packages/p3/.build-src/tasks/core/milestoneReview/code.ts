import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import type { ReviewCodeCommit, ReviewCodeRef, ReviewInputRequest, ReviewWarning } from "../../shared/milestoneReview.ts";
import { gitHistory, type ResolvedRef } from "../repoRefs.ts";

const run = promisify(execFile);

/**
 * マイルストーンレビューのコードの材料。Codex には参照先を読むだけでマウントして、コードと git の履歴を読ませる。
 * ここでは、そのとき読んだものが後から分かるように、参照先ごとの状態・HEAD・ブランチ・未コミットの変更の数と、
 * タスクの成果物に残したコミット（参照先の履歴にあるか）を取り出す。コードの中身は保存しない。git は読むだけの操作だけ。
 */

/** 成果物の文字列からコミットを取り出す（…/commit/<sha> の URL か、sha だけの文字列） */
export function commitsInOutput(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/\/commit\/([0-9a-f]{7,40})\b/gi)) out.add(m[1].toLowerCase());
  const bare = output.trim();
  if (/^[0-9a-f]{7,40}$/i.test(bare)) out.add(bare.toLowerCase());
  return [...out];
}

const git = async (local: string, args: string[]) => (await run("git", ["-C", local, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const tryGit = (local: string, args: string[]) => git(local, args).catch(() => undefined);

/** git を動かして標準出力を返す（標準入力を渡せる。大きな差分も読む） */
function gitRaw(local: string, args: string[], input?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile("git", ["-C", local, ...args], { timeout: 30_000, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => resolve(err ? undefined : stdout));
    // git が先に終わっても（EPIPE）落とさない。結果は終わり方で決める
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

/**
 * 未コミットの変更の中身の識別子（差分と、追跡していないファイルの中身から。中身そのものは保存しない）。
 * 変更の数が同じでも中身が変われば変わる（材料が変わったと分かるように）
 */
async function dirtyDigest(local: string, head: string | undefined, pathspec: string[]): Promise<string | undefined> {
  const tracked = head
    ? await gitRaw(local, ["diff", "--binary", "HEAD", "--", ...pathspec])
    : [await gitRaw(local, ["diff", "--binary", "--cached", "--", ...pathspec]), await gitRaw(local, ["diff", "--binary", "--", ...pathspec])].join("\n");
  const others = (await gitRaw(local, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec])) ?? "";
  const names = others.split("\0").filter(Boolean).sort();
  const blobs = names.length ? await gitRaw(local, ["hash-object", "--stdin-paths"], `${names.join("\n")}\n`) : "";
  if (tracked === undefined || blobs === undefined) return undefined;
  return createHash("sha256").update(tracked).update("\0").update(names.join("\0")).update("\0").update(blobs).digest("hex");
}

/**
 * 参照先ごとのコードの材料と警告。dataDir: データのフォルダ（参照先の中にあれば、未コミットの変更の数に入れない。
 * 要望・タスクの記録は別に材料にしている）
 */
export async function reviewCode(
  refs: readonly ResolvedRef[],
  requests: readonly ReviewInputRequest[],
  dataDir?: string,
): Promise<{ code: ReviewCodeRef[]; warnings: ReviewWarning[] }> {
  const warnings: ReviewWarning[] = [];
  // 成果物に残したコミット（"<参照先>: <成果物>" は、その参照先のもの）
  const wanted: { sha: string; from: string; repo?: string }[] = [];
  const names = new Set(refs.map((r) => r.name));
  for (const r of requests) {
    for (const t of r.tasks) {
      for (const o of t.outputs) {
        const m = /^([^:\s]+): (.*)$/s.exec(o);
        const repo = m && names.has(m[1]) ? m[1] : undefined;
        for (const sha of commitsInOutput(repo ? m![2] : o)) {
          if (!wanted.some((w) => w.sha === sha && w.from === t.ref)) wanted.push({ sha, from: t.ref, repo });
        }
      }
    }
  }
  const code: ReviewCodeRef[] = [];
  for (const r of refs) {
    const base = { name: r.name, mount: r.mount, ...(r.role ? { role: r.role } : {}), status: r.status };
    if (r.status !== "ok" || !r.local) {
      code.push({ ...base, ...(r.reason ? { reason: r.reason } : {}), commits: [] });
      warnings.push({ code: "code_unavailable", target: r.name, message: `参照先 ${r.name} を読めません（${r.reason ?? r.status}）。そのコードは確かめられません` });
      continue;
    }
    const history = gitHistory(r.local).status;
    const ref: ReviewCodeRef = { ...base, history, commits: [] };
    if (history !== "unavailable") {
      const head = await tryGit(r.local, ["rev-parse", "--verify", "-q", "HEAD"]);
      const branch = await tryGit(r.local, ["branch", "--show-current"]);
      const rel = dataDir ? relative(r.local, dataDir) : "..";
      const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
      const pathspec = [".", ...(inside ? [`:(exclude)${rel}`] : [])];
      const status = await tryGit(r.local, ["status", "--porcelain", "--", ...pathspec]);
      if (head) ref.head = head;
      if (branch) ref.branch = branch;
      const dirty = status ? status.split("\n").filter(Boolean).length : 0;
      if (dirty) {
        ref.dirty = dirty;
        const digest = await dirtyDigest(r.local, head, pathspec);
        if (digest) ref.dirtyDigest = digest;
        warnings.push({ code: "dirty_worktree", target: r.name, message: `参照先 ${r.name} に未コミットの変更が ${dirty} 件あります（作業ツリーのコードを読むので、コミットとずれることがあります）` });
      }
    }
    code.push(ref);
  }
  // コミットは、指定の参照先か、履歴のある参照先のどれかで探す
  for (const w of wanted) {
    const candidates = code.filter((c) => c.status === "ok" && c.history && c.history !== "unavailable" && (!w.repo || c.name === w.repo));
    let placed = false;
    for (const c of candidates) {
      const local = refs.find((r) => r.name === c.name)!.local!;
      const full = await tryGit(local, ["rev-parse", "--verify", "-q", `${w.sha}^{commit}`]);
      if (full) {
        add(c.commits, { sha: full, from: w.from, found: true });
        placed = true;
        break;
      }
    }
    if (!placed) {
      const target = code.find((c) => c.name === w.repo) ?? candidates[0];
      if (target) add(target.commits, { sha: w.sha, from: w.from, found: false });
      warnings.push({ code: "commit_missing", target: w.from, message: `${w.from} の成果物のコミット ${w.sha} が参照先の履歴にありません（中身を確かめられません）` });
    }
  }
  if (!code.some((c) => c.status === "ok")) {
    warnings.push({ code: "no_code", target: "repos", message: "読める参照先（リポジトリ）がありません。実装は確かめられず、記録だけの点検になります（p3 repo path <名前> <パス> で登録できます）" });
  }
  return { code, warnings };
}

function add(list: ReviewCodeCommit[], c: ReviewCodeCommit) {
  if (!list.some((x) => x.sha === c.sha && x.from === c.from)) list.push(c);
}
