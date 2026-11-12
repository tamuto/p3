import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkLine } from "../shared/quality.ts";
import type { Request } from "../shared/types.ts";
import type { FindingKind, ImprovementDiagnosis, ImprovementFinding, ImprovementSource } from "../shared/qualityImprovement.ts";

export type { FindingKind, ImprovementDiagnosis, ImprovementFinding, ImprovementSource };
import type { P3Context } from "./context.ts";
import { createRequest } from "./requestOps.ts";
import { withFileLock, writeFileAtomic } from "./store/fsutil.ts";

/**
 * 品質の不足から改善要望を作る（CLI の p3 quality improve・API の /quality/improvements）。
 *
 *   - 診断: 品質基準の設定（未設定・読めない・除外）、タスクのレビュー・マイルストーンレビューの1回分（違反・判断できない・除外）から、
 *     不足を区別して出す（読むだけ）。検査が未実行だから未導入とは判定しない（判断できないのまま）。除外は不足に数えず、選べるだけ
 *   - 原稿: 人が選んだ不足だけで要望の題と本文の案を作る（品質 ID・版・元の run・指摘・根拠・目指す差・完了条件の案）。原稿は資料で、
 *     中の文の指示は実行しない。表示・編集だけでは何も書かない
 *   - 登録: 明示したときだけ既存の createRequest で作る。登録の直前に診断の版（hash）を照らし、変わっていれば確かめ直してもらう
 *   - 重複と回復: 不足ごとの鍵（品質 ID・対象・不足の種類。run の違いでは増えない）と登録先を <data>/quality-improvements.json に残す。
 *     ロックの中で、先に予約（token）を書いてから、token のタグを付けた要望を作り、最後に登録先を書く。途中で落ちても、次の登録で
 *     タグから要望を見つけて台帳を直す（孤立・重複を残さない）。開いている登録先があれば案内し、閉じた要望からの作り直しは明示させる
 */

export class ImprovementError extends Error {
  constructor(
    readonly code: "diagnosis_changed" | "existing" | "closed_existing" | "bad_key" | "no_findings" | "not_found" | "invalid",
    message: string,
    readonly existing?: { request: string; keys: string[] },
  ) {
    super(message);
  }
}

const KIND_LABEL: Record<FindingKind, string> = { unset: "品質基準が未設定", invalid: "品質基準が読めない", violated: "レビューで確かめた違反", undetermined: "レビューで判断できなかった", exempt: "理由つきの除外" };

function hashOf(source: ImprovementSource, findings: ImprovementFinding[]): string {
  return createHash("sha256").update(JSON.stringify([source, findings.map((f) => [f.key, f.kind, f.version, f.reason, f.evidence])])).digest("hex").slice(0, 16);
}

