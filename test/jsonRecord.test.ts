import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonRecord, writeJsonRecord } from "../packages/tasks/src/core/store/jsonRecord.ts";
import { tempDir } from "./helpers.ts";

/**
 * JSON の記録のファイルの共通の読み書き（core/store/jsonRecord.ts）: 読むときの扱いを記録ごとに渡せること（無い・読めない・空・JSON として
 * 読めない・形）、置き換えで整形して書くこと
 * （記録ごとの値・エラー・書き込みの有無は各機能のテスト: metricsManual・retrospective・qualityImprovement・milestoneReviewStore）
 */

const policy = {
  missing: () => "無い",
  invalidJson: (m: string) => `JSON でない: ${m.length > 0}`,
  shape: (raw: unknown) => `形: ${JSON.stringify(raw)}`,
};

describe("読む・書く", () => {
  it("無い・空・JSON として読めない・形を、渡した扱いで読む。無い以外の読めない理由は、扱いが無ければ投げる", async () => {
    const dir = tempDir("p3-json-");
    const file = join(dir, "x.json");
    expect(await readJsonRecord(file, policy)).toBe("無い");
    writeFileSync(file, "");
    expect(await readJsonRecord(file, policy)).toBe("JSON でない: true");
    expect(await readJsonRecord(file, { ...policy, blank: () => "空" })).toBe("空");
    writeFileSync(file, "{ 壊れた");
    expect(await readJsonRecord(file, policy)).toBe("JSON でない: true");
    writeFileSync(file, '{"a":1}');
    expect(await readJsonRecord(file, policy)).toBe('形: {"a":1}');
    // フォルダを読む（EISDIR）: 扱いがあればその値、無ければ投げる
    const folder = join(dir, "folder");
    mkdirSync(folder);
    expect(await readJsonRecord(folder, { ...policy, readFailed: (e) => `読めない: ${e.code}` })).toBe("読めない: EISDIR");
    await expect(readJsonRecord(folder, policy)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("整形した JSON と末尾の改行で、置き換えで書く", async () => {
    const file = join(tempDir("p3-json-"), "x.json");
    await writeJsonRecord(file, { a: [1, 2] });
    expect(await readFile(file, "utf8")).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}\n');
  });
});

