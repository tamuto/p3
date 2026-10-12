/**
 * Preflight が読む参照先（リポジトリ・フォルダ）。数と名前はプロジェクトごとに自由。
 *
 *   project.yaml（共有）: 名前・役割・最初に読むか・作業先になりうるか・主なフォルダ
 *   個人設定（共有しない）: 名前 → このマシンのパス（projects.<名前>.repos）
 *
 * 参照の書き方: `<参照先の名前>:<参照先の中のパス>`（例: `docs:guide/`）。名前を付けなければ先頭の参照先。
 */

/** 主なフォルダの1行: フォルダとその役割・入口 */
export interface CodeMapEntry {
  path: string;
  role: string;
  entry?: string;
}

export interface RepoRef {
  /** 論理名（任意。空白・コロン・スラッシュ・バックスラッシュは使えない） */
  name: string;
  /** 役割の説明（例: システム本体 / ドキュメント / 基盤 / 依存しているライブラリ） */
  role: string;
  /** Preflight で最初に読む対象か */
  readFirst: boolean;
  /** タスクの作業先になりうるか（今は表示だけ。作業先の多重化は別の要望） */
  writable: boolean;
  /** 主なフォルダ（どこから読むかの案内。全部読む指示ではない） */
  map: CodeMapEntry[];
  /** 構成の説明を書いた Markdown（参照先の中のパス） */
  mapFile?: string;
}

export const REPO_NAME = /^[^\s:/\\]+$/;

/** 参照先の名前として使えるか（理由。使えれば undefined） */
export function repoNameProblem(name: string): string | undefined {
  if (!name) return "名前が空です";
  if (!REPO_NAME.test(name)) return `「${name}」は使えません（空白・コロン・スラッシュ・バックスラッシュを含めない）`;
  if (name === "." || name === "..") return `「${name}」は使えません`;
  return undefined;
}

/**
 * コンテナに置く名前（/workspace/<名前>）。論理名から英数字と . _ - だけを残し、空・重複は番号で分ける。
 * 返す配列は repos と同じ順
 */
export function mountNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((n, i) => {
    let base = n.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
    if (!base) base = `repo${i + 1}`;
    let m = base;
    for (let k = 2; used.has(m); k++) m = `${base}-${k}`;
    used.add(m);
    return m;
  });
}

export interface RepoPath {
  /** 参照先の名前 */
  repo: string;
  /** 参照先の中の相対パス（"" は参照先の全体）。末尾の / と先頭の ./ は除く */
  path: string;
  /** 名前を書いたか */
  qualified: boolean;
}

export type ParsedRepoPath = ({ ok: true } & RepoPath) | { ok: false; reason: string; raw: string };

/**
 * `<名前>:<パス>` か `<パス>`（既定の参照先）を読む。名前が登録に無い・パスが絶対か .. を含むときは ok: false
 * （別のリポジトリの同じパスとして扱ったりしない）。
 */
export function parseRepoPath(raw: string, known: readonly string[], defaultRepo: string | undefined): ParsedRepoPath {
  const s = raw.trim();
  const m = /^([^\s:/\\]+):(.*)$/.exec(s);
  let repo: string | undefined;
  let rest: string;
  let qualified = false;
  if (m && known.includes(m[1])) {
    repo = m[1];
    rest = m[2];
    qualified = true;
  } else if (m && !/^[A-Za-z]:[\\/]/.test(s)) {
    return { ok: false, reason: `参照先「${m[1]}」は登録されていません`, raw };
  } else {
    repo = defaultRepo;
    rest = s;
  }
  if (!repo) return { ok: false, reason: "参照先がありません", raw };
  const path = rest.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return { ok: false, reason: `参照先の中の相対パスで書いてください: ${raw}`, raw };
  if (path.split("/").includes("..")) return { ok: false, reason: `.. は使えません: ${raw}`, raw };
  return { ok: true, repo, path: path === "." ? "" : path, qualified };
}

/** 書き戻すときの形（既定の参照先なら名前を付けない） */
export const formatRepoPath = (p: RepoPath, defaultRepo: string | undefined) => (p.repo === defaultRepo && !p.qualified ? p.path : `${p.repo}:${p.path}`);

/** Preflight の記録（run.json）に残す参照先。このマシンのパスは入れない（共有するので） */
export interface RefScope {
  name: string;
  /** コンテナの中の名前（/workspace/<mount>） */
  mount: string;
  role: string;
  readFirst: boolean;
  /** ok: 読めた / unregistered: このマシンのパスが無い / missing: パスが無い / notdir: フォルダでない */
  status: "ok" | "unregistered" | "missing" | "notdir";
  /** 見られなかった理由（パスは含めない） */
  reason?: string;
}
