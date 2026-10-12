import { absRef } from "../../shared/refs.ts";
import type { GraphEdge, Neighborhood, RelatedItem, Request, Task } from "../../shared/types.ts";
import type { Workspace } from "../store/workspace.ts";
import { areaOverlap, TfIdf } from "./text.ts";
import { effectiveRepos } from "../../shared/repos.ts";

/** id は絶対参照（"<要望ID>" か "<要望ID>/T003"） */
type Node = { id: string; kind: "task" | "request"; title: string; areas: string[]; status: string; text: string };

/**
 * プロジェクトのインテリジェンス層。
 *
 * タスクの関連は単一の親子ではなく多元的なので、3つの次元を重ねて扱う:
 *   1. 明示エッジ   — frontmatter の relations（型付き・有向・由来/確信度つき）
 *   2. 構造         — 要望（= フォルダ = 作業ツリー）への所属
 *   3. 暗黙の近さ   — 影響領域(areas)の重なり、内容の類似（TF-IDF）
 *
 * ファイルが真実なので、インデックスは変更のたびに丸ごと再構築する（数千件規模までは十分速い）。
 */
export class ProjectIndex {
  private nodes = new Map<string, Node>();
  private out = new Map<string, GraphEdge[]>();
  private inc = new Map<string, GraphEdge[]>();
  private tfidf = new TfIdf();
  private dirty = true;

  constructor(private ws: Workspace) {
    ws.on((e) => {
      if (e.type === "changed" && (e.kind === "task" || e.kind === "request" || e.kind === "reload")) this.dirty = true;
    });
  }

  invalidate() {
    this.dirty = true;
  }

  private ensure() {
    if (!this.dirty) return;
    this.dirty = false;
    this.nodes.clear();
    this.out.clear();
    this.inc.clear();
    const add = (n: Node) => this.nodes.set(n.id, n);
    const requests = this.ws.requests.list();
    const tasks = this.ws.allTasks();
    for (const r of requests) add(requestNode(r));
    for (const t of tasks) add(taskNode(t));

    const edge = (e: GraphEdge) => {
      push(this.out, e.from, e);
      push(this.inc, e.to, e);
    };
    // 相対参照（T003）は、張った側の要望の中のタスクとして解く
    const items: { ref: string; request: string; relations: Request["relations"] }[] = [
      ...requests.map((r) => ({ ref: r.id, request: r.id, relations: r.relations })),
      ...tasks.map((t) => ({ ref: t.ref, request: t.request, relations: t.relations })),
    ];
    for (const item of items) {
      for (const r of item.relations) {
        const to = absRef(r.target, item.request);
        if (to) edge({ from: item.ref, to, type: r.type, origin: r.origin ?? "human", weight: r.confidence, note: r.note });
      }
    }
    for (const t of tasks) {
      if (!t.relations.some((r) => absRef(r.target, t.request) === t.request)) {
        edge({ from: t.ref, to: t.request, type: "derived_from", origin: "index" });
      }
    }
    this.tfidf.build([...this.nodes.values()].map((n) => ({ id: n.id, text: n.text })));
  }

  edges(): GraphEdge[] {
    this.ensure();
    return [...this.out.values()].flat();
  }

  /** id は絶対参照 */
  neighborhood(id: string): Neighborhood {
    this.ensure();
    const node = this.nodes.get(id);
    const outgoing = this.out.get(id) ?? [];
    const incoming = this.inc.get(id) ?? [];
    const explicit = new Set([...outgoing.map((e) => e.to), ...incoming.map((e) => e.from)]);
    const implicit = node
      ? this.related({ text: node.text, areas: node.areas, exclude: [id, ...explicit], limit: 6, minScore: 0.18 })
      : [];
    const impactScope = this.impactScope(id);
    const refs = [...outgoing.map((e) => e.to), ...incoming.map((e) => e.from), ...impactScope];
    const titles = Object.fromEntries(refs.filter((r) => this.nodes.has(r)).map((r) => [r, this.nodes.get(r)!.title]));
    return { ref: id, outgoing, incoming, implicit, impactScope, titles };
  }

