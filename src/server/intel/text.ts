/**
 * 依存ゼロの軽量テキスト類似度。日本語は文字 bigram、英数字は単語で分割し TF-IDF のコサイン類似度を取る。
 * 将来は llmcs/embedding-server (bge-m3) によるベクトル類似へ差し替え可能なよう、Vectorizer 越しに使う。
 */
import { parseRepoPath } from "../../shared/repos.ts";

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
const HIRAGANA_ONLY = /^[\u3040-\u309f]+$/;
const STOP = new Set(["the", "and", "for", "with", "to", "of", "in", "on", "a", "an", "is", "be", "を", "に", "は", "が"]);

/** 要望 ID・タスク ID・Preflight の run ID は内容ではないので、類似度の語から除く */
const IDS = /\b\d{6}-[0-9a-z]{5}(?:\/t\d+)?\b|\bpf-[0-9a-z-]+|\bt\d{3,}\b/g;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const norm = text.normalize("NFKC").toLowerCase().replace(IDS, " ");
  for (const m of norm.matchAll(/[a-z0-9_./-]{2,}|[぀-ヿ㐀-鿿豈-﫿]+/g)) {
    const w = m[0];
    if (CJK.test(w)) {
      if (w.length === 1) out.push(w);
      // ひらがなだけの bigram（助詞・活用語尾）は内容を表さないので捨てる
      for (let i = 0; i < w.length - 1; i++) {
        const bg = w.slice(i, i + 2);
        if (!HIRAGANA_ONLY.test(bg)) out.push(bg);
      }
    } else if (!STOP.has(w)) {
      out.push(w);
      // パス様の語は区切りでも分割 (src/server/store -> src, server, store)
      if (/[./-]/.test(w)) for (const p of w.split(/[./-]/)) if (p.length > 1 && !STOP.has(p)) out.push(p);
    }
  }
  return out;
}

export type SparseVec = Map<string, number>;

export class TfIdf {
  private df = new Map<string, number>();
  private docs = new Map<string, SparseVec>();
  private n = 0;

  build(docs: { id: string; text: string }[]) {
    this.df.clear();
    this.docs.clear();
    this.n = docs.length;
    const tfs = docs.map((d) => {
      const tf = new Map<string, number>();
      for (const t of tokenize(d.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return [d.id, tf] as const;
    });
    for (const [id, tf] of tfs) this.docs.set(id, this.weigh(tf));
  }

  vectorize(text: string): SparseVec {
    const tf = new Map<string, number>();
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return this.weigh(tf);
  }

  vectorOf(id: string) {
    return this.docs.get(id);
  }

  private weigh(tf: Map<string, number>): SparseVec {
    const v: SparseVec = new Map();
    let norm = 0;
    for (const [t, c] of tf) {
      const idf = Math.log((this.n + 1) / ((this.df.get(t) ?? 0) + 1)) + 1;
      const w = (1 + Math.log(c)) * idf;
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  }

  /** 共通語の上位も返す（「なぜ関連とみなしたか」を説明するため） */
  static cosine(a: SparseVec, b: SparseVec): { score: number; shared: string[] } {
    const [small, large] = a.size < b.size ? [a, b] : [b, a];
    let s = 0;
    const contrib: [string, number][] = [];
    for (const [t, w] of small) {
      const w2 = large.get(t);
      if (w2) {
        s += w * w2;
        contrib.push([t, w * w2]);
      }
    }
    contrib.sort((x, y) => y[1] - x[1]);
    return { score: s, shared: contrib.slice(0, 4).map(([t]) => t) };
  }
}

/** areas を読むときの参照先（名前の一覧と、名前なしのときの既定） */
export interface AreaScope {
  known: readonly string[];
  defaultRepo?: string;
}

/**
 * 領域（パス）の重なり。同じ参照先の中で "src/server" は "src/server/store" を包含するとみなす（参照先の全体は中の全部を包含）。
 * `<参照先>:<パス>` は参照先を区別する（別の参照先の同じパスは重ならない）。名前なしは既定の参照先。
 * 登録に無い名前・絶対パス・.. を含むものは、どれとも重ならない。scope を省くと名前を区別しない（今までどおり）
 */
export function areaOverlap(a: string[], b: string[], scope?: AreaScope): { score: number; shared: string[] } {
  if (!a.length || !b.length) return { score: 0, shared: [] };
  const read = (xs: string[]) =>
    xs.map((x) => {
      if (!scope) return { repo: "", path: x, label: x };
      const p = parseRepoPath(x, scope.known, scope.defaultRepo);
      if (!p.ok) return undefined;
      // 参照先が1つなら今までどおりパスだけで見せる
      return { repo: p.repo, path: p.path, label: scope.known.length > 1 ? `${p.repo}:${p.path}` : p.path };
    });
  const A = read(a);
  const B = read(b);
  const shared: string[] = [];
  for (const x of A) {
    for (const y of B) {
      if (!x || !y || x.repo !== y.repo) continue;
      if (x.path === y.path || x.path === "" || y.path === "" || y.path.startsWith(`${x.path}/`) || x.path.startsWith(`${y.path}/`)) {
        shared.push(x.path.length >= y.path.length ? x.label : y.label);
      }
    }
  }
  const uniq = [...new Set(shared)];
  return { score: Math.min(1, uniq.length / Math.min(a.length, b.length)), shared: uniq };
}
