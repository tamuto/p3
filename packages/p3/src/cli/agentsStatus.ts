import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ENTRY_VERSION } from "./guide.ts";
import { AGENT_TARGETS, AGENTS_MARK, agentsSnippet, findSections, KINDS, SKILL_SOURCE, type AgentKind } from "./project.ts";
import { repoRoot } from "@infodb/p3-kit/usage.ts";

/**
 * 置いた AI 向けの入口（スキルと AGENTS.md / CLAUDE.md の p3 の節）の診断（whoami と guide が同じものを返す）。
 * 読むだけで、古くても操作を断らず、書き換えもしない。対象は今いる git の作業ツリーのルート（git 管理外は今いる場所）だけで、
 * ほかのリポジトリや個人のスキルの場所は見ない。置き先を覚える共有の設定は持たないので、欠けた片方は、節の参照と既にある入口から
 * 足りないかを判断する（選ばなかった先を必須にしない）
 */

/** 入口ごとの状態 */
export type EntryStatus =
  | "current" // 入口の版が同じで、同梱の入口と同じ中身
  | "outdated" // 入口の版が小さい・版の無い前の p3 の全文
  | "missing" // 置くはずなのに無い
  | "modified" // 版は同じだが中身が違う（手で直した など）
  | "newer" // この CLI より新しい入口の版
  | "unknown" // 版が読めない・節が複数・見出しの形が分からない
  | "unreadable"; // ファイルを読めない

export interface EntryDiagnosis {
  /** 調べたルートからの相対パス */
  path: string;
  kind: "skill" | "section";
  /** スキルなら置き先（claude / codex） */
  target?: AgentKind;
  /** 節なら、p3 agents が書く文書（AGENTS.md があればそれ、無ければ CLAUDE.md）か、ほかで見つかった節か */
  primary?: boolean;
  /** 読めた入口の版（無い・読めないなら null） */
  version: number | null;
  status: EntryStatus;
  reason: string;
}

export interface AgentsDiagnosis {
  /** 実際に調べた場所（今の作業ツリーのルート） */
  root: string;
  /** p3 agents が書く場所（メインの作業ツリー）。root と違うときだけ */
  writeRoot?: string;
  expectedVersion: number;
  /** 入口がどれか1つでも置いてあるか */
  placed: boolean;
  /** 置いてあり、全部 current か */
  ok: boolean;
  entries: EntryDiagnosis[];
  /** 人が行う次の操作（AI は伝えるだけで、自分で実行しない） */
  advice: string[];
  /** 診断そのものが失敗したとき（whoami・guide の結果は隠さない） */
  problem?: string;
}

const DOCS = ["AGENTS.md", "CLAUDE.md"] as const;
const SKILL_VERSION_KEY = "p3-entry-version";
const SECTION_VERSION = /<!--\s*p3-entry-version:\s*(\S*?)\s*-->/;

const lf = (s: string) => s.replace(/\r\n?/g, "\n");

/** 入口の版（正の整数）。読めなければ undefined */
function parseVersion(v: unknown): number | undefined {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^[1-9]\d*$/.test(s) ? Number(s) : undefined;
}

/** 今いる git の作業ツリーのルート（git 管理外は今いる場所） */
function worktreeRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || cwd;
  } catch {
    return cwd;
  }
}

type Read = { ok: true; text: string } | { ok: false; missing: true } | { ok: false; missing: false; error: string };
function read(file: string): Read {
  try {
    if (statSync(file).isDirectory()) return { ok: false, missing: false, error: "フォルダになっています" };
    return { ok: true, text: lf(readFileSync(file, "utf8")) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, missing: true };
    return { ok: false, missing: false, error: `${code ?? "読めません"}: ${(e as Error).message}` };
  }
}

function versionStatus(version: number, same: boolean, what: string): Pick<EntryDiagnosis, "status" | "reason"> {
  if (version < ENTRY_VERSION) return { status: "outdated", reason: `${what}の入口の版 ${version} が、この CLI の版 ${ENTRY_VERSION} より古い` };
  if (version > ENTRY_VERSION) return { status: "newer", reason: `${what}の入口の版 ${version} が、この CLI の版 ${ENTRY_VERSION} より新しい（この CLI が古い可能性）` };
  return same ? { status: "current", reason: "同梱の入口と同じ" } : { status: "modified", reason: `入口の版は同じだが、同梱の入口と中身が違う（手で直した可能性）` };
}

