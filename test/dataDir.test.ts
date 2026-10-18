import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";
import { checkDataDir, DataDirError } from "../src/core/store/locate.ts";
import { startServer } from "../src/server/server.ts";

/** 空いているポート（一度待ち受けて閉じる） */
async function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

/** そのポートでまだ誰も待ち受けていない（自分が待ち受けられる） */
async function canListen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer()
      .once("error", () => done(false))
      .listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
}

describe("データのフォルダと project.yaml を確かめる（プロジェクトを開く前）", () => {
  it("フォルダが無い・project.yaml が無い・フォルダでないときは止め、何も作らない。requests/ は無くてよい", async () => {
    const base = tempDir("p3-data-");
    const missing = join(base, "moved");
    await expect(checkDataDir(missing, "app")).rejects.toThrow(DataDirError);
    await expect(checkDataDir(missing, "app")).rejects.toThrow(`データのフォルダがありません: ${missing}`);
    expect(readdirSync(base)).toEqual([]);

    const empty = join(base, "empty");
    mkdirSync(join(empty, "requests"), { recursive: true });
    await expect(checkDataDir(empty)).rejects.toThrow(`データのフォルダに project.yaml がありません: ${join(empty, "project.yaml")}`);
    // 登録していない（--dir）ときは、登録の直し方ではなく指し方を案内する
    await expect(checkDataDir(empty)).rejects.toThrow("--dir で指すときは、project.yaml のあるフォルダを指す");
    expect(readdirSync(empty)).toEqual(["requests"]);

    const file = join(base, "file");
    writeFileSync(file, "x");
    await expect(checkDataDir(file)).rejects.toThrow("フォルダではありません");

    const fresh = join(base, "fresh");
    mkdirSync(fresh);
    writeFileSync(join(fresh, "project.yaml"), "name: fresh\n");
    await expect(checkDataDir(fresh, "fresh")).resolves.toBeUndefined();
  });

  it("startServer を直接呼んでも、監視も待ち受けも始めずに失敗する", async () => {
    const port = await freePort();
    const dataDir = join(tempDir("p3-data-"), "moved");
    await expect(startServer({ dataDir, projectName: "app", port, host: "127.0.0.1", static: false })).rejects.toThrow(DataDirError);
    expect(await canListen(port)).toBe(true);
  });
});
