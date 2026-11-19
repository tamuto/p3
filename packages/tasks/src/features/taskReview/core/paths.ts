/** 材料のフォルダのパスの規則（保存と抽出で共有する。Workspace に依存しない） */

function hasControl(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** 材料のフォルダの中に置けるパスか（参照先の中の相対パス。.. ・絶対パス・制御文字は使わない） */
export function safeRelPath(p: string): boolean {
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\") || hasControl(p)) return false;
  return !p.split("/").some((s) => s === ".." || s === "." || s === "");
}

