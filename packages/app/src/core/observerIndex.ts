import type { DefinitionListing } from "@infodb/p3-observer/core/definitionStore.ts";
import type { HistoryKind } from "@infodb/p3-observer/shared/definition.ts";

/** 要望ごとの、その要望の作業で作った・期待を変えた・終えた観測 */
export interface RequestObservations {
  observations: { id: string; title: string; ended: boolean; kinds: HistoryKind[] }[];
  /** 読めない観測のファイルの数（その中の履歴は数えられない） */
  unreadable: number;
}

/**
 * 観測の履歴の逆引きの索引（docs/architecture.md「p3-observer」の観測の候補と表示の速さ）。要望の詳細の観測の欄だけが使い、一覧・要望の詳細の本体は使わない。
 * 実作業の帰属（history の work）だけを数え、推定の経緯（estimatedOrigin）は数えない。同じ観測の複数の履歴は1件にまとめる。
 * データのフォルダの監視が観測のフォルダの変更を知らせたら作り直す（次に読まれたときにまとめて）。監視していない・立て直した後は、
 * 取りこぼしがあり得るので、読むたびに作り直す
 */
export class ObservationIndex {
  private built: { epoch: number; map: Map<string, RequestObservations["observations"]>; unreadable: number } | undefined;
  private dirty = true;

  constructor(
    private readonly list: () => Promise<DefinitionListing>,
    private readonly ws: { onPath(l: (rel: string) => void): () => void; readonly watchEpoch: number | undefined },
  ) {
    ws.onPath((rel) => {
      if (/^observer[\\/]definitions/.test(rel)) this.dirty = true;
    });
  }

  async forRequest(rid: string): Promise<RequestObservations> {
    const epoch = this.ws.watchEpoch;
    if (this.dirty || !this.built || epoch === undefined || this.built.epoch !== epoch) {
      this.dirty = false;
      const { definitions, unreadable } = await this.list();
      const map = new Map<string, RequestObservations["observations"]>();
      for (const d of definitions) {
        for (const h of d.history ?? []) {
          if (!h.work) continue;
          const list = map.get(h.work.request) ?? [];
          const hit = list.find((x) => x.id === d.id) ?? (list.push({ id: d.id, title: d.title, ended: !!d.ended, kinds: [] }), list.at(-1)!);
          if (!hit.kinds.includes(h.kind)) hit.kinds.push(h.kind);
          map.set(h.work.request, list);
        }
      }
      this.built = { epoch: epoch ?? -1, map, unreadable: unreadable.length };
    }
    return { observations: this.built.map.get(rid) ?? [], unreadable: this.built.unreadable };
  }
}

