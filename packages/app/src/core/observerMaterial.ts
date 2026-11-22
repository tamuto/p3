import { setObservationResultSource, setObservationSource } from "@infodb/p3-tasks/core/preflight/observations.ts";
import { DefinitionStore, PreparationStore } from "@infodb/p3-observer/core/definitionStore.ts";
import { ResultStore } from "@infodb/p3-observer/core/resultStore.ts";
import { CANDIDATE_LIMITS, candidateObservations, type CandidateMaterial } from "@infodb/p3-observer/shared/candidates.ts";
import type { P3Context } from "@infodb/p3-tasks/core/context.ts";
import { acceptanceStatus, evidenceBasisOf } from "@infodb/p3-tasks/features/requirements/shared/acceptance.ts";

/**
 * Preflight の材料の観測の供給口を置く（入口と serve が起動のときに1回。docs/architecture.md「p3-observer」の仕様変更を要望の評価で捉える）。
 * tasks と observer は読み合わないので、アプリが observer の定義を読み、判断に要る項目（ID・タイトル・期待・版・状態）だけを渡す
 */
export function installObservationSource() {
  // 受け入れ基準の証拠の根拠「観測の結果」の照合（結果の状態と、結果を実行した版・今の版）
  setObservationResultSource(async (dataDir, observation, result) => {
    const defs = new DefinitionStore(dataDir);
    const r = await new ResultStore(dataDir, defs, new PreparationStore(dataDir)).get(observation, result);
    return { status: r.status, ...(r.verdict ? { verdict: r.verdict } : {}), rev: r.rev, currentRev: (await defs.get(observation)).rev };
  });
  setObservationSource(async (dataDir) => {
    const { definitions, unreadable } = await new DefinitionStore(dataDir).list();
    return { items: definitions.map((d) => ({ id: d.id, title: d.title, ...(d.expected ? { expected: d.expected } : {}), rev: d.rev, ended: !!d.ended })), unreadable: unreadable.length };
  });
}

/**
 * 観測の候補の材料（docs/architecture.md「p3-observer」の観測の候補と表示の速さ）。tasks の記録から判断に要る項目だけを、上限まで抜き出す:
 * 人が確かめる品質基準・済みになったが証拠が申告のみか未検証の受け入れ基準・最近の完了・対応済の要望・今ある観測（説明と今の手順の要点も）
 */
export async function candidateMaterial(ctx: P3Context): Promise<CandidateMaterial> {
  const q = ctx.ws.project.quality;
  const quality = q?.state === "set" ? q.config.standards.filter((s) => s.check.kind === "manual" && !s.exempt).map((s) => ({ id: s.id, text: s.text })) : [];
  const criteria = ctx.ws
    .allTasks()
    .filter((t) => t.status === "done" && t.checkedAt)
    .flatMap((t) =>
      (acceptanceStatus(t)?.items ?? []).flatMap((i) => {
        const basis = i.evidence ? evidenceBasisOf(i.evidence).basis.kind : undefined;
        return i.state === "unverified" || i.state === "missing" || basis === "declaration" ? [{ ref: t.ref, id: i.id, text: i.text, state: i.state === "met" ? "申告のみ" : i.state }] : [];
      }),
    );
  const requests = ctx.ws.requests
    .list()
    .filter((r) => r.status === "done" || r.status === "resolved")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((r) => ({ id: r.id, title: r.title, status: r.status, updatedAt: r.updatedAt }));
  const { definitions } = await new DefinitionStore(ctx.ws.dataDir).list();
  const L = CANDIDATE_LIMITS;
  return { quality: quality.slice(0, L.quality), criteria: criteria.slice(0, L.criteria), requests: requests.slice(0, L.requests), observations: candidateObservations(definitions.filter((d) => !d.ended)) };
}
