import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Logo } from "@infodb/p3-tasks/web/components/Logo.tsx";
import { Button, buttonCls, cx, Empty } from "@infodb/p3-shared/web/ui.tsx";
import { useAppCtx } from "@infodb/p3-tasks/web/lib/appCtx.ts";
import { useProjectSwitcher } from "../components/ProjectSwitcher.tsx";
import { clearObservationNotices, useObservationNotices } from "@infodb/p3-tasks/web/lib/observationNotice.ts";

/**
 * 全画面の共通部分。ページは src/web/routes/ にファイルを置けば足りる（ルート一覧 routeTree.gen.ts は自動生成）。
 *
 *   /                                   進捗（全要望の横断）
 *   /observer?m=                        観測の項目と最後の値（/observer/new 項目の登録・/observer/$key 項目と値。p3-observer のページ）
 *   /requests/new                       新しい要望
 *   /requests/$requestId                要望の概要と Preflight（?run=）
 *   /requests/$requestId/board          要望のタスクボード（V 字: 未着手 → 作業中 → 完了）
 *   /requests/$requestId/done           要望の対応済み（済みにしたタスク）
 *   /release-notes?tab=                 マイルストーンの管理（既定）/ notes リリースノート（?m=）/ review レビュー
 *   /settings?tab=                      設定（personal 個人 / project プロジェクトの基本 / repos 参照先）
 *
 * 要望の中のページでは ?task=T003 でタスク詳細を重ねて開く。URL を共有すれば同じ画面が開ける。
 */
export const Route = createRootRoute({
  component: Layout,
  notFoundComponent: () => (
    <div className="mx-auto max-w-xl p-10">
      <Empty>ページが見つかりません</Empty>
    </div>
  ),
});

const NAV = [
  { to: "/", label: "進捗", hint: "要望ごとの状況" },
  { to: "/observer", label: "観測", hint: "項目キーごとの値（システムが記録する到達時間・受け入れ基準・手戻りと、利用者が決めた項目）" },
  { to: "/release-notes", label: "リリースノート", hint: "マイルストーンごとの機能の要約" },
  { to: "/settings", label: "設定", hint: "個人・プロジェクトの基本・参照先" },
] as const;

const navCls = "rounded-md px-3 py-1.5 font-medium whitespace-nowrap transition";
const navActive = "bg-accent-soft text-accent";
const navIdle = "text-fg-3 hover:bg-surface-2";

