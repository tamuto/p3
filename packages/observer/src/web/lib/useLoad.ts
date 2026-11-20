import { useEffect, useRef, useState } from "react";

export type Load<T> = { kind: "loading" } | { kind: "ok"; value: T } | { kind: "error"; message: string };

/** 開いたとき（key が変わったとき）に一度だけ読む。読み終える前に閉じた結果は捨てる */
export function useLoad<T>(f: () => Promise<T>, key = ""): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ kind: "loading" });
  const fn = useRef(f);
  fn.current = f;
  useEffect(() => {
    let alive = true;
    setLoad({ kind: "loading" });
    fn.current().then(
      (value) => alive && setLoad({ kind: "ok", value }),
      (e: Error) => alive && setLoad({ kind: "error", message: e.message }),
    );
    return () => {
      alive = false;
    };
  }, [key]);
  return load;
}
