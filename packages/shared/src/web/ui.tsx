import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, Ref } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/**
 * ボタンの種類（docs/development.md「画面の共通部品」）。どれも塗りで示し、枠だけのボタンは作らない。
 *   primary 主操作（濃い塗り）/ secondary 補助の操作（薄い塗り）/ cancel 取消・閉じる・入力を捨てる / danger 消す（対象をラベルに書く）/
 *   link 移動や控えめな操作（下線の文字）
 */
type Variant = "primary" | "secondary" | "cancel" | "danger" | "link";
const variants: Record<Variant, string> = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300 dark:disabled:bg-indigo-900",
  secondary: "bg-indigo-100 text-indigo-800 hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900",
  cancel: "bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
  danger: "bg-rose-600 text-white hover:bg-rose-500",
  link: "px-1! text-indigo-700 underline hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-100",
};

/** ボタンの見た目（リンクをボタンとして見せるときにも使う） */
export const buttonCls = (variant: Variant = "secondary", className?: string) =>
  cx(
    "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-base font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50",
    variants[variant],
    className,
  );

/** ボタン。type を省くと送信しないボタン（フォームを送るのは type="submit" を明示したものだけ） */
export function Button({ variant = "secondary", className, type = "button", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; ref?: Ref<HTMLButtonElement> }) {
  return <button type={type} {...p} className={buttonCls(variant, className)} />;
}

/**
 * ファイルを選ぶボタン。ブラウザ既定のファイル入力は押せるものに見えないので、入力は隠してボタンの形のラベルで開く
 * （キーボードでも入力にフォーカスが当たり、ボタンに枠が出る）。chosen を渡すと選んだファイルの名前を横に出す。
 * 隠した入力（sr-only は position: absolute）の基準はラベル（relative）にする。基準が無いと画面の左上が基準になり、
 * 本文のスクロールの中の入力の位置まで文書が縦に伸びて、本文とページの2つの縦スクロールが出る
 */
export function FilePicker({
  label = "ファイルを選ぶ",
  chosen,
  inputRef,
  ...p
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label?: string; chosen?: string; inputRef?: Ref<HTMLInputElement> }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <label
        className={buttonCls(
          "secondary",
          "relative cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        )}
      >
        <input ref={inputRef} type="file" className="sr-only" {...p} />
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" />
        </svg>
        {label}
      </label>
      {chosen !== undefined && <span className="min-w-0 break-all text-base text-slate-500">{chosen || "選ばれていません"}</span>}
    </span>
  );
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
    <span data-aux title={title} className={cx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm ring-1 ring-inset whitespace-nowrap", tones[tone], className)}>
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

/** 入力欄の見出し。説明（hint）と項目の誤り（error）は入力欄の下に出す（入力欄の名前は見出しだけにする） */
export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: ReactNode; error?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-base font-medium text-slate-700 dark:text-slate-300">{label}</span>
        {children}
      </label>
      {hint && <span data-aux className="text-sm text-slate-600 dark:text-slate-400">{hint}</span>}
      {error && <span className="text-sm text-rose-600">{error}</span>}
    </div>
  );
}

export const inputCls =
  "w-full rounded-md border-0 bg-white px-2.5 py-1.5 text-base ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-indigo-500 focus:outline-none aria-[invalid=true]:ring-rose-500 disabled:opacity-50 dark:bg-slate-900 dark:ring-slate-700";

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{title}</h3>
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

export const scoreTone = (v: number) => (v >= 70 ? "emerald" : v >= 45 ? "amber" : "rose");

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-slate-300 p-4 text-center text-slate-500 dark:border-slate-700">{children}</p>;
}

/** 失敗・注意の知らせ（支援技術にも伝える）。box は枠の中に、warn は注意の色で出す */
export function Alert({ children, box, warn, className }: { children: ReactNode; box?: boolean; warn?: boolean; className?: string }) {
  const tone = warn ? "text-amber-800 dark:text-amber-300" : box ? "text-rose-800 dark:text-rose-300" : "text-rose-600";
  const frame = box && (warn ? "rounded-md bg-amber-50 px-3 py-2 dark:bg-amber-950" : "rounded-md bg-rose-50 px-3 py-2 dark:bg-rose-950");
  return (
    <p role="alert" className={cx("text-base break-words whitespace-pre-wrap", tone, frame, className)}>
      {children}
    </p>
  );
}

/** 読み込み中の表示 */
export const Loading = ({ children = "読み込み中…" }: { children?: ReactNode }) => <p className="text-slate-500 dark:text-slate-400">{children}</p>;

/** 文中のリンクの見た目（a・Link に付ける） */
export const linkCls = "text-indigo-700 underline hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-100";