  /**
   * id が変わったときに影響を受けうるもの（推移的）。
   *   Y depends_on X / Y part_of X / X impacts Y を辿る。
   */
  impactScope(id: string, maxDepth = 4): string[] {
    this.ensure();
    const seen = new Set([id]);
    let frontier = [id];
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const x of frontier) {
        const ys = [
          ...(this.inc.get(x) ?? []).filter((e) => e.type === "depends_on" || e.type === "part_of").map((e) => e.from),
          ...(this.out.get(x) ?? []).filter((e) => e.type === "impacts").map((e) => e.to),
        ];
        for (const y of ys) if (!seen.has(y)) (seen.add(y), next.push(y));
      }
      frontier = next;
    }
    seen.delete(id);
    return [...seen];
  }

  /** depends_on を追加すると循環するか */
  wouldCycle(from: string, to: string): boolean {
    this.ensure();
    const stack = [to];
    const seen = new Set<string>();
    while (stack.length) {
      const x = stack.pop()!;
      if (x === from) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const e of this.out.get(x) ?? []) if (e.type === "depends_on") stack.push(e.to);
    }
    return false;
  }

  /**
   * 文脈検索。preflight で Codex に渡す「関係しそうな過去・現在の仕事」を選ぶ。
   * 全件を LLM に渡さず、ここで絞り込むことでトークンを節約する。
   */
  related(q: {
    text: string;
    areas?: string[];
    /** 既知の起点。グラフ上の近さを加点 */
    seeds?: string[];
    exclude?: string[];
    limit?: number;
    minScore?: number;
  }): RelatedItem[] {
    this.ensure();
    const qv = this.tfidf.vectorize(q.text);
    const exclude = new Set(q.exclude ?? []);
    const near = this.hops(q.seeds ?? [], 2);
    // areas の参照先（名前なしは先頭の参照先。共有の repos が無ければ main だけ）
    const names = effectiveRepos(this.ws.project.repos).map((r) => r.name);
    const scope = { known: names, defaultRepo: names[0] };
    const scored: RelatedItem[] = [];
    for (const n of this.nodes.values()) {
      if (exclude.has(n.id)) continue;
      const reasons: string[] = [];
      const dv = this.tfidf.vectorOf(n.id);
      const text = dv ? TfIdf.cosine(qv, dv) : { score: 0, shared: [] };
      const area = areaOverlap(q.areas ?? [], n.areas, scope);
      const hop = near.get(n.id);
      let score = 0.6 * text.score + 0.4 * area.score;
      if (text.score > 0.08) reasons.push(`内容が類似 (${text.shared.join(", ")})`);
      if (area.score > 0) reasons.push(`領域が重複 (${area.shared.join(", ")})`);
      if (hop !== undefined) {
        score += hop === 1 ? 0.3 : 0.15;
        reasons.push(`関係グラフで ${hop} ホップ`);
      }
      if (n.kind === "task" && n.status === "done" && score > 0) reasons.push("過去に実施済み");
      if (score >= (q.minScore ?? 0.1)) {
        scored.push({ ref: n.id, title: n.title, kind: n.kind, score: round(score), reasons });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, q.limit ?? 8);
  }

  private hops(seeds: string[], max: number): Map<string, number> {
    const dist = new Map<string, number>();
    let frontier = seeds;
    for (let d = 1; d <= max && frontier.length; d++) {
      const next: string[] = [];
      for (const x of frontier) {
        const ns = [...(this.out.get(x) ?? []).map((e) => e.to), ...(this.inc.get(x) ?? []).map((e) => e.from)];
        for (const y of ns) if (!dist.has(y) && !seeds.includes(y)) (dist.set(y, d), next.push(y));
      }
      frontier = next;
    }
    return dist;
  }
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
const round = (n: number) => Math.round(n * 1000) / 1000;

function taskNode(t: Task): Node {
  return {
    id: t.ref,
    kind: "task",
    title: t.title,
    areas: t.areas,
    status: t.status,
    text: [t.title, t.title, t.labels.join(" "), t.areas.join(" "), t.body].join("\n"),
  };
}

function requestNode(r: Request): Node {
  return {
    id: r.id,
    kind: "request",
    title: r.title,
    areas: r.areas,
    status: r.status,
    text: [r.title, r.title, r.areas.join(" "), r.body].join("\n"),
  };
}
