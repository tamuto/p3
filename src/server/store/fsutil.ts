import { mkdir, rename, writeFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes, randomInt } from "node:crypto";

/** tmp に書いてから rename する。外部エディタ/AI が途中状態を読まないように。 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

/** 既に存在する場合は false を返す（ID 採番の競合検出用） */
export async function createExclusive(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const fh = await open(path, "wx");
    await fh.writeFile(content, "utf8");
    await fh.close();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
  );
}

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford（i l o u を除く）

/**
 * 要望の ID（= フォルダ名）。作成日 + 乱数5文字（例: 261009-k7m3x）。
 * 時刻順に並び、人が読み書きでき、複数人が同時に作っても実用上衝突しない（1日あたり約3,300万通り）。
 * タイトルは後から変わるので含めない。
 */
export function newRequestId(now = new Date()): string {
  // 作った人の日付（ローカル時刻）で付ける
  const p2 = (n: number) => String(n).padStart(2, "0");
  const d = `${p2(now.getFullYear() % 100)}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  let rand = "";
  for (let i = 0; i < 5; i++) rand += BASE32[randomInt(32)];
  return `${d}-${rand}`;
}
