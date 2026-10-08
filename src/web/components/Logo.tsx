/** ロゴ: P³（infodb p3）。斜体の P の右上に 3 */
export function Logo() {
  return (
    <span
      aria-label="infodb p3"
      className="inline-flex h-8 items-start rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 py-0.5 pr-1.5 pl-2 text-white shadow-sm ring-1 ring-indigo-700/20 select-none"
    >
      <span className="font-serif text-[1.45rem] leading-[1.6rem] font-black italic">P</span>
      <span className="ml-px font-serif text-[0.8rem] leading-none font-bold italic">3</span>
    </span>
  );
}