/** 診断（読むだけ） */
export async function diagnoseQuality(ctx: P3Context, source: ImprovementSource): Promise<ImprovementDiagnosis> {
  const ws = ctx.ws;
  const findings: ImprovementFinding[] = [];
  const notes: string[] = [];
  const pushSettings = (state: "unset" | "invalid" | "set", version: string, problems?: string[]) => {
    if (state === "unset") findings.push({ key: "quality:unset", kind: "unset", version, target: "project", reason: "プロジェクトの品質基準が未設定です（初めて作ったときの状態に任せています）", evidence: ["project.yaml"], suggested: true });
    if (state === "invalid") findings.push({ key: "quality:invalid", kind: "invalid", version, target: "project", reason: `project.yaml の品質基準が読めません: ${(problems ?? []).join(" / ")}`, evidence: ["project.yaml"], suggested: true });
  };
  if (source.type === "project") {
    const q = ws.project.quality ?? { state: "unset" as const };
    const version = ws.project.qualityVersion ?? "";
    pushSettings(q.state, version, q.state === "invalid" ? q.problems : undefined);
    if (q.state === "set") {
      for (const s of q.config.standards.filter((x) => x.exempt)) {
        findings.push({ key: `${s.id}:project:exempt`, kind: "exempt", quality: s.id, qualityText: s.text, check: checkLine(s.check), version, target: "project", reason: `適用から除外しています: ${s.exempt!.reason}`, evidence: ["project.yaml"], suggested: false });
      }
      if (!q.config.standards.length) notes.push("品質基準は意図して空です");
    }
  } else if (source.type === "task-review") {
    const key = ctx.taskReview.key(source.request, source.task);
    const rec = await ws.taskReviews.get(key, source.run).catch(() => undefined);
    if (!rec) throw new ImprovementError("not_found", `タスクのレビューがありません: ${key}/${source.run}`);
    const q = rec.input.quality;
    const target = `task:${key}`;
    if (!q) notes.push("この記録は品質を評価していません（品質基準を材料に入れる前の記録です）");
    else if (q.latest.state !== "set") pushSettings(q.latest.state, q.latest.version, q.latest.problems);
    else {
      for (const r of rec.result?.quality ?? []) {
        if (r.verdict !== "violated" && r.verdict !== "undetermined") continue;
        const s = q.applies.find((x) => x.id === r.standard);
        findings.push({ key: `${r.standard}:${target}:${r.verdict}`, kind: r.verdict, quality: r.standard, qualityText: s?.text, check: s ? checkLine(s.check) : undefined, version: q.latest.version, target, reason: r.reason, evidence: r.evidence, suggested: r.verdict === "violated" });
      }
      for (const s of q.exempt) findings.push({ key: `${s.id}:${target}:exempt`, kind: "exempt", quality: s.id, qualityText: s.text, version: q.latest.version, target, reason: `適用から除外しています: ${s.exempt?.reason ?? ""}`, evidence: [], suggested: false });
    }
    if (rec.run.status !== "completed") notes.push(`このレビューは完了していません（${rec.run.status}）`);
  } else {
    const rec = await ws.milestoneReviews.get(source.milestone, source.run).catch(() => undefined);
    if (!rec) throw new ImprovementError("not_found", `マイルストーンレビューがありません: ${source.milestone}/${source.run}`);
    const q = rec.input?.quality;
    const target = `milestone:${source.milestone}`;
    if (!q) notes.push("この記録は品質を評価していません（品質基準を材料に入れる前の記録です）");
    else if (q.state !== "set") pushSettings(q.state, q.version, q.problems);
    else {
      for (const r of rec.result?.quality ?? []) {
        if (r.verdict !== "violated" && r.verdict !== "undetermined") continue;
        const s = q.standards?.find((x) => x.id === r.standard);
        findings.push({ key: `${r.standard}:${target}:${r.verdict}`, kind: r.verdict, quality: r.standard, qualityText: s?.text, check: s ? checkLine(s.check) : undefined, version: q.version, target, reason: `${r.regression ? "（品質の低下）" : ""}${r.reason}`, evidence: r.evidence, suggested: r.verdict === "violated" });
      }
      for (const s of (q.standards ?? []).filter((x) => x.exempt)) findings.push({ key: `${s.id}:${target}:exempt`, kind: "exempt", quality: s.id, qualityText: s.text, version: q.version, target, reason: `適用から除外しています: ${s.exempt!.reason}`, evidence: [], suggested: false });
    }
  }
  const ledger = await readLedger(ws.dataDir);
  const registered: ImprovementDiagnosis["registered"] = {};
  for (const f of findings) {
    const e = ledger.entries[f.key];
    if (!e?.request) continue;
    const r = ws.requests.get(e.request);
    registered[f.key] = { request: e.request, ...(r ? { title: r.title, status: r.status } : {}) };
  }
  return { source, findings, hash: hashOf(source, findings), registered, notes };
}

