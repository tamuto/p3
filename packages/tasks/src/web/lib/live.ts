import { useEffect, useRef } from "react";
import type { ServerEvent } from "../../shared/types.ts";
import { apiBase } from "./scope.ts";

/** サーバからの変更通知 (SSE)。ファイルが直接編集された場合もここに届く */
export function useServerEvents(handler: (e: ServerEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const es = new EventSource(`${apiBase()}/events`);
    es.onmessage = (m) => {
      try {
        ref.current(JSON.parse(m.data));
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, []);
}
