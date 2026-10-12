/**
 * 同じものを何度も取りにいくとき、最後に始めた取得の応答だけを使う（応答の順が入れ替わっても古い応答で上書きしない）。
 * run(fetch) は最後の取得なら結果を、そうでなければ stale を返す（例外も最後の取得のものだけ投げる）。
 */
export const STALE: unique symbol = Symbol("stale");

export function latestOnly() {
  let seq = 0;
  return {
    async run<T>(fetch: () => Promise<T>): Promise<T | typeof STALE> {
      const n = ++seq;
      try {
        const v = await fetch();
        return n === seq ? v : STALE;
      } catch (e) {
        if (n !== seq) return STALE;
        throw e;
      }
    },
    /** これまでの取得の応答を捨てる */
    cancel() {
      seq++;
    },
  };
}
