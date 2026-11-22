import { useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** キーボードで移ったときのフォーカスの枠（押せる部品が共通に持つ） */
export const FOCUS = "focus-visible:ring-2 focus-visible:ring-accent-solid focus-visible:outline-none";

/**
 * ボタンの種類（docs/development.md「画面の共通部品」）。どれも塗りで示し、枠だけのボタンは作らない。
 *   primary 主操作（濃い塗り）/ secondary 補助の操作（薄い塗り）/ cancel 取消・閉じる・入力を捨てる / danger 消す（対象をラベルに書く）/
 *   link 移動や控えめな操作（下線の文字）
 */
type Variant = "primary" | "secondary" | "cancel" | "danger" | "link";
const variants: Record<Variant, string> = {
  primary: "bg-accent-solid text-white hover:bg-accent-solid/85 disabled:bg-accent-muted",
  secondary: "bg-accent-muted text-accent-strong hover:bg-accent-line",
  cancel: "bg-surface-3 text-fg hover:bg-line-strong",
  danger: "bg-danger-solid text-white hover:bg-danger-solid/85",
  link: "px-1! text-accent underline hover:text-accent-strong",
};

/** ボタンの見た目（リンクをボタンとして見せるときにも使う） */
export const buttonCls = (variant: Variant = "secondary", className?: string) =>
  cx(
    "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-base font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50",
    FOCUS,
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
          "relative cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-solid has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        )}
      >
        <input ref={inputRef} type="file" className="sr-only" {...p} />
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" />
        </svg>
        {label}
      </label>
      {chosen !== undefined && <span className="min-w-0 break-all text-base text-fg-4">{chosen || "選ばれていません"}</span>}
    </span>
  );
}

const tones = {
  slate: "bg-surface-2 text-fg-2 ring-line-strong",
  indigo: "bg-accent-soft text-accent ring-accent-line",
  emerald: "bg-ok-soft text-ok ring-ok-line",
  amber: "bg-warn-soft text-warn-strong ring-warn-line",
  rose: "bg-danger-soft text-danger ring-danger-line",
  violet: "bg-special-soft text-special ring-special-line",
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
      className={cx("shrink-0 font-mono text-sm whitespace-nowrap text-fg-4 enabled:hover:text-accent enabled:hover:underline", FOCUS)}
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
        <span className="text-base font-medium text-fg-2">{label}</span>
        {children}
      </label>
      {hint && <span data-aux className="text-sm text-fg-3">{hint}</span>}
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}

/** 複数を選ぶチェックボックスの並び（見出しは legend。説明と項目の誤りは Field と同じく下に出す） */
export function CheckGroup({ label, options, value, onChange, hint, error, empty }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; hint?: ReactNode; error?: ReactNode; empty?: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="text-base font-medium text-fg-2">{label}</legend>
      {options.length === 0 && <span className="text-fg-4">{empty ?? "選べるものがありません。"}</span>}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((o) => (
          <label key={o.value} className="flex min-w-0 items-center gap-1 break-words">
            <input type="checkbox" checked={value.includes(o.value)} aria-invalid={!!error} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))} />
            {o.label}
          </label>
        ))}
      </div>
      {hint && <span data-aux className="text-sm text-fg-3">{hint}</span>}
      {error && <span className="text-danger">{error}</span>}
    </fieldset>
  );
}

export const inputCls =
  "w-full rounded-md border-0 bg-surface px-2.5 py-1.5 text-base ring-1 ring-line-strong ring-inset focus:ring-2 focus:ring-accent-solid focus:outline-none aria-[invalid=true]:ring-danger-solid disabled:opacity-50";

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-lg font-semibold text-fg">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Meter({ value, tone }: { value: number; tone: "emerald" | "amber" | "rose" }) {
  const color = { emerald: "bg-ok-solid", amber: "bg-warn-solid", rose: "bg-danger-solid" }[tone];
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={cx("h-full rounded-full", color)} style={{ width: `${value}%` }} />
    </div>
  );
}

export const scoreTone = (v: number) => (v >= 70 ? "emerald" : v >= 45 ? "amber" : "rose");

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-line-strong p-4 text-center text-fg-4">{children}</p>;
}

