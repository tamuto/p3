import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { acceptanceStatus } from "../../shared/acceptance.ts";
import { qualitySnapshot, standardsFor, taskQualityDiff } from "../../shared/quality.ts";
import type {
  TaskReviewChange,
  TaskReviewCommit,
  TaskReviewFile,
  TaskReviewInput,
  TaskReviewItem,
  TaskReviewNote,
  TaskReviewTarget,
  TaskReviewViewpoint,
} from "../../shared/taskReview.ts";
import type { Task } from "../../shared/types.ts";
import { commitsInOutput } from "../milestoneReview/code.ts";
import type { ResolvedRef } from "../repoRefs.ts";
import { NotFoundError } from "../store/collection.ts";
import { Workspace } from "../store/workspace.ts";
import { safeRelPath } from "./paths.ts";

export { safeRelPath };

/**
 * タスクの AI レビューの材料を固定する（何も書かない。取り出したファイルの中身は files で返し、保存は store.ts）。
 *
 *   - 対象は保存してある完了したタスク（済みも再実行できる）。無い・未完了・アーカイブしたタスクは断る（過去の履歴は読める）
 *   - タスクの本文・受け入れ基準・作業した側の証拠（失効・読めない値も含む）・変更の記録・成果物・要望の文脈を写す。
 *     証拠は判定に変えない。基準が無ければ本文から比較項目を取り出し、元の段落を残す
 *   - 比較対象（コミット・範囲・PR の参照）を参照先ごとに正規化し、完全な SHA に固定する。単一のコミットは親との差分（ルートは
 *     空の tree）、複数は各親との差分、範囲は merge-base からの差分。マージのコミット・参照先の候補が複数なら人に指定を求める。
 *     PR の URL は出典として残し、中身は取りに行かない（fetch・checkout・認証はしない）
 *   - 差分・変更の一覧・変わったファイルの前後の中身を、固定した SHA の git のオブジェクトから取り出す（作業ツリーの未コミットの
 *     変更・今のブランチは混ざらない）。submodule・シンボリックリンクの先は追わない。コードは実行しない
 *   - 観点は人が明示したものだけ（参照先の固定した SHA のファイルか、project.yaml の taskReview.viewpoints）。作業ブランチの
 *     ファイルで差し替えない。選んだ文面・出典・SHA・hash を残す
 *   - 上限を超えるファイルは切り詰めずに取り出さず、注意（omitted）として未確認の範囲にする。差分の合計が上限を超えたら断る
 *   - hash は抽出の日時を含めない（同じ文面・基準・証拠・対象の SHA・観点・取り出した中身なら同じ）
 */

export const TASK_REVIEW_LIMITS = {
  /** 差分の本文の合計 */
  patchBytes: 1_000_000,
  /** 取り出すファイル1件 */
  fileBytes: 200_000,
  /** 取り出すファイルの合計 */
  totalBytes: 4_000_000,
  /** 比較対象のコミットの数 */
  commits: 50,
  /** 観点の文字数 */
  viewpoint: 20_000,
} as const;

/** 始められない（理由つき。何も書いていない） */
export class TaskReviewRejected extends Error {
  constructor(
    readonly code:
      | "not_done"
      | "archived"
      | "no_target"
      | "bad_target"
      | "ambiguous_repo"
      | "repo_unavailable"
      | "unknown_commit"
      | "merge_commit"
      | "shallow"
      | "pr_unresolved"
      | "too_large"
      | "bad_viewpoint"
      | "running"
      | "unavailable"
      | "engine_required"
      | "material_changed",
    message: string,
    readonly running?: string,
  ) {
    super(message);
  }
}

/** 比較対象の指定（CLI の --target・API の targets）。省くとタスクの成果物のコミット */
export type TargetSpec = string;
/** 観点の指定。省く・"builtin" は既定だけ / "project" は project.yaml の taskReview.viewpoints / "<参照先>@<sha>:<パス>" は固定した SHA のファイル */
export type ViewpointSpec = string;

export interface ExtractOptions {
  targets?: TargetSpec[];
  viewpoint?: ViewpointSpec;
}

