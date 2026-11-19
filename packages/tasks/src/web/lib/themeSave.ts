import type { Theme } from "../../shared/types.ts";

/**
 * 設定画面でテーマを選んだときの保存の流れ（画面の部品から切り出して、Node でテストする）。
 *
 *   - 選んだら保存し、保存できてから画面に反映する（apply）。保存先は個人設定だけ
 *   - 保存中にまた選んだら、今の保存が終わってから最後に選んだものだけを保存する（1つずつ。応答の順が入れ替わって
 *     古いテーマに戻ることはない）
 *   - 失敗したら知らせ、選択の表示を保存済みのテーマに戻す。failed に選んだものを残し、retry でやり直せる
 *   - 保存中でなければ、ほかの画面・CLI で変わった値（sync）を取り込む
 */
export interface ThemeSaveState {
  /** 保存済み（画面に反映しているもの） */
  saved: Theme;
  /** 選択の表示 */
  selected: Theme;
  saving: boolean;
  error: string | null;
  /** 保存できなかった選択（やり直し用） */
  failed: Theme | null;
}

export interface ThemeSaver {
  state(): ThemeSaveState;
  select(theme: Theme): Promise<void>;
  retry(): Promise<void>;
  sync(theme: Theme): void;
}

export function createThemeSaver(opts: {
  initial: Theme;
  save: (theme: Theme) => Promise<Theme>;
  apply: (theme: Theme) => void;
  onChange?: (s: ThemeSaveState) => void;
}): ThemeSaver {
  let s: ThemeSaveState = { saved: opts.initial, selected: opts.initial, saving: false, error: null, failed: null };
  let pending: Theme | undefined;
  let running: Promise<void> | undefined;
  const set = (patch: Partial<ThemeSaveState>) => {
    s = { ...s, ...patch };
    opts.onChange?.(s);
  };

  const run = async (theme: Theme): Promise<void> => {
    set({ saving: true, error: null, failed: null });
    try {
      const saved = await opts.save(theme);
      opts.apply(saved);
      set({ saved });
    } catch (e) {
      pending = undefined;
      set({ saving: false, selected: s.saved, error: (e as Error).message || "保存できませんでした", failed: theme });
      return;
    }
    const next = pending;
    pending = undefined;
    if (next !== undefined && next !== s.saved) return run(next);
    set({ saving: false, selected: s.saved });
  };

  const select = (theme: Theme): Promise<void> => {
    set({ selected: theme, error: null, failed: null });
    if (running) {
      pending = theme;
      return running;
    }
    if (theme === s.saved) return Promise.resolve();
    running = run(theme).finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    state: () => s,
    select,
    retry: () => (s.failed ? select(s.failed) : Promise.resolve()),
    sync(theme) {
      if (running || theme === s.saved) return;
      opts.apply(theme);
      set({ saved: theme, selected: theme });
    },
  };
}
