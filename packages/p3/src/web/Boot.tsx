import { useCallback, useEffect, useState } from "react";
import { App } from "./App.tsx";
import { ProjectChooser, type ProjectListing } from "./components/ProjectChooser.tsx";
import { fixScope, listRequested, projectFromPath, projectPath } from "@infodb/p3-tasks/web/lib/scope.ts";
import { isObserverPath, OBSERVER_PAGE } from "@infodb/p3-observer/shared/status.ts";
import { isProduct, type Product } from "../shared/products.ts";
import { fixShell } from "./shell.ts";

type BootState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  /** tasks の画面（AppDataProvider あり）か、tasks を読まない製品の画面（observer のページ） */
  | { kind: "app"; tasks: boolean }
  /** この serve で選んでいない製品のページを開いた */
  | { kind: "disabled"; product: Product; products: readonly Product[] }
  /** プロジェクトを跨ぐ serve で、まだ選んでいない・開けない（problem に理由） */
  | { kind: "chooser"; listing: ProjectListing; requested?: string; problem?: string };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

/**
 * ページを開いたときに、この画面の製品と対象を決める（shell.ts・lib/scope.ts）。
 *   /observer: observer を選んだ serve なら observer のページ（tasks のプロジェクトを決めず、tasks の API を読まない）。選んでいなければ無効と出す
 *   observer だけの serve: ほかの URL は /observer へ移る
 *   通常の serve: そのまま画面を出す
 *   プロジェクトを跨ぐ serve: URL の /projects/<名前> を一覧で確かめ、開けたら画面を出す。入口（/）で登録が1つだけなら
 *   そのプロジェクトへ移る。ほかは一覧（選ぶだけ）。登録に無い・開けないときは一覧に理由を出す
 */
async function boot(): Promise<BootState> {
  const info = await getJson<{ mode: string; products: string[] }>("/api/mode");
  const mode = info.mode === "all-projects" ? "all-projects" : info.mode === "none" ? "none" : "single";
  const products = info.products.filter(isProduct);
  if (isObserverPath(location.pathname)) {
    if (!products.includes("observer")) return { kind: "disabled", product: "observer", products };
    fixShell({ products, tasks: false, mode });
    return { kind: "app", tasks: false };
  }
  if (!products.includes("tasks")) {
    // tasks を使わない serve（observer だけ）。tasks の URL は開かず、observer のページへ移る（履歴に残さない）
    location.replace(OBSERVER_PAGE);
    return { kind: "loading" };
  }
  fixShell({ products, tasks: true, mode });
  if (mode !== "all-projects") {
    fixScope({ mode: "single" });
    return { kind: "app", tasks: true };
  }
  const listing = await getJson<ProjectListing>("/api/projects");
  const requested = projectFromPath(location.pathname);
  if (!requested) {
    // 登録が1つで開けるなら一覧を飛ばす（知らせることがあるとき・一覧を求められたときは出す）。履歴に一覧を残さない
    const only = listing.projects.length === 1 ? listing.projects[0] : undefined;
    if (only?.state === "ok" && !listing.invalid.length && !listing.configError && !listRequested(location.search)) {
      location.replace(`${projectPath(only.name)}/`);
      return { kind: "loading" };
    }
    return { kind: "chooser", listing };
  }
  const p = listing.projects.find((x) => x.name === requested);
  if (!p) return { kind: "chooser", listing, requested, problem: `プロジェクト「${requested}」は個人設定に登録されていません。` };
  if (p.state === "error") return { kind: "chooser", listing, requested, problem: p.error };
  // 開けるかを先に確かめる（開けなければ理由を出して一覧に戻す。読み込み中のままにしない）
  try {
    await getJson(`/api${projectPath(requested)}/project`);
  } catch (e) {
    return { kind: "chooser", listing, requested, problem: (e as Error).message };
  }
  fixScope({ mode: "all-projects", project: requested, generation: p.generation });
  return { kind: "app", tasks: true };
}

export function Boot() {
  const [state, setState] = useState<BootState>({ kind: "loading" });
  const start = useCallback(() => {
    setState({ kind: "loading" });
    boot().then(setState, (e: Error) => setState({ kind: "error", message: e.message }));
  }, []);
  useEffect(start, [start]);

  if (state.kind === "app") return <App tasks={state.tasks} />;
  if (state.kind === "disabled") return <DisabledProduct product={state.product} products={state.products} />;
  if (state.kind === "chooser") return <ProjectChooser initial={state.listing} requested={state.requested} problem={state.problem} />;
  if (state.kind === "error")
    return (
      <div className="space-y-2 p-8">
        <p role="alert" className="text-rose-600">
          画面を開けませんでした: {state.message}
        </p>
        <button type="button" className="underline" onClick={start}>
          もう一度読み込む
        </button>
      </div>
    );
  return <div className="p-8 text-slate-500">Loading…</div>;
}

const PRODUCT_LABEL: Record<Product, string> = { tasks: "タスク管理（tasks）", observer: "観測基盤（observer）" };

/** 選んでいない製品のページ（直接開いたとき）。その製品の API は読まない */
function DisabledProduct({ product, products }: { product: Product; products: readonly Product[] }) {
  return (
    <div className="mx-auto max-w-xl space-y-3 p-10">
      <h1 className="text-xl font-bold">{PRODUCT_LABEL[product]}はこの起動では使えません</h1>
      <p role="alert">
        この p3 serve で使える製品は {products.map((p) => PRODUCT_LABEL[p]).join("・")} です（--products で選んで起動しています）。使うには、
        --products を外すか、
        <code className="mx-1 rounded bg-slate-100 px-1 dark:bg-slate-800">--products {[...products, product].join(",")}</code>
        で起動し直してください。
      </p>
      <a href="/" className="underline">
        トップへ戻る
      </a>
    </div>
  );
}