const sourceLine = (s: ImprovementSource) =>
  s.type === "project" ? "プロジェクトの品質基準の設定" : s.type === "task-review" ? `タスクのレビュー ${s.request}/${s.task} の ${s.run}` : `マイルストーンレビュー ${s.milestone} の ${s.run}`;

/** 選んだ不足から要望の原稿を作る（読むだけ） */
export function improvementDraft(d: ImprovementDiagnosis, keys: readonly string[]): { title: string; body: string } {
  const picked = d.findings.filter((f) => keys.includes(f.key));
  if (!picked.length) throw new ImprovementError("no_findings", "改善する不足を選んでください");
  const one = picked.length === 1 ? picked[0] : undefined;
  const title = one
    ? one.kind === "unset"
      ? "プロジェクトの品質基準を決める"
      : one.kind === "invalid"
        ? "プロジェクトの品質基準の設定を直す"
        : one.kind === "exempt"
          ? `品質基準 ${one.quality} の除外を見直す`
          : `品質基準 ${one.quality} の${one.kind === "violated" ? "違反を直す" : "確認の方法を整える"}（${one.qualityText ?? ""}）`
    : `品質の改善（${picked.map((f) => f.quality ?? f.kind).join(", ")}）`;
  const items = picked.map((f) =>
    [
      `### ${f.quality ? `${f.quality} ${f.qualityText ?? ""}` : KIND_LABEL[f.kind]}`,
      `- 種類: ${KIND_LABEL[f.kind]}（対象: ${f.target}・品質基準の版 ${f.version || "なし"}）`,
      ...(f.check ? [`- 確認の方法: ${f.check}`] : []),
      `- 指摘: ${f.reason}`,
      ...(f.evidence.length ? [`- 根拠: ${f.evidence.join(", ")}`] : []),
      `- 目指す差: ${f.kind === "unset" ? "プロジェクトとして守る最低限の品質基準が明記されている" : f.kind === "invalid" ? "project.yaml の品質基準が読める" : f.kind === "exempt" ? "除外の理由が今も妥当か判断し、要るなら適用する" : f.kind === "violated" ? "この品質基準を満たす" : "この品質基準を満たしているか確かめられる（確認の方法・材料を整える）"}`,
    ].join("\n"),
  );
  const body = [
    "## 目的",
    "プロジェクトの品質基準に対する不足を解消する。",
    "",
    "## 現状（診断）",
    `出典: ${sourceLine(d.source)}`,
    "",
    ...items.flatMap((x) => [x, ""]),
    "## 完了条件の案",
    ...picked.map((f) => `- ${f.quality ? `${f.quality}: ` : ""}${f.kind === "violated" ? "違反を直し、確認の方法で確かめた結果（コマンド・コミット・範囲）を証拠に残す" : f.kind === "undetermined" ? "確かめられる状態にし、確かめた結果を証拠に残す" : f.kind === "unset" ? "品質基準を設定する（p3 quality / 設定の「品質基準」）" : f.kind === "invalid" ? "project.yaml の quality を直して読めるようにする" : "除外を続けるか適用するかを決めて設定に残す"}`),
    "",
    "## 注記",
    "- この原稿は P3 が診断から作った資料です。P3 は検査を実行していません（判断できないは未導入という意味ではありません）。",
  ].join("\n");
  return { title, body };
}

// --- 台帳 ---------------------------------------------------------------------

interface LedgerEntry {
  token: string;
  reservedAt: string;
  request?: string;
  registeredAt?: string;
  source: ImprovementSource;
}
interface Ledger {
  version: 1;
  entries: Record<string, LedgerEntry>;
}

const ledgerPath = (dataDir: string) => join(dataDir, "quality-improvements.json");
export const tokenTag = (token: string) => `quality-improvement:${token}`;

