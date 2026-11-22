import { useState } from "react";
import { addTag, cleanTag } from "../../shared/tags.ts";
import { Button, cx, IconButton, inputCls } from "@infodb/p3-shared/web/ui.tsx";

/**
 * タグ（外部 ID・分類）の入力。値ごとに足す・外す（カンマで分けない。shared/tags.ts）。
 * 長い値は折り返して全文を出す。入力中の文字（まだ足していないもの）は text / onText で呼ぶ側が持てる。
 */
export function TagInput({
  tags,
  onChange,
  disabled,
  text: textProp,
  onText,
  id,
}: {
  tags: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  text?: string;
  onText?: (t: string) => void;
  /** 入力欄の id（ラベルから指す） */
  id?: string;
}) {
  const [own, setOwn] = useState("");
  const text = textProp ?? own;
  const setText = onText ?? setOwn;
  const [hint, setHint] = useState<string | null>(null);

  const add = () => {
    const t = cleanTag(text);
    if (t === null) return;
    if (tags.includes(t)) return setHint(`「${t}」は付いています`);
    setHint(null);
    onChange([...addTag(tags, t)]);
    setText("");
  };

  return (
    <div className="space-y-2">
      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="付いているタグ">
          {tags.map((t) => (
            <li
              key={t}
              className="inline-flex max-w-full items-start gap-1 rounded bg-surface-2 py-0.5 pr-0.5 pl-2 text-base ring-1 ring-line ring-inset"
            >
              <span className="min-w-0 break-all whitespace-pre-wrap">{t}</span>
              <IconButton disabled={disabled} aria-label={`タグ「${t}」を外す`} title="外す" onClick={() => onChange(tags.filter((x) => x !== t))}>
                ×
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="flex max-w-md gap-2">
        <input
          id={id}
          className={cx(inputCls, "min-w-0 flex-1")}
          value={text}
          disabled={disabled}
          placeholder="例: jira:PROJ-123、group:顧客A"
          onChange={(e) => (setText(e.target.value), setHint(null))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button disabled={disabled || cleanTag(text) === null} onClick={add}>
          追加
        </Button>
      </div>
      {hint && (
        <p role="status" className="text-base text-fg-4">
          {hint}
        </p>
      )}
    </div>
  );
}