function diagnoseSkill(root: string, k: AgentKind, referenced: boolean, bundled: string): EntryDiagnosis | undefined {
  const path = AGENT_TARGETS[k].path;
  const base = { path, kind: "skill" as const, target: k };
  const r = read(join(root, path));
  if (!r.ok) {
    if (!r.missing) return { ...base, version: null, status: "unreadable", reason: r.error };
    // 節が指していない先は、選ばなかった先として扱う（無くてよい）
    return referenced ? { ...base, version: null, status: "missing", reason: "p3 の節が指しているのに、スキルがありません" } : undefined;
  }
  const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(r.text);
  let meta: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = fm ? YAML.parse(fm[1]) : undefined;
    meta = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return { ...base, version: null, status: "unknown", reason: "スキルの frontmatter を読めません" };
  }
  const metadata = meta?.metadata && typeof meta.metadata === "object" ? (meta.metadata as Record<string, unknown>) : undefined;
  if (metadata && SKILL_VERSION_KEY in metadata) {
    const v = parseVersion(metadata[SKILL_VERSION_KEY]);
    if (v === undefined) return { ...base, version: null, status: "unknown", reason: `入口の版（metadata.${SKILL_VERSION_KEY}）が正の整数ではありません` };
    return { ...base, version: v, ...versionStatus(v, r.text === bundled, "スキル") };
  }
  if (meta?.name === "p3") return { ...base, version: null, status: "outdated", reason: "入口の版の無い、前の p3 のスキル（手順の全文の写し）" };
  return { ...base, version: null, status: "unknown", reason: "p3 のスキルの形ではありません（name: p3 も入口の版もありません）" };
}

