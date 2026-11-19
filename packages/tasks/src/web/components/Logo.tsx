/**
 * ロゴ: P³（infodb p3）。favicon と同じ SVG（src/web/public/favicon.svg）。
 * 文字はパスにしてあるので、環境のフォントに左右されない。
 */
export function Logo() {
  return <img src="/favicon.svg" alt="infodb p3" width={32} height={32} className="h-8 w-8 shrink-0 select-none" draggable={false} />;
}
