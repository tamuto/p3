import { useEffect, useState } from "react";
import type { FileState } from "../../shared/definition.ts";
import { fetchFiles } from "./api.ts";

/** ファイルの有無（"<参照先>:<パス>" ごと）。サーバが参照先の中で照らす。keys が変わったら少し待って読み直す */
export function useFileStates(keys: string[]): Record<string, { state: FileState; checkedAt: string }> {
  const [files, setFiles] = useState<Record<string, { state: FileState; checkedAt: string }>>({});
  const key = [...new Set(keys.filter((k) => /^[^:]+:.+/.test(k)))].sort().join("\n");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const t = setTimeout(() => {
      fetchFiles(key.split("\n")).then(
        (r) => alive && setFiles(r.files),
        () => {},
      );
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]);
  return files;
}
