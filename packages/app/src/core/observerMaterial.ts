import { setObservationSource } from "@infodb/p3-tasks/core/preflight/observations.ts";
import { DefinitionStore } from "@infodb/p3-observer/core/definitionStore.ts";

/**
 * Preflight の材料の観測の供給口を置く（入口と serve が起動のときに1回。docs/architecture.md「p3-observer」の仕様変更を要望の評価で捉える）。
 * tasks と observer は読み合わないので、アプリが observer の定義を読み、判断に要る項目（ID・タイトル・期待・版・状態）だけを渡す
 */
export function installObservationSource() {
  setObservationSource(async (dataDir) => {
    const { definitions, unreadable } = await new DefinitionStore(dataDir).list();
    return { items: definitions.map((d) => ({ id: d.id, title: d.title, ...(d.expected ? { expected: d.expected } : {}), rev: d.rev, ended: !!d.ended })), unreadable: unreadable.length };
  });
}