function Layout() {
  const ctx = useAppCtx();
  const pathname = useLocation({ select: (l) => l.pathname });
  const errors = Object.keys(ctx.info.errors);
  // プロジェクトを跨ぐ serve では、ロゴの横のプロジェクト名を切り替えの欄にする（通常の serve では null）
  const switcher = useProjectSwitcher();
  const allProjects = switcher.picker !== null;
  // 観測のシステムの項目に記録できなかった知らせ（操作はしている。閉じるまで出す）
  const observationNotices = useObservationNotices();

  return (
    <div className="flex h-screen flex-col">
      <header
        className="flex flex-wrap items-center gap-3 gap-y-2 border-b sm:gap-6 sm:gap-y-2 border-line bg-surface px-5 py-2.5"
      >
        {/* 狭い画面ではプロジェクト名を出さず（ロゴの title にある）、見出しが画面の幅に収まるようにする。
            プロジェクトを跨ぐ serve では、名前の代わりに切り替えの欄をロゴの横（リンクの外）に置き、狭い画面でも隠さない */}
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/" className="flex min-w-0 items-center gap-3" title={`infodb p3 · ${ctx.info.project.name}`}>
            <Logo />
            {!allProjects && <span className="hidden truncate font-medium sm:inline">{ctx.info.project.name}</span>}
          </Link>
          {switcher.picker}
        </div>
        {/* 広い画面（lg 未満）でなければ、ナビゲーションを次の行に回し、ロゴ・切り替えの欄・再読み込み・作成の操作に1行目の幅を空ける。
            それでも収まらない幅では横にスクロールさせる（ページ全体は横にはみ出さない） */}
        <nav className="order-last flex min-w-0 basis-full gap-1 overflow-x-auto lg:order-none lg:shrink lg:basis-auto">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              title={n.hint}
              className={navCls}
              activeOptions={{ exact: n.to === "/" }}
              activeProps={{ className: navActive }}
              inactiveProps={{ className: navIdle }}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <RefreshButton running={ctx.refreshing.running} onClick={() => void ctx.refresh()} />
        {/* 作成の操作は隣り合わせにまとめる。狭い画面では「新しい」を出さずに（＋要望・＋観測項目。読み上げは aria-label で「新しい要望」「新しい観測項目」）、
            ナビゲーションの幅を空けつつ二つを見分けられるようにする。観測は二つ目の操作として控えめの色にする */}
        <div className="flex shrink-0 items-center gap-2">
          <Link to="/requests/new" className={buttonCls("primary", "whitespace-nowrap")} title="新しい要望" aria-label="新しい要望">
            <span>＋<span className="hidden sm:inline">新しい</span>要望</span>
          </Link>
          <Link to="/observer/new" className={buttonCls("secondary", "whitespace-nowrap")} title="新しい観測項目" aria-label="新しい観測項目">
            <span>＋<span className="hidden sm:inline">新しい</span>観測項目</span>
          </Link>
        </div>
        {errors.length > 0 && (
          <span className="text-base text-danger" title={errors.map((f) => `${f}: ${ctx.info.errors[f]}`).join("\n")}>
            ⚠ 読めないファイル {errors.length} 件
          </span>
        )}
      </header>
      {switcher.notices}

      {observationNotices.length > 0 && (
        <div role="alert" className="flex flex-wrap items-start gap-x-3 gap-y-1 bg-warn-soft px-5 py-2 text-warn-strong">
          <ul className="min-w-0 flex-1 break-words">
            {observationNotices.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          <Button variant="link" onClick={clearObservationNotices}>
            閉じる
          </Button>
        </div>
      )}

      {ctx.refreshing.error && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-danger-soft px-5 py-2 text-danger-strong">
          <span className="min-w-0 break-words">再読み込みできませんでした（表示は前の内容のまま）: {ctx.refreshing.error}</span>
          <Button variant="link" onClick={() => void ctx.refresh()}>
            もう一度
          </Button>
        </div>
      )}

      {!ctx.info.project.description && !pathname.startsWith("/settings") && (
        <div className="flex items-center gap-3 bg-warn-soft px-5 py-2 text-warn-strong">
          プロジェクトの説明がまだありません。Preflight の前提になるので設定してください。
          <Link to="/settings" search={{ tab: "project" }} className={buttonCls("link", "underline")}>
            設定を開く
          </Link>
        </div>
      )}

      {/* スクロールする枠は relative にする。基準の無い絶対配置（sr-only の入力・見出しなど）は画面の左上を基準にし、
          枠の中の位置まで文書を縦に伸ばして、枠とページの2つの縦スクロールを出す */}
      <main className="relative min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * データのフォルダを全部読み直して画面を取り直す（CLI など外での変更を取り込む。ブラウザのリロードはしない）。
 * 読み直している間も押せる（終わってからもう1回だけ読む）。狭い画面ではアイコンだけ
 */
function RefreshButton({ running, onClick }: { running: boolean; onClick: () => void }) {
  return (
    <Button onClick={onClick} aria-busy={running} title="データのフォルダを読み直して、外（CLI など）での変更を取り込みます" className="ml-auto px-2 sm:px-3">
      <svg aria-hidden viewBox="0 0 16 16" className={cx("size-4", running && "animate-spin")} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
        <path d="M13.5 2.5v3h-3" />
      </svg>
      <span className="sr-only sm:not-sr-only">{running ? "読み込み中…" : "再読み込み"}</span>
    </Button>
  );
}
