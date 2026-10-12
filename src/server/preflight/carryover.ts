import type { PreflightNote, PreflightRun } from "../../shared/types.ts";
import type { Workspace } from "../store/workspace.ts";

/** 次の Preflight に引き継ぐもの: 前回の結果と、その後に書き足されたメモ */
export interface Carryover {
  /** 引き継ぐ前回の run（直近の run が完了していて結果を読めるときだけ） */
  previous?: PreflightRun;
  /** 前回の run を引き継がない理由（前回が無いときは undefined） */
  previousSkipped?: string;
  /** まだ渡していないメモ（古い順） */
  notes: PreflightNote[];
  /** 読めなかったメモ（渡さない） */
  invalidNotes: { file: string; error: string }[];
}

/**
 * 引き継ぐものを選ぶ。
 *   - 前回: 直近の run が completed で評価を読めるときだけ。失敗・欠損なら、古い成功 run に戻らず「前回なし」
 *   - メモ: 前回を引き継ぐなら、前回までの引き継ぎの経路（previous を辿った run）で渡し済みのものを除く。
 *           失敗した run に渡しただけのメモは渡し済みにしない。前回を引き継がないなら全部渡す
 */
export async function selectCarryover(ws: Workspace, requestId: string): Promise<Carryover> {
  const runs = await ws.preflight.list(requestId);
  const latest = runs[0];
  const { notes, invalid } = await ws.notes.list(requestId);
  let previous: PreflightRun | undefined;
  let previousSkipped: string | undefined;
  if (latest) {
    if (latest.status !== "completed") previousSkipped = `直近の ${latest.id} が${latest.status === "failed" ? "失敗" : "実行中"}のため`;
    else if (!latest.assessment) previousSkipped = `直近の ${latest.id} に評価がないため`;
    else previous = latest;
  }
  const used = new Set<string>();
  const seen = new Set<string>();
  for (let r = previous; r && !seen.has(r.id); r = r.previous ? runs.find((x) => x.id === r!.previous) : undefined) {
    seen.add(r.id);
    for (const n of r.notes ?? []) used.add(n);
  }
  return { previous, previousSkipped, notes: notes.filter((n) => !used.has(n.id)), invalidNotes: invalid };
}

/**
 * 引き継ぐものを Markdown にする。run ディレクトリの carryover.md に固定して残し、そのままエンジンに渡す
 * （前回のタスク案やメモが後から直されても、この run が何を根拠にしたかは変わらない）。
 * 引き継ぐものが無ければ undefined。
 */
export function renderCarryover(c: Carryover): string | undefined {
  if (!c.previous && !c.notes.length) return undefined;
  const out: string[] = ["# 引き継ぎ"];
  const p = c.previous;
  if (p?.assessment) {
    const a = p.assessment;
    const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "（なし）");
    out.push(
      `## 前回の評価（${p.id}）`,
      `判定: ${a.verdict} / 妥当性 ${a.validity.score} / 実現可能性 ${a.feasibility.score}`,
      a.summary,
      `### 確認事項\n${list(a.questions)}`,
      `### リスク\n${list(a.risks)}`,
      // 前回の根拠は前回の時点のもの。今回の確かめた根拠としてそのまま写させない
      `### 前回の根拠（前回の時点のもの。使うなら今回あらためて確かめ、確かめていなければ assumed にする）\n${
        a.evidence === undefined
          ? "（記録なし）"
          : list(a.evidence.map((e) => `${e.kind === "verified" ? "確かめた" : "推測"}: ${e.claim}${e.repo && e.file ? `（${e.repo}:${e.file}${e.location ? ` ${e.location}` : ""}）` : ""}`))
      }`,
      `## 前回のタスク案（人の編集と採否を含む）`,
      ...(p.drafts.length
        ? p.drafts.map(
            (d) =>
              `### ${d.key} ${d.title}（${d.include ? "採用" : "不採用"}${d.dependsOn.length ? ` / 依存: ${d.dependsOn.join(", ")}` : ""}${d.repo !== undefined ? ` / 作業先: ${d.repo ?? "なし"}` : ""}）\n${d.description}`,
          )
        : ["（なし）"]),
    );
  } else if (c.previousSkipped) {
    out.push(`## 前回の評価\n引き継ぎません（${c.previousSkipped}）。`);
  }
  if (c.notes.length) {
    out.push(
      "## その後のメモ（確認事項への回答・方針の変更。古い順）",
      ...c.notes.map((n) => `### ${n.id}（${n.createdBy ?? "不明"}, ${n.createdAt}）\n${n.body}`),
    );
  }
  return `${out.join("\n\n")}\n`;
}