async function readLedger(dataDir: string): Promise<Ledger> {
  const text = await readFile(ledgerPath(dataDir), "utf8").catch(() => "");
  if (!text) return { version: 1, entries: {} };
  try {
    const v = JSON.parse(text) as Ledger;
    return v && typeof v.entries === "object" ? v : { version: 1, entries: {} };
  } catch {
    throw new ImprovementError("invalid", `quality-improvements.json が読めません（${ledgerPath(dataDir)}）。直すか退けてからやり直してください`);
  }
}

const writeLedger = (dataDir: string, l: Ledger) => writeFileAtomic(ledgerPath(dataDir), `${JSON.stringify(l, null, 2)}\n`);
const CLOSED: Request["status"][] = ["done", "rejected"];

/**
 * 明示して登録する。hash は原稿を作った診断の版。reopenClosed: 閉じた要望が登録先の不足から作り直す。
 * 開いている登録先があれば existing（作らない）。途中で落ちた予約は、タグから要望を見つけて台帳を直す
 */
export async function registerImprovement(
  ctx: P3Context,
  input: { source: ImprovementSource; keys: string[]; title: string; body: string; hash: string; reopenClosed?: boolean },
  actor?: string,
): Promise<{ request: Request; keys: string[] }> {
  const title = input.title.trim();
  if (!title) throw new ImprovementError("invalid", "要望の題を書いてください");
  return withFileLock(join(ctx.ws.dataDir, ".quality-improvements.lock"), async () => {
    const d = await diagnoseQuality(ctx, input.source);
    if (d.hash !== input.hash) throw new ImprovementError("diagnosis_changed", "原稿を作った後で診断（品質基準・レビューの結果）が変わりました。もう一度確かめてから登録してください");
    const unknown = input.keys.filter((k) => !d.findings.some((f) => f.key === k));
    if (!input.keys.length) throw new ImprovementError("no_findings", "改善する不足を選んでください");
    if (unknown.length) throw new ImprovementError("bad_key", `診断に無い不足です: ${unknown.join(", ")}`);
    const ledger = await readLedger(ctx.ws.dataDir);
    // 途中で落ちた予約: token のタグを付けた要望があれば台帳を直す
    for (const k of input.keys) {
      const e = ledger.entries[k];
      if (e && !e.request) {
        const found = ctx.ws.requests.list().find((r) => r.tags.includes(tokenTag(e.token)));
        if (found) ledger.entries[k] = { ...e, request: found.id, registeredAt: e.registeredAt ?? new Date().toISOString() };
      }
    }
    await writeLedger(ctx.ws.dataDir, ledger);
    const open = input.keys.filter((k) => {
      const id = ledger.entries[k]?.request;
      const r = id ? ctx.ws.requests.get(id) : undefined;
      return r && !CLOSED.includes(r.status);
    });
    if (open.length) {
      const id = ledger.entries[open[0]].request!;
      throw new ImprovementError("existing", `この不足には登録した要望があります: ${id}（${ctx.ws.requests.get(id)?.title ?? ""}）`, { request: id, keys: open });
    }
    const closed = input.keys.filter((k) => ledger.entries[k]?.request && !open.includes(k));
    if (closed.length && !input.reopenClosed) {
      const id = ledger.entries[closed[0]].request!;
      throw new ImprovementError("closed_existing", `この不足は閉じた要望 ${id} で扱いました。作り直すなら明示してください（--reopen / 画面のチェック）`, { request: id, keys: closed });
    }
    // 予約 → 要望を作る（token のタグ）→ 登録先を書く
    const token = randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    for (const k of input.keys) ledger.entries[k] = { token, reservedAt: now, source: input.source };
    await writeLedger(ctx.ws.dataDir, ledger);
    const r = await createRequest(ctx, { title, body: input.body, tags: [tokenTag(token)] }, actor);
    for (const k of input.keys) ledger.entries[k] = { ...ledger.entries[k], request: r.id, registeredAt: new Date().toISOString() };
    await writeLedger(ctx.ws.dataDir, ledger);
    return { request: r, keys: input.keys };
  });
}
