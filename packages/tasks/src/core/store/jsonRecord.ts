import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "@infodb/p3-kit/fsutil.ts";

/**
 * JSON の記録のファイルの読み書き（tasks の中の共通。指標の人の記録・振り返り・品質の改善要望の登録・レビューの run・Preflight の run など）。
 * 書くのは置き換え（途中の状態を読ませない。kit の writeFileAtomic）で、整形した JSON と末尾の改行。読むときの扱いは記録ごとに違う
 * （無い・読めない・JSON として読めない・形が違う）ので、呼ぶ側が決めて渡す（docs/refactoring.md「JSON・Markdown の記録のファイル」の表）。
 * ロックは kit の withFileLock を、記録ごとのロックのファイル（またはその要望のロック）で呼ぶ側が取る。ロックの中で読み直してから書く
 */

/** 読むときの扱い。返した値がそのまま読んだ値になる。エラーにするならその中で投げる */
export interface JsonReadPolicy<T> {
  /** ファイルが無い（ENOENT） */
  missing: () => T;
  /** 無い以外の理由で読めない（省けばそのエラーを投げる） */
  readFailed?: (e: NodeJS.ErrnoException) => T;
  /** 空のファイル（省けば JSON として読めないものとして扱う） */
  blank?: () => T;
  /** JSON として読めない */
  invalidJson: (message: string) => T;
  /** 読めた JSON の形を確かめて値にする（形が違えば投げるか、値を返す） */
  shape: (raw: unknown) => T;
}

export async function readJsonRecord<T>(path: string, policy: JsonReadPolicy<T>): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return policy.missing();
    if (policy.readFailed) return policy.readFailed(err);
    throw e;
  }
  if (text === "" && policy.blank) return policy.blank();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return policy.invalidJson((e as Error).message);
  }
  return policy.shape(raw);
}

/** 整形した JSON を置き換えで書く（末尾に改行） */
export async function writeJsonRecord(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
