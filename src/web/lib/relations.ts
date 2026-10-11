import { relationRole, type GraphEdge } from "../../shared/types.ts";

/** タスク詳細などの関係の1行: 相手の役割・相手・向き・消せるか */
export interface RelationItem {
  key: string;
  direction: "out" | "in";
  /** 相手の役割（依存先 / 依存元 など） */
  role: string;
  /** 相手の参照（絶対） */
  ref: string;
  /** 同じ要望の中は T003 と短く */
  short: string;
  /** このタスクが張った関係（構造から導いたものを除く）だけ、ここから消せる */
  removable: boolean;
  edge: GraphEdge;
}

/** 張った関係（このタスク → 相手）と、張られた関係（相手 → このタスク）を1つの並びにする */
export function relationItems(outgoing: GraphEdge[], incoming: GraphEdge[], home: string): RelationItem[] {
  const short = (ref: string) => (ref.startsWith(`${home}/`) ? ref.slice(home.length + 1) : ref);
  return [
    ...outgoing.map((e) => ({
      key: `o-${e.type}-${e.to}`,
      direction: "out" as const,
      role: relationRole(e.type, "out"),
      ref: e.to,
      short: short(e.to),
      removable: e.origin !== "index",
      edge: e,
    })),
    ...incoming.map((e) => ({
      key: `i-${e.type}-${e.from}`,
      direction: "in" as const,
      role: relationRole(e.type, "in"),
      ref: e.from,
      short: short(e.from),
      removable: false,
      edge: e,
    })),
  ];
}
