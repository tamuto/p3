import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { useAppData, type AppData } from "./appData.tsx";

/** 各画面に渡す文脈。共有データに画面遷移を足したもの */
export interface AppCtx extends AppData {
  /**
   * 要望かタスクを開く（ref は <要望ID> か <要望ID>/T003）。
   * 今開いている要望のタスクなら、今のページの上にタスク詳細を重ねる。別の要望ならその要望の概要へ移る。
   */
  open: (ref: string) => void;
}

export function useAppCtx(): AppCtx {
  const data = useAppData();
  const navigate = useNavigate();
  const { requestId: here } = useParams({ strict: false });
  return useMemo(() => {
    const open = (ref: string) => {
      const [requestId, task] = ref.split("/");
      if (requestId === here) void navigate({ to: ".", search: (prev) => ({ ...prev, task }) });
      else void navigate({ to: "/requests/$requestId", params: { requestId }, search: { task } });
    };
    return { ...data, open };
  }, [data, navigate, here]);
}
