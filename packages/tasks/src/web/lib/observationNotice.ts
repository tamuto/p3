import { useSyncExternalStore } from "react";

/**
 * 観測のシステムの項目に記録できなかった知らせ（API の結果の observationSkipped。操作はしている）。api.ts の呼び出しが拾い、
 * 画面の外枠が閉じるまで出す（どの画面の操作でも同じ所に出す）
 */
let notices: readonly string[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function noteObservationSkipped(list: unknown) {
  if (!Array.isArray(list) || !list.length) return;
  notices = [...notices, ...list.filter((x): x is string => typeof x === "string")];
  emit();
}

export function clearObservationNotices() {
  notices = [];
  emit();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

export const useObservationNotices = () => useSyncExternalStore(subscribe, () => notices);
