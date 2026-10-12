import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * README と docs/ の文書の相対リンクと見出しのアンカーを読む（test/docs.test.ts と test/package.test.ts で確かめる）。
 * 文言そのものは固定しない
 */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DOCS = ["README.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];

/** GitHub と同じ見出しのアンカー（小文字にし、文字・数字・空白・-・_ 以外を除き、空白を - に） */
export const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");

export const headings = (file: string) => {
  const text = readFileSync(join(ROOT, file), "utf8").replace(/```[\s\S]*?```/g, "");
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
};

/** 相対リンク（[文字](パス#アンカー)）。コードブロックの中と外部の URL は除く */
export function links(file: string): { target: string; anchor?: string }[] {
  const text = readFileSync(join(ROOT, file), "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((href) => !/^[a-z]+:/i.test(href))
    .map((href) => {
      const [path, anchor] = href.split("#");
      const target = path ? relative(ROOT, resolve(dirname(join(ROOT, file)), decodeURIComponent(path))) : file;
      return { target, anchor: anchor ? decodeURIComponent(anchor) : undefined };
    });
}
