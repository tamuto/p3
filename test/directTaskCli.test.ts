import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { shellArg } from "../src/cli/output.ts";
import { gitInit, tempDir } from "./helpers.ts";

/**
 * p3 preflight が始められない・失敗したときに、Preflight を通さずにタスクを作る道（p3 new）を stderr に案内する。
 * 本物の Docker と ChatGPT は使わない（個人設定はテストごとに分け、PATH の docker を差し替える）
 */
const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
let CONFIG_HOME = "";
beforeEach(() => {
  CONFIG_HOME = tempDir("p3-config-");
});

/** docker を PATH に置かない・置き換える（node と git だけは使えるようにする。このマシンの docker は見せない） */
function pathWith(docker?: string) {
  const bin = tempDir("p3-bin-");
  symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  if (docker) {
    writeFileSync(join(bin, "docker"), `#!/bin/sh\n${docker}\n`);
    chmodSync(join(bin, "docker"), 0o755);
  }
  return [bin, dirname(process.execPath)].join(":");
}

function p3(cwd: string, args: string[], extra: Record<string, string> = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
  const env = { ...base, XDG_CONFIG_HOME: CONFIG_HOME, P3_ACTOR: "human:tester", ...extra };
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function setup() {
  const root = tempDir("p3-direct-");
  gitInit(root);
  expect(p3(root, ["init", "--yes", "--dir", ".p3", "--repo-name", "app"]).code).toBe(0);
  const rid = JSON.parse(p3(root, ["request", "new", "検索を速くする", "--json"]).out).id as string;
  return { root, rid };
}

const command = (rid: string) => `p3 new "タスクの題" --req ${rid} --body "作業内容と完了条件"`;

describe("Preflight を使えないときの直接作成の案内（CLI）", () => {
  // 旧来の認証を明示して、認証の次の Docker で止める
  const legacy = { P3_CODEX_AUTH_FILE: "/nonexistent/auth.json" };
  it.each([
    ["ChatGPT に未接続", {}, undefined, /サインイン/],
    ["docker コマンドが無い", legacy, "", /spawn docker ENOENT/],
    ["Docker のデーモンに繋がらない", legacy, 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1', /Codex のイメージを用意できません/],
  ])("%s: 失敗した run を返し、終了コード 1。stderr に実際の要望 ID で p3 new を案内し、--json の stdout は run のまま", (_, extra, docker, cause) => {
    const { root, rid } = setup();
    const env = { ...extra, ...(docker === undefined ? {} : { PATH: pathWith(docker || undefined) }) };
    const human = p3(root, ["preflight", rid], env);
    expect(human.code, human.err).toBe(1);
    expect(human.out).toMatch(/エラー: /);
    expect(human.out).toMatch(cause);
    expect(human.err).toContain(command(rid));
    expect(human.err).toContain("評価・細分化・根拠の調査・画面イメージは付きません");
    expect(human.err).toContain(`p3 preflight ${rid}`);
    expect(human.out).not.toContain("p3 new");

    const json = p3(root, ["preflight", rid, "--json"], env);
    expect(json.code).toBe(1);
    const run = JSON.parse(json.out) as { status: string; error: string };
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(cause);
    expect(json.err).toContain(command(rid));
  });

  it("開始前に断られたとき（使えないエンジン）は、エラーに案内を添えて終了コード 1。--project を付けていれば引き継ぐ", () => {
    const { root, rid } = setup();
    const r = p3(root, ["preflight", rid, "--engine", "nope"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("engine nope は利用できません");
    expect(r.err).toContain(command(rid));
    // --project・--dir で指したときは同じ対象で動くように付ける（空白を含むパスは囲む）
    const named = tempDir("p3-direct-named-");
    gitInit(named);
    expect(p3(named, ["init", "--yes", "--project", "named", "--dir", "my data"]).code).toBe(0);
    const id = JSON.parse(p3(named, ["request", "new", "x", "--project", "named", "--json"]).out).id as string;
    expect(p3(named, ["preflight", id, "--engine", "nope", "--project", "named"]).err).toContain(
      `p3 new "タスクの題" --req ${id} --project named --body "作業内容と完了条件"`,
    );
    expect(p3(named, ["preflight", id, "--engine", "nope", "--dir", "my data"]).err).toContain(
      `p3 new "タスクの題" --req ${id} --dir 'my data' --body "作業内容と完了条件"`,
    );
  });

  it("要望が無い・成功したときは案内しない", () => {
    const { root, rid } = setup();
    const missing = p3(root, ["preflight", "261001-nopee"]);
    expect(missing.code).toBe(2);
    expect(missing.err).not.toContain("p3 new");
    const ok = p3(root, ["preflight", rid, "--engine", "mock"]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.err).not.toContain("p3 new");
  });
});

describe("shellArg", () => {
  it("記号や空白・引用符を含むものだけを単引用符で囲む", () => {
    expect(shellArg("261020-mffmw")).toBe("261020-mffmw");
    expect(shellArg("my proj")).toBe("'my proj'");
    expect(shellArg("it's")).toBe("'it'\\''s'");
    expect(shellArg("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
  });
});
