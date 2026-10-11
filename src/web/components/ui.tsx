import type { ButtonHTMLAttributes, ReactNode } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300 dark:disabled:bg-indigo-900",
  secondary:
    "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-700",
  ghost: "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
  danger: "bg-rose-600 text-white hover:bg-rose-500",
};

/** ボタンの見た目（リンクをボタンとして見せるときにも使う） */
export const buttonCls = (variant: Variant = "secondary", className?: string) =>
  cx(
    "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-base font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50",
    variants[variant],
    className,
  );

export function Button({ variant = "secondary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button {...p} className={buttonCls(variant, className)} />;
}

const tones = {
  slate: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-900",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
  amber: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
  rose: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900",
  violet: "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-900",
};
export type Tone = keyof typeof tones;

export function Badge({ tone = "slate", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm ring-1 ring-inset whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Id({ id, onClick }: { id: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="shrink-0 font-mono text-sm whitespace-nowrap text-slate-500 enabled:hover:text-indigo-600 enabled:hover:underline dark:text-slate-400"
    >
      {id}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</span>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded-md border-0 bg-white px-2.5 py-1.5 text-base ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-indigo-500 focus:outline-none dark:bg-slate-900 dark:ring-slate-700";

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Meter({ value, tone }: { value: number; tone: "emerald" | "amber" | "rose" }) {
  const color = { emerald: "bg-emerald-500", amber: "bg-amber-500", rose: "bg-rose-500" }[tone];
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
      <div className={cx("h-full rounded-full", color)} style={{ width: `${value}%` }} />
    </div>
  );
}

export const scoreTone = (v: number) => (v >= 70 ? "emerald" : v >= 45 ? "amber" : "rose") as "emerald" | "amber" | "rose";

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-slate-300 p-4 text-center text-slate-500 dark:border-slate-700">{children}</p>;
}
