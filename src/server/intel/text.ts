/**
 * 依存ゼロの軽量テキスト類似度。日本語は文字 bigram、英数字は単語で分割し TF-IDF のコサイン類似度を取る。
 * 将来は llmcs/embedding-server (bge-m3) によるベクトル類似へ差し替え可能なよう、Vectorizer 越しに使う。
 */

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
const HIRAGANA_ONLY = /^[\u3040-\u309f]+$/;
const STOP = new Set(["the", "and", "for", "with", "to", "of", "in", "on", "a", "an", "is", "be", "を", "に", "は", "が"]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const norm = text.normalize("NFKC").toLowerCase();
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

/** 領域（パス）の重なり。"src/server" は "src/server/store" を包含するとみなす */
export function areaOverlap(a: string[], b: string[]): { score: number; shared: string[] } {
  if (!a.length || !b.length) return { score: 0, shared: [] };
  const shared: string[] = [];
  for (const x of a) {
    for (const y of b) {
      if (x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`)) {
        shared.push(x.length >= y.length ? x : y);
      }
    }
  }
  const uniq = [...new Set(shared)];
  return { score: Math.min(1, uniq.length / Math.min(a.length, b.length)), shared: uniq };
}