/** 節が同梱の入口のどれか（参照するスキルの組み合わせ・見出しの段の違いは許す）と同じか */
function sameSection(body: string, level: number): boolean {
  const subsets: AgentKind[][] = [["claude"], ["codex"], ["claude", "codex"]];
  return subsets.some((kinds) => lf(agentsSnippet(kinds)).replace(/^\n/, "").replace(/^## /, `${"#".repeat(level)} `).trim() === body.trim());
}

function diagnoseSections(root: string, primaryDoc: string): { entries: EntryDiagnosis[]; referenced: Set<AgentKind> } {
  const entries: EntryDiagnosis[] = [];
  const referenced = new Set<AgentKind>();
  for (const doc of DOCS) {
    const r = read(join(root, doc));
    const primary = doc === primaryDoc;
    if (!r.ok) {
      if (!r.missing) entries.push({ path: doc, kind: "section", primary, version: null, status: "unreadable", reason: r.error });
      continue;
    }
    const sections = findSections(r.text);
    if (!sections.length) {
      if (r.text.includes(AGENTS_MARK)) entries.push({ path: doc, kind: "section", primary, version: null, status: "unknown", reason: `「${AGENTS_MARK}」が見出しとして見つかりません` });
      continue;
    }
    if (sections.length > 1) {
      entries.push({ path: doc, kind: "section", primary, version: null, status: "unknown", reason: `「${AGENTS_MARK}」の節が ${sections.length} つあります（どれが p3 の節か決められません）` });
      continue;
    }
    const { start, end, level } = sections[0];
    const body = r.text.split("\n").slice(start, end).join("\n");
    for (const k of KINDS) if (body.includes(AGENT_TARGETS[k].path)) referenced.add(k);
    const m = SECTION_VERSION.exec(body);
    if (!m) {
      entries.push({ path: doc, kind: "section", primary, version: null, status: "outdated", reason: "入口の版の無い、前の p3 の節（手順の要約の写し）" });
      continue;
    }
    const v = parseVersion(m[1]);
    if (v === undefined) {
      entries.push({ path: doc, kind: "section", primary, version: null, status: "unknown", reason: "節の入口の版（p3-entry-version）が正の整数ではありません" });
      continue;
    }
    entries.push({ path: doc, kind: "section", primary, version: v, ...versionStatus(v, sameSection(body, level), "節") });
  }
  return { entries, referenced };
}

/** p3 agents に渡す先（置いてある・指しているスキルから。分からなければ選ばせる） */
function choiceOf(kinds: Set<AgentKind>): string {
  if (kinds.has("claude") && kinds.has("codex")) return "both";
  if (kinds.has("claude")) return "claude";
  if (kinds.has("codex")) return "codex";
  return "claude|codex|both";
}

const CMD = "pnpx @infodb/p3 agents";

export function diagnoseAgents(cwd: string): AgentsDiagnosis {
  const root = worktreeRoot(cwd);
  const main = repoRoot(cwd);
  const base = { root, ...(main !== root ? { writeRoot: main } : {}), expectedVersion: ENTRY_VERSION };
  try {
    const bundled = lf(readFileSync(SKILL_SOURCE, "utf8"));
    const primaryDoc = DOCS.find((d) => read(join(root, d)).ok) ?? "AGENTS.md";
    const sections = diagnoseSections(root, primaryDoc);
    const skills = KINDS.map((k) => diagnoseSkill(root, k, sections.referenced.has(k), bundled)).filter((e): e is EntryDiagnosis => !!e);
    const placed = skills.length + sections.entries.length > 0;
    const entries = [...skills, ...sections.entries];
    // スキルはあるのに節がどこにも無い
    if (skills.length && !sections.entries.length) {
      entries.push({ path: primaryDoc, kind: "section", primary: true, version: null, status: "missing", reason: `スキルはあるのに、${primaryDoc} に「${AGENTS_MARK}」の節がありません` });
    }
    const kinds = new Set<AgentKind>([...sections.referenced, ...skills.map((s) => s.target as AgentKind)]);
    const choice = choiceOf(kinds);
    const advice: string[] = [];
    const has = (s: EntryStatus) => entries.some((e) => e.status === s);
    if (!placed) advice.push(`AI 向けの入口が置かれていません。置くなら、人が先を選んで ${CMD} claude|codex|both を実行する`);
    if (has("outdated")) advice.push(`古い入口があります。人が差分（git diff）を確かめ、p3 の節の中に足したプロジェクト固有の決まりがあれば節の外へ移してから ${CMD} ${choice} --force で更新する`);
    if (has("missing")) {
      const missingSkills = entries.filter((e) => e.status === "missing" && e.kind === "skill").map((e) => e.target as AgentKind);
      advice.push(`足りない入口があります。人が ${CMD} ${missingSkills.length ? choiceOf(new Set(missingSkills)) : choice} で置く（既にある入口は変えません）`);
    }
    if (has("modified")) advice.push("入口の版は同じなのに中身が同梱の入口と違うものがあります。手で直した内容を確かめてください（--force は直した内容を消すので、すぐには勧めません）");
    if (has("newer")) advice.push("この CLI より新しい入口があります。古い p3 で動いていないか（pnpx @infodb/p3 で呼んでいるか、guide の cliVersion）を確かめてください。--force で古い入口に戻さない");
    if (has("unknown")) advice.push("形の分からない入口があります。節が複数なら手で1つの節（見出し「## タスク管理（infodb p3）」）に整理し、版の書き方を確かめてください");
    if (has("unreadable")) advice.push("読めない入口があります。ファイルの権限・種類を確かめてください");
    if (base.writeRoot && entries.some((e) => e.status !== "current")) {
      advice.push(`p3 agents が書くのはメインの作業ツリー（${base.writeRoot}）です。そこで更新・レビュー・コミットしてから、このブランチに取り込んでください`);
    }
    return { ...base, placed, ok: placed && entries.every((e) => e.status === "current"), entries, advice };
  } catch (e) {
    return { ...base, placed: false, ok: false, entries: [], advice: [], problem: `入口を調べられませんでした: ${(e as Error).message}` };
  }
}

const STATUS_LABEL: Record<EntryStatus, string> = {
  current: "最新",
  outdated: "古い",
  missing: "無い",
  modified: "変更あり",
  newer: "CLI より新しい",
  unknown: "形が不明",
  unreadable: "読めない",
};

/** 人向けの表示（whoami と guide の通知） */
export function agentsText(d: AgentsDiagnosis): string[] {
  if (d.problem) return [d.problem];
  if (!d.placed) return ["置かれていません", ...d.advice.map((a) => `  → ${a}`)];
  if (d.ok) return [`最新（${d.entries.map((e) => e.path).join("・")}）`];
  return [
    `対応が必要（入口の版 ${d.expectedVersion}）`,
    ...d.entries.filter((e) => e.status !== "current").map((e) => `  ${STATUS_LABEL[e.status]}  ${e.path}  ${e.reason}`),
    ...d.advice.map((a) => `  → ${a}`),
  ];
}