/** 固定した材料と、材料のフォルダに置くファイルの中身 */
export interface ExtractedTaskReview {
  input: TaskReviewInput;
  files: Map<string, Buffer>;
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FULL_SHA = /^[0-9a-f]{40}$/;
const TASK_REF_RE = /\b\d{6}-[a-z0-9]{5}\/T\d{3,}\b/g;
const PR_RE = /^https?:\/\/\S+\/(?:pull|pulls|merge_requests)\/\d+/i;

function gitBuf(local: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.quotepath=off", "-C", local, ...args], { encoding: "buffer", timeout: 30_000, maxBuffer }, (err, stdout) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(stdout)));
  });
}
const git = async (local: string, args: string[]) => (await gitBuf(local, args)).toString("utf8");
const tryGit = (local: string, args: string[]) => git(local, args).then((s) => s.trim(), () => undefined);

/** 本文から比較項目を取り出す: 「完了条件」の見出しの下の箇条書き → 箇条書き全部 → 段落 */
export function bodyItems(body: string): TaskReviewItem[] {
  const text = body.replace(/\r\n/g, "\n").replace(/\n> preflight: .*$/m, "");
  const bullets = (s: string) =>
    s
      .split("\n")
      .map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(l)?.[1]?.trim())
      .filter((x): x is string => !!x);
  const section = /^#{1,6}\s*完了条件\s*$([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
  let list = bullets(section);
  if (!list.length) list = bullets(text.replace(/^#{1,6}\s*(判断の根拠|未確認)\s*$[\s\S]*?(?=^#{1,6}\s|$(?![\s\S]))/gm, ""));
  if (!list.length) list = text.split(/\n{2,}/).map((p) => p.replace(/^#{1,6}\s.*$/gm, "").trim()).filter(Boolean);
  return list.slice(0, 50).map((t, i) => ({ id: `B${i + 1}`, kind: "body" as const, text: t.length > 1000 ? `${t.slice(0, 1000)}…` : t, source: t }));
}

/**
 * 材料を取り出す。dataDir のファイルをディスクから読み直した別の Workspace で読む（画面・CLI のキャッシュに左右されない）。
 * refs: 参照先（このマシンのパス）
 */
export async function extractTaskReview(dataDir: string, rid: string, tid: string, refs: readonly ResolvedRef[], opts: ExtractOptions = {}): Promise<ExtractedTaskReview> {
  const extractedAt = new Date().toISOString();
  const snap = new Workspace(dataDir);
  await snap.load();
  const request = snap.requests.get(rid);
  if (!request) throw new NotFoundError(rid);
  const task = snap.tasksOf(rid).get(tid);
  if (!task) {
    const archived = await readFile(join(snap.requestsDir, rid, "tasks", ".archive", `${tid}.md`)).then(
      () => true,
      () => false,
    );
    if (archived) throw new TaskReviewRejected("archived", `${rid}/${tid} はアーカイブしたタスクです。新しいレビューは始められません（過去のレビューの履歴は読めます）`);
    throw new NotFoundError(`${rid}/${tid}`);
  }
  if (task.status !== "done") throw new TaskReviewRejected("not_done", `${task.ref} はまだ完了していません（${task.status}）。レビューは完了したタスクだけです`);

  const notes: TaskReviewNote[] = [];
  const files = new Map<string, Buffer>();
  const acc = acceptanceStatus(task);
  const items: TaskReviewItem[] = task.acceptanceCriteria?.length ? task.acceptanceCriteria.map((c) => ({ id: c.id, kind: "criterion", text: c.text })) : bodyItems(task.body);
  if (!task.acceptanceCriteria?.length) notes.push({ code: "no_criteria", target: task.ref, message: "受け入れ基準がありません。本文から取り出した項目で比べます（元の段落を残します）" });
  if (task.acceptanceProblems?.length) notes.push({ code: "broken_acceptance", target: task.ref, message: `受け入れ基準・証拠に読めない値があります: ${task.acceptanceProblems.join(" / ")}` });
  for (const i of acc?.items ?? []) {
    if (i.state === "stale") notes.push({ code: "stale_evidence", target: `${task.ref}#${i.id}`, message: `${i.id} の証拠は基準を変える前のものです` });
    if (i.state === "missing") notes.push({ code: "no_evidence", target: `${task.ref}#${i.id}`, message: `${i.id} に作業した側の証拠がありません` });
  }
  for (const e of acc?.orphans ?? []) notes.push({ code: "orphan_evidence", target: `${task.ref}#${e.criterionId}`, message: `${e.criterionId} の証拠は消された基準のものです` });
  if (!task.record?.trim()) notes.push({ code: "no_record", target: task.ref, message: "変更の記録がありません" });
  const outputs = [...task.outputs, ...(task.repoOutputs ?? []).map((o) => `${o.repo}: ${o.output}`)];
  if (!outputs.length) notes.push({ code: "no_outputs", target: task.ref, message: "成果物がありません" });

  const targets = await resolveTargets(task, outputs, refs, opts.targets, notes);
  let patchBytes = 0;
  let totalBytes = 0;
  const put = (path: string, data: Buffer) => {
    files.set(path, data);
    totalBytes += data.length;
  };
  for (const t of targets) {
    const local = refs.find((r) => r.name === t.repo)!.local!;
    for (const [i, d] of t.diffs.entries()) {
      const patch = await gitBuf(local, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--unified=3", d.base, d.head, "--"]);
      patchBytes += patch.length;
      if (patchBytes > TASK_REVIEW_LIMITS.patchBytes) {
        throw new TaskReviewRejected("too_large", `差分が上限を超えています（${patchBytes} バイト / 上限 ${TASK_REVIEW_LIMITS.patchBytes}）。切り詰めずに断ります。比較対象を絞ってください（--target）`);
      }
      d.patchFile = `diff/${t.repo}/${i + 1}.patch`;
      put(d.patchFile, patch);
      d.changes = await changesOf(local, d.base, d.head);
      for (const c of d.changes) {
        if (c.submodule || c.symlink || c.binary) {
          notes.push({ code: "omitted", target: `${t.repo}:${c.path}`, message: `${c.path} は${c.submodule ? " submodule" : c.symlink ? "シンボリックリンク" : "バイナリ"}なので中身を取り出していません（差分の一覧だけ）` });
          continue;
        }
        for (const [side, sha, path] of [
          ["base", d.base, c.oldPath ?? c.path],
          ["head", d.head, c.path],
        ] as const) {
          if ((side === "base" && c.status === "A") || (side === "head" && c.status === "D") || sha === EMPTY_TREE) continue;
          if (!safeRelPath(path)) {
            notes.push({ code: "omitted", target: `${t.repo}:${path}`, message: `${JSON.stringify(path)} は材料のフォルダに置けないパスなので中身を取り出していません` });
            continue;
          }
          const rel = `code/${t.repo}/${sha}/${path}`;
          if (files.has(rel)) {
            if (side === "base") c.baseFile = rel;
            else c.headFile = rel;
            continue;
          }
          const size = Number(await tryGit(local, ["cat-file", "-s", `${sha}:${path}`]));
          if (!Number.isFinite(size)) continue;
          if (size > TASK_REVIEW_LIMITS.fileBytes || totalBytes + size > TASK_REVIEW_LIMITS.totalBytes) {
            notes.push({
              code: "omitted",
              target: `${t.repo}@${sha.slice(0, 12)}:${path}`,
              message: `${path}（${side === "base" ? "前" : "後"}・${size} バイト）は上限を超えるので取り出していません（未確認の範囲。差分は材料にあります）`,
            });
            continue;
          }
          put(rel, await gitBuf(local, ["cat-file", "blob", `${sha}:${path}`]));
          if (side === "base") c.baseFile = rel;
          else c.headFile = rel;
        }
      }
    }
  }

  const viewpoint = await readViewpoint(dataDir, refs, opts.viewpoint);
  // 品質: レビューを始めたときの最新の品質基準と、タスクに取り込んだ版（観点を替えても、この比較は外さない）
  const latest = qualitySnapshot(snap.project.quality, snap.project.qualityVersion);
  const cfg = { standards: latest.standards ?? [] };
  const { applies, exempt } = latest.state === "set" ? standardsFor(cfg, task.repo) : { applies: [], exempt: [] };
  const quality = {
    latest,
    applies,
    exempt,
    imported: (task.acceptanceCriteria ?? []).flatMap((c) => (c.quality ? [{ criterion: c.id, quality: c.quality.id, hash: c.quality.hash, version: c.quality.version }] : [])),
    diff: taskQualityDiff(task.acceptanceCriteria ?? [], snap.project.quality, task.repo),
  };
  if (latest.state === "unset") notes.push({ code: "quality_unset", target: "project.yaml", message: "プロジェクトの品質基準は未設定です（品質は評価しません。p3 quality で設定できます）" });
  if (latest.state === "invalid") notes.push({ code: "quality_invalid", target: "project.yaml", message: `プロジェクトの品質基準が読めません（品質は評価しません）: ${(latest.problems ?? []).join(" / ")}` });
  if (quality.diff.some((d) => d.kind !== "edited")) notes.push({ code: "quality_changed", target: task.ref, message: `タスクに取り込んだ品質基準と最新の品質基準に差があります（${quality.diff.filter((d) => d.kind !== "edited").map((d) => `${d.kind}:${d.quality}`).join(", ")}）。基準の改定による不足とコードの逸脱を分けて読んでください` });
  const fileList: TaskReviewFile[] = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, data]) => ({ path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") }));
  const body = {
    version: 1 as const,
    quality,
    request: { id: request.id, title: request.title, status: request.status, body: request.body.trim() },
    task: {
      id: task.id,
      ref: task.ref,
      title: task.title,
      status: task.status,
      body: task.body.trim(),
      ...(task.record?.trim() ? { record: task.record.trim() } : {}),
      outputs,
      ...(task.acceptanceCriteria?.length ? { criteria: task.acceptanceCriteria } : {}),
      ...(task.acceptanceEvidence?.length ? { evidence: task.acceptanceEvidence } : {}),
      ...(acc?.items.length ? { evidenceStates: acc.items.map((i) => ({ id: i.id, state: i.state })) } : {}),
      ...(task.acceptanceProblems?.length ? { acceptanceProblems: task.acceptanceProblems } : {}),
    },
    items,
    targets,
    viewpoint,
    notes,
    files: fileList,
  };
  return { input: { ...body, extractedAt, hash: taskReviewInputHash(body) }, files };
}

/**
 * 材料の識別子（抽出の日時は入れない）。比較対象の出典（成果物の文字列か、指定した文字列か）も入れない
 * （同じ SHA を比べていれば、指定の仕方によらず同じ材料）
 */
export function taskReviewInputHash(i: Omit<TaskReviewInput, "extractedAt" | "hash">): string {
  const targets = i.targets.map(({ sources: _s, ...t }) => t);
  const notes = i.notes.filter((n) => n.code !== "pr_unresolved");
  return createHash("sha256").update(JSON.stringify([i.version, i.request, i.task, i.items, targets, i.viewpoint, notes, i.files, ...(i.quality ? [i.quality] : [])])).digest("hex");
}

// --- 比較対象 ---------------------------------------------------------------------

interface Parsed {
  repo?: string;
  spec: string;
  source: string;
}

function parseSpec(raw: string, names: Set<string>): Parsed {
  const s = raw.trim();
  if (PR_RE.test(s)) return { spec: s, source: s };
  const m = /^([^:\s]+):(.+)$/.exec(s);
  if (m && names.has(m[1])) return { repo: m[1], spec: m[2].trim(), source: s };
  return { spec: s, source: s };
}

async function resolveTargets(task: Task, outputs: string[], refs: readonly ResolvedRef[], specs: TargetSpec[] | undefined, notes: TaskReviewNote[]): Promise<TaskReviewTarget[]> {
  const names = new Set(refs.map((r) => r.name));
  let parsed: Parsed[];
  if (specs?.length) parsed = specs.map((s) => parseSpec(s, names));
  else {
    // 成果物のコミット（"<参照先>: <成果物>" はその参照先）と PR の URL
    parsed = [];
    for (const o of outputs) {
      const m = /^([^:\s]+): (.*)$/s.exec(o);
      const repo = m && names.has(m[1]) ? m[1] : undefined;
      const text = repo ? m![2] : o;
      for (const sha of commitsInOutput(text)) parsed.push({ repo, spec: sha, source: o });
      if (PR_RE.test(text.trim())) parsed.push({ repo, spec: text.trim(), source: o });
    }
  }
  const prs = parsed.filter((p) => PR_RE.test(p.spec));
  for (const p of prs) notes.push({ code: "pr_unresolved", target: p.source, message: `${p.spec} は出典として残します。P3 は PR の中身を取りに行きません（比較するなら取得済みの base..head を --target で指定してください）` });
  const usable = parsed.filter((p) => !PR_RE.test(p.spec));
  if (!usable.length) {
    throw new TaskReviewRejected(
      prs.length ? "pr_unresolved" : "no_target",
      prs.length
        ? `比較対象が PR の URL だけです（${prs.map((p) => p.spec).join(", ")}）。取得済みのブランチ・コミットを --target <参照先>:<base>..<head> で指定してください`
        : `${task.ref} の成果物に比較できるコミットがありません。--target <参照先>:<コミット>（複数はカンマ区切り）か <参照先>:<base>..<head> で指定してください`,
    );
  }
  const out: TaskReviewTarget[] = [];
  for (const p of usable) {
    const range = /^(.+?)\.\.(.+)$/.exec(p.spec);
    const shas = range ? [] : p.spec.split(",").map((x) => x.trim()).filter(Boolean);
    if (!range && !shas.every((x) => /^[0-9a-f]{4,40}$/i.test(x))) throw new TaskReviewRejected("bad_target", `比較対象の形が違います: ${p.source}（<参照先>:<コミット>[,<コミット>] / <参照先>:<base>..<head>）`);
    const repo = await chooseRepo(task, p, refs, range ? [range[2]] : shas);
    const local = refs.find((r) => r.name === repo)!.local!;
    let t = out.find((x) => x.repo === repo && x.kind === (range ? "range" : "commits"));
    if (range) {
      const base = await revParse(local, range[1], p.source);
      const head = await revParse(local, range[2], p.source);
      const mergeBase = await tryGit(local, ["merge-base", base, head]);
      if (!mergeBase) throw new TaskReviewRejected("shallow", `${p.source}: ${range[1]} と ${range[2]} の共通の祖先が見つかりません（浅い履歴・無関係の履歴）。範囲を指定し直してください`);
      const list = (await git(local, ["rev-list", "--reverse", `${mergeBase}..${head}`])).split("\n").filter(Boolean);
      if (list.length > TASK_REVIEW_LIMITS.commits) throw new TaskReviewRejected("too_large", `${p.source} のコミットが多すぎます（${list.length} 件 / 上限 ${TASK_REVIEW_LIMITS.commits}）`);
      t = { repo, kind: "range", sources: [p.source], commits: [], range: { base, head, mergeBase, baseSpec: range[1], headSpec: range[2] }, diffs: [{ base: mergeBase, head, patchFile: "", changes: [] }] };
      for (const sha of list) t.commits.push(await commitOf(local, sha, task.ref));
      out.push(t);
      continue;
    }
    if (!t) {
      t = { repo, kind: "commits", sources: [], commits: [], diffs: [] };
      out.push(t);
    }
    t.sources.push(p.source);
    for (const s of shas) {
      const sha = await revParse(local, s, p.source);
      if (t.commits.some((c) => c.sha === sha)) continue;
      const c = await commitOf(local, sha, task.ref);
      if (c.parents.length > 1) {
        throw new TaskReviewRejected("merge_commit", `${sha.slice(0, 12)} はマージのコミットです（親が ${c.parents.length} つ）。どちらの親と比べるかを --target ${repo}:<親>..${sha.slice(0, 12)} で指定してください`);
      }
      if (c.parents.length === 0 && (await tryGit(local, ["rev-parse", "--is-shallow-repository"])) === "true" && (await isShallowBoundary(local, sha))) {
        throw new TaskReviewRejected("shallow", `${sha.slice(0, 12)} の親が浅い履歴のため読めません。親まで取得するか、--target ${repo}:<base>..<head> で指定してください`);
      }
      t.commits.push(c);
      t.diffs.push({ base: c.parents[0] ?? EMPTY_TREE, head: sha, patchFile: "", changes: [] });
      if (t.commits.length > TASK_REVIEW_LIMITS.commits) throw new TaskReviewRejected("too_large", `比較対象のコミットが多すぎます（上限 ${TASK_REVIEW_LIMITS.commits}）`);
    }
  }
  for (const t of out) {
    const others = [...new Set(t.commits.flatMap((c) => c.otherTasks))];
    if (others.length) notes.push({ code: "other_tasks", target: t.repo, message: `比較対象に他のタスク（${others.join(", ")}）のコミットが含まれます。このタスクの範囲と分けて読んでください` });
  }
  return out;
}

async function isShallowBoundary(local: string, sha: string): Promise<boolean> {
  const gitDir = await tryGit(local, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return false;
  const text = await readFile(join(gitDir, "shallow"), "utf8").catch(() => "");
  return text.split("\n").includes(sha);
}

/** 参照先を決める: 指定 → タスクの作業先 → コミットが見つかる読める参照先が1つ */
async function chooseRepo(task: Task, p: Parsed, refs: readonly ResolvedRef[], probe: string[]): Promise<string> {
  const ok = (r: ResolvedRef) => r.status === "ok" && !!r.local;
  const check = async (name: string) => {
    const r = refs.find((x) => x.name === name);
    if (!r || !ok(r)) throw new TaskReviewRejected("repo_unavailable", `参照先 ${name} を読めません（${r?.reason ?? "登録されていません"}）。p3 repo path ${name} <パス> で登録してください`);
    if ((await tryGit(r.local!, ["rev-parse", "--git-dir"])) === undefined) throw new TaskReviewRejected("repo_unavailable", `参照先 ${name} は git のリポジトリではありません`);
    return name;
  };
  if (p.repo) return check(p.repo);
  if (task.repo && refs.some((r) => r.name === task.repo && ok(r))) return check(task.repo);
  const found: string[] = [];
  for (const r of refs.filter(ok)) {
    let all = true;
    for (const s of probe) if (!(await tryGit(r.local!, ["rev-parse", "--verify", "-q", `${s}^{commit}`]))) all = false;
    if (all) found.push(r.name);
  }
  if (found.length === 1) return check(found[0]);
  if (!found.length) throw new TaskReviewRejected("unknown_commit", `${p.source} が読める参照先の履歴に見つかりません（取得済みか確かめ、--target <参照先>:<コミット> で指定してください）`);
  throw new TaskReviewRejected("ambiguous_repo", `${p.source} が複数の参照先（${found.join(", ")}）にあります。--target <参照先>:${p.spec} で指定してください`);
}

async function revParse(local: string, spec: string, source: string): Promise<string> {
  if (spec.startsWith("-")) throw new TaskReviewRejected("bad_target", `比較対象の形が違います: ${source}`);
  const sha = await tryGit(local, ["rev-parse", "--verify", "-q", `${spec}^{commit}`]);
  if (!sha || !FULL_SHA.test(sha)) throw new TaskReviewRejected("unknown_commit", `${spec} が参照先の履歴にありません（${source}）`);
  return sha;
}

async function commitOf(local: string, sha: string, ownRef: string): Promise<TaskReviewCommit> {
  const raw = await git(local, ["show", "-s", "--format=%P%x00%s%x00%B", sha]);
  const [parents, subject, message] = raw.split("\0");
  const otherTasks = [...new Set([...(message ?? "").matchAll(TASK_REF_RE)].map((m) => m[0]))].filter((r) => r !== ownRef);
  return { sha, parents: parents.trim().split(/\s+/).filter(Boolean), subject: subject.trim(), otherTasks };
}

/** 変更の一覧（名前の変更を含む）。submodule（160000）・シンボリックリンク（120000）・バイナリの印を付ける */
async function changesOf(local: string, base: string, head: string): Promise<TaskReviewChange[]> {
  const raw = await git(local, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", base, head, "--"]);
  const num = await git(local, ["diff", "--numstat", "-z", "--find-renames", base, head, "--"]);
  const binary = new Set<string>();
  const parts = num.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    // 名前の変更は "a\tb\t" の後に古い名前・新しい名前が続く
    const path = m[3] === "" ? parts[i + 2] : m[3];
    if (m[3] === "") i += 2;
    if (m[1] === "-") binary.add(path);
  }
  const out: TaskReviewChange[] = [];
  const f = raw.split("\0");
  for (let i = 0; i < f.length - 1; ) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMDRCT])\d*$/.exec(f[i]);
    if (!meta) {
      i++;
      continue;
    }
    const [, oldMode, newMode, st] = meta;
    const renamed = st === "R" || st === "C";
    const oldPath = renamed ? f[i + 1] : undefined;
    const path = renamed ? f[i + 2] : f[i + 1];
    i += renamed ? 3 : 2;
    const mode = st === "D" ? oldMode : newMode;
    out.push({
      status: st as TaskReviewChange["status"],
      path,
      ...(oldPath ? { oldPath } : {}),
      ...(mode === "160000" || oldMode === "160000" ? { submodule: true } : {}),
      ...(mode === "120000" || oldMode === "120000" ? { symlink: true } : {}),
      ...(binary.has(path) ? { binary: true } : {}),
    });
  }
  return out;
}

// --- 観点 -------------------------------------------------------------------------

/** 既定の観点（どのレビューにも付ける） */
export const BUILTIN_VIEWPOINT =
  "受け入れ基準・本文の要件が、比較対象の変更で満たされているかを確かめる。依頼に無い変更・既存の動作を変える変更は意図しない変更の候補に挙げる。" +
  "基準どうしや本文との矛盾は直さず、人が確かめる点に残す。";

async function readViewpoint(dataDir: string, refs: readonly ResolvedRef[], spec: ViewpointSpec | undefined): Promise<TaskReviewViewpoint> {
  const hash = (t: string) => createHash("sha256").update(t).digest("hex");
  const s = spec?.trim();
  if (!s || s === "builtin") return { source: "builtin", text: BUILTIN_VIEWPOINT, hash: hash(BUILTIN_VIEWPOINT) };
  if (s === "project") {
    // 共有のプロジェクトの設定（project.yaml の taskReview.viewpoints）。作業ブランチのファイルは読まない
    const doc = YAML.parse(await readFile(join(dataDir, "project.yaml"), "utf8").catch(() => "")) as { taskReview?: { viewpoints?: unknown } } | null;
    const text = typeof doc?.taskReview?.viewpoints === "string" ? doc.taskReview.viewpoints.trim() : "";
    if (!text) throw new TaskReviewRejected("bad_viewpoint", "project.yaml に taskReview.viewpoints がありません（観点を書くか、--viewpoint <参照先>@<SHA>:<パス> で指定してください）");
    if (text.length > TASK_REVIEW_LIMITS.viewpoint) throw new TaskReviewRejected("bad_viewpoint", `観点が長すぎます（上限 ${TASK_REVIEW_LIMITS.viewpoint} 文字）`);
    return { source: "project", text, hash: hash(text) };
  }
  const m = /^([^@\s]+)@([0-9a-f]{40}|[^:\s]+):(.+)$/.exec(s);
  if (!m) throw new TaskReviewRejected("bad_viewpoint", `観点の指定が違います: ${s}（builtin / project / <参照先>@<SHA>:<パス>）`);
  const [, repo, rev, path] = m;
  const r = refs.find((x) => x.name === repo);
  if (!r || r.status !== "ok" || !r.local) throw new TaskReviewRejected("repo_unavailable", `観点の参照先 ${repo} を読めません`);
  if (!safeRelPath(path)) throw new TaskReviewRejected("bad_viewpoint", `観点のパスが使えません: ${path}`);
  const sha = await tryGit(r.local, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]);
  if (!sha) throw new TaskReviewRejected("bad_viewpoint", `観点の ${rev} が ${repo} の履歴にありません`);
  const type = await tryGit(r.local, ["cat-file", "-t", `${sha}:${path}`]);
  if (type !== "blob") throw new TaskReviewRejected("bad_viewpoint", `観点のファイル ${repo}@${sha.slice(0, 12)}:${path} がありません`);
  const text = (await git(r.local, ["cat-file", "blob", `${sha}:${path}`])).trim();
  if (text.length > TASK_REVIEW_LIMITS.viewpoint) throw new TaskReviewRejected("bad_viewpoint", `観点が長すぎます（上限 ${TASK_REVIEW_LIMITS.viewpoint} 文字）`);
  return { source: "file", text, repo, sha, path, hash: hash(text) };
}