/** 失敗・注意の知らせ（支援技術にも伝える）。box は枠の中に、warn は注意の色で出す。中に一覧なども置ける */
export function Alert({ children, box, warn, className }: { children: ReactNode; box?: boolean; warn?: boolean; className?: string }) {
  const tone = warn ? "text-warn-strong" : box ? "text-danger-strong" : "text-danger";
  const frame = box && cx("rounded-md px-3 py-2", warn ? "bg-warn-soft" : "bg-danger-soft");
  return (
    <div role="alert" className={cx("text-base break-words whitespace-pre-wrap", tone, frame, className)}>
      {children}
    </div>
  );
}

/** 読み込み中の表示 */
export const Loading = ({ children = "読み込み中…" }: { children?: ReactNode }) => <p className="text-fg-4">{children}</p>;

/** 文中のリンクの見た目（a・Link に付ける） */
export const linkCls = "text-accent underline hover:text-accent-strong";

/** 小さな記号のボタン（タグを外す ×・子の開閉 ▸ など）。読み上げの名前（aria-label）を必ず渡す */
export function IconButton({ className, type = "button", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string }) {
  return <button type={type} {...p} className={cx("shrink-0 rounded px-1 text-fg-4 hover:bg-surface-3 hover:text-fg disabled:opacity-50", FOCUS, className)} />;
}

/**
 * 中身で見せる押せる領域（一覧の行・印・サムネイル・メニューの項目など）。箱の形や色を持たず、type=button・フォーカスの枠・左寄せだけを持つ。
 * 色は意味の色（hover:text-accent など）を className で足す
 */
export function PlainButton({ className, type = "button", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return <button type={type} {...p} className={cx("text-left disabled:cursor-not-allowed", FOCUS, className)} />;
}

/** 1つを選ぶ切り替えの並び（表示の幅など）。選んだものは aria-pressed */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex gap-1 rounded-lg bg-surface-2 p-1">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={value === o.value} className={cx("min-w-9 rounded-md px-1 py-0.5", FOCUS, value === o.value ? "bg-surface shadow-sm" : "text-fg-4 hover:text-fg")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  hint?: string;
}

/**
 * タブの並び（設定・リリースノート）。矢印キー・Home・End で移る（選んだタブだけがフォーカスの順に入る）。
 * 保存していない変更があるタブには印（●・読み上げは「未保存」）を付ける。prefix はタブとパネルの id の頭
 */
export function Tabs<T extends string>({ tabs, tab, unsaved, onSelect, label, prefix }: { tabs: readonly TabDef<T>[]; tab: T; unsaved?: Partial<Record<T, boolean>>; onSelect: (t: T) => void; label: string; prefix: string }) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next].id;
    onSelect(id);
    refs.current[id]?.focus();
  };
  // 境界線は外の枠が持ち、選んだタブの下線を重ねる 1px は tablist が持つ。境界線を tablist（overflow-x-auto で縦も auto）に付けて
  // タブに -mb-px を付けると、タブが境界線に食い込んで tablist が 1px 縦に送れ、縦のスクロールバーが出る（要望のタブも同じ）
  return (
    <div className="border-b border-line">
      <div role="tablist" aria-label={label} className="-mb-px flex gap-1 overflow-x-auto" onKeyDown={onKey}>
        {tabs.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${prefix}-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`${prefix}-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              title={t.hint}
              onClick={() => onSelect(t.id)}
              className={cx("flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 font-medium whitespace-nowrap transition", FOCUS, on ? "border-accent-solid text-accent" : "border-transparent text-fg-4 hover:text-fg")}
            >
              {t.label}
              {unsaved?.[t.id] && (
                <span data-aux className="text-sm text-warn" title="保存していない変更があります">
                  ●<span className="sr-only">（未保存）</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 選んでいないタブは隠すだけ（書きかけの入力を残す） */
export function TabPanel<T extends string>({ id, tab, prefix, className, children }: { id: T; tab: T; prefix: string; className?: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${prefix}-panel-${id}`} aria-labelledby={`${prefix}-tab-${id}`} hidden={id !== tab} className={className}>
      {children}
    </div>
  );
}
