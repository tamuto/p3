import { useEffect, useId } from "react";

/**
 * 保存していない入力と、送っている保存（プロジェクトを切り替える前に確かめる）。
 * 入力欄を持つ画面は useUnsaved(dirty) で知らせる。保存（変える API）は api.ts が数える
 */
const dirty = new Set<string>();
let saving = 0;
const waiters = new Set<() => void>();

export function useUnsaved(flag: boolean) {
  const id = useId();
  useEffect(() => {
    if (!flag) return;
    dirty.add(id);
    return () => {
      dirty.delete(id);
    };
  }, [id, flag]);
}

export const hasUnsaved = () => dirty.size > 0;

/** 変える API を送っている間（api.ts） */
export async function trackSave<T>(p: Promise<T>): Promise<T> {
  saving += 1;
  try {
    return await p;
  } finally {
    saving -= 1;
    if (!saving) for (const w of waiters) w();
  }
}

export const savesInFlight = () => saving;

/** 送っている保存が全部終わるまで待つ（結果が決まってから切り替える） */
export function savesSettled(): Promise<void> {
  if (!saving) return Promise.resolve();
  return new Promise((r) => {
    const w = () => {
      waiters.delete(w);
      r();
    };
    waiters.add(w);
  });
}
