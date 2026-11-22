import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { htmlAsText, markdownHref } from "../lib/markdown.ts";

/**
 * 読むだけの Markdown（GFM の表・チェックリストを含む）。リンク・HTML・画像の扱いは lib/markdown.ts。
 * コードと表は本文の中で横にスクロールし、長い語は折り返す
 */
const components: Components = {
  h1: ({ children }) => <h3 className="mt-5 mb-2 text-xl font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-5 mb-2 text-lg font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 mb-2 font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  ul: ({ children, className }) => (
    <ul className={className?.includes("contains-task-list") ? "my-2 space-y-1 pl-1" : "my-2 list-disc space-y-1 pl-6"}>{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="my-2 list-decimal space-y-1 pl-6">
      {children}
    </ol>
  ),
  li: ({ children, className }) => <li className={className?.includes("task-list-item") ? "list-none" : undefined}>{children}</li>,
  // チェックリストは読むだけ（remark-gfm が disabled で出す）
  input: ({ type, checked }) => <input type={type} checked={checked} disabled readOnly className="mr-1.5 align-middle" />,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-4 border-line-strong pl-3 text-fg-3">{children}</blockquote>,
  hr: () => <hr className="my-4 border-line" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-md bg-surface-2 p-3 text-base leading-relaxed">{children}</pre>,
  code: ({ children, className }) =>
    // ブロック（pre の中）は言語のクラスが付くか改行を含む。インラインだけ背景を付けて折り返す
    className || String(children).includes("\n") ? (
      <code className="font-mono">{children}</code>
    ) : (
      <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] break-all">{children}</code>
    ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-base">{children}</table>
    </div>
  ),
  th: ({ children, style }) => <th style={style} className="border border-line-strong bg-surface-2 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children, style }) => <td style={style} className="border border-line-strong px-2 py-1 align-top">{children}</td>,
  a: ({ href, children }) => {
    const safe = href ? markdownHref(href) : null;
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer" className="break-all text-accent underline">
        {children}
      </a>
    ) : (
      <span title={href || undefined}>{children}</span>
    );
  },
  img: ({ alt }) => <span className="rounded bg-surface-2 px-1 text-fg-4">画像: {alt || "（代替テキストなし）"}</span>,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words">
      {/* URL はそのまま渡し、リンクにするかは a で決める（文字で出すときに元の値を見せるため） */}
      <ReactMarkdown remarkPlugins={[remarkGfm, htmlAsText]} components={components} urlTransform={(url) => url}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
