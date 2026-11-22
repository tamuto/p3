import { Alert, Button, Field, inputCls } from "@infodb/p3-shared/web/ui.tsx";
import { useState } from "react";
import { fileKey, type FileState, type Replacement } from "../../shared/definition.ts";

/**
 * 置き換え候補のスクリプトに切り替える（観測の手順と準備の確かめ・前処理・後処理で共通）。ファイルが有ること・確かめた呼び出し方と結果が要る。
 * onSwitch は今の版を添えて保存の層に頼む
 */
export function SwitchForm({ label, replacement, files, onSwitch, onDone }: { label: string; replacement: Replacement; files: Record<string, { state: FileState }>; onSwitch: (invoke: string, evidence: string) => Promise<unknown>; onDone: () => void }) {
  const ready = files[fileKey(replacement.repo, replacement.path)]?.state === "exists";
  const [open, setOpen] = useState(false);
  const [invoke, setInvoke] = useState(replacement.invoke ?? "");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string>();
  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setOpen(true)} disabled={!ready}>
          スクリプトに切り替える
        </Button>
        {!ready && <span className="text-fg-3">用意するファイルが参照先の中に有ることを確かめられるまで切り替えられません</span>}
      </div>
    );
  return (
    <form
      className="space-y-3"
      aria-label={`${label} をスクリプトに切り替える`}
      onSubmit={(e) => {
        e.preventDefault();
        onSwitch(invoke, evidence).then(onDone, (x: Error) => setError(x.message));
      }}
    >
      {error && <Alert box>{error}</Alert>}
      <Field label="確かめた呼び出し方">
        <input className={inputCls} value={invoke} onChange={(e) => setInvoke(e.target.value)} />
      </Field>
      <Field label="確かめた結果" hint="その呼び出し方で、同じ測定項目の値が出ることを確かめた内容">
        <textarea className={inputCls} rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </Field>
      <div className="flex gap-3">
        <Button type="submit" variant="primary">
          切り替える
        </Button>
        <Button variant="cancel" onClick={() => setOpen(false)}>
          やめる
        </Button>
      </div>
    </form>
  );
}
