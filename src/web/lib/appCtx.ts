import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import { useAppData, type AppData } from "./appData.tsx";

/** 各画面に渡す文脈。共有データに、URL の状態（絞り込み）と画面遷移を足したもの */
export interface AppCtx extends AppData {
  /** 作業ツリー（要望）での絞り込み（?stream=） */
  stream: string | null;
  /** タスク詳細を開く（?task=。今の画面の上に重ねる） */
  openTask: (id: string) => void;
  /** 要望の詳細へ移る（/preflight/$requestId） */
  openRequest: (id: string) => void;
}

export function useAppCtx(): AppCtx {
  const data = useAppData();
  const navigate = useNavigate();
  const { stream } = useSearch({ strict: false });
  return useMemo(
    () => ({
      ...data,
      stream: stream ?? null,
      openTask: (id: string) => void navigate({ to: ".", search: (prev) => ({ ...prev, task: id }) }),
      openRequest: (id: string) =>
        void navigate({ to: "/preflight/$requestId", params: { requestId: id }, search: (prev) => ({ stream: prev.stream }) }),
    }),
    [data, stream, navigate],
  );
}
