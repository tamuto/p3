import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/core/store/frontmatter.ts";
import { git, gitInit, tempDir } from "./helpers.ts";

// 同梱のスキルの「タスクを進める」の手順（テストを通したら完了と記録を保存 → 最後なら対応済 → 要望のフォルダを実装と同じコミットに
// 入れる → URL は後から足して追記のコミット）を、使い捨ての git のリポジトリと実際の CLI でなぞる。push・PR は外へ出ないので試さない

const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
const CONFIG_HOME = tempDir("p3-config-");

function p3(cwd: string, args: string[], env: Record<string, string> = {}, input?: string) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", input, env: { ...base, XDG_CONFIG_HOME: CONFIG_HOME, ...env } });
  expect(r.status, `p3 ${args.join(" ")}\n${r.stderr}`).toBe(0);
  return r.stdout;
}
const AI = { P3_ACTOR: "ai:claude" };

/** あるコミットの時点のファイルの frontmatter */
const at = (root: string, sha: string, path: string) => parseFrontmatter(git(root, "show", `${sha}:${path}`)).data;

describe("完了の記録を実装と同じコミットに入れる", () => {
  it("完了・記録・成果物（最後なら対応済）が実装のコミットに入り、URL は追記のコミットで足しても前の記録を保つ", () => {
    // データのフォルダ（.p3）をリポジトリの中に置いて git で管理する
    const root = tempDir("p3-same-commit-");
    gitInit(root);
    writeFileSync(join(root, "README.md"), "# app\n");
    p3(root, ["init", "--yes", "--description", "在庫管理", "--repo-name", "app"]);
    const rid = (JSON.parse(p3(root, ["request", "new", "通知", "--body", "- 送る\n- 設定", "--json"])) as { id: string }).id;
    p3(root, ["new", "送る", "--req", rid]);
    p3(root, ["new", "設定", "--req", rid]);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "要望とタスク");
    const dir = `.p3/requests/${rid}`;

    // 1つ目のタスク: 実装 → テストを通した → 完了と記録を保存 → 実装と要望のフォルダを同じコミットに
    p3(root, ["move", "T1", "doing", "--req", rid], AI);
    writeFileSync(join(root, "notify.ts"), "export const send = () => true;\n");
    p3(root, ["move", "T1", "done", "--req", rid, "--output", "notify.ts（送る処理）", "--record", "-"], AI, "- 通知を送る処理を足した\n- 決まり: 失敗は投げない");
    git(root, "add", "notify.ts", dir);
    git(root, "commit", "-q", "-m", "送る");
    const first = git(root, "rev-parse", "HEAD");
    expect(git(root, "status", "--porcelain"), "コミットの後に残る変更は無い").toBe("");
    const t1 = at(root, first, `${dir}/tasks/T001.md`);
    expect(t1).toMatchObject({ status: "done", outputs: ["notify.ts（送る処理）"], record: "- 通知を送る処理を足した\n- 決まり: 失敗は投げない" });
    expect(t1.doneAt).toBeTruthy();
    // 入れたのは実装と、この要望のフォルダだけ
    const files = git(root, "show", "--name-only", "--format=", first).split("\n");
    expect(files).toEqual(expect.arrayContaining(["notify.ts", `${dir}/tasks/T001.md`]));
    expect(files.filter((f) => f !== "notify.ts" && !f.startsWith(`${dir}/`))).toEqual([]);

    // 最後のタスク: 完了と対応済を保存してから、実装と同じコミットに
    p3(root, ["move", "T2", "doing", "--req", rid], AI);
    writeFileSync(join(root, "settings.ts"), "export const enabled = true;\n");
    p3(root, ["move", "T2", "done", "--req", rid, "--output", "settings.ts（設定）", "--record", "-"], AI, "- 通知の設定を足した");
    p3(root, ["request", "set", rid, "status=resolved"], AI);
    git(root, "add", "settings.ts", dir);
    git(root, "commit", "-q", "-m", "設定");
    const last = git(root, "rev-parse", "HEAD");
    expect(at(root, last, `${dir}/tasks/T002.md`)).toMatchObject({ status: "done", record: "- 通知の設定を足した" });
    expect(at(root, last, `${dir}/request.md`).status).toBe("resolved");

    // コミットの URL を後から足す（完了のまま。記録・前の成果物・完了の日時を保ち、要望は進行中に戻らない）→ 追記のコミット
    const url = `https://example.com/app/commit/${last}`;
    p3(root, ["move", "T2", "done", "--req", rid, "--output", url], AI);
    git(root, "add", dir);
    git(root, "commit", "-q", "-m", "成果物の URL");
    const append = git(root, "rev-parse", "HEAD");
    const before = at(root, last, `${dir}/tasks/T002.md`);
    const after = at(root, append, `${dir}/tasks/T002.md`);
    expect(after).toMatchObject({ status: "done", record: before.record, doneAt: before.doneAt, outputs: ["settings.ts（設定）", url] });
    expect(at(root, append, `${dir}/request.md`).status).toBe("resolved");
    // 実装のコミットの完了の記録はそのまま残っている
    expect(at(root, last, `${dir}/tasks/T002.md`).outputs).toEqual(["settings.ts（設定）"]);
    expect(git(root, "show", "--name-only", "--format=", append)).toBe(`${dir}/tasks/T002.md`);
  });
});
