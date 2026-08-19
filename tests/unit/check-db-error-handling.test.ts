import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { findSwallowedDbCalls } from "../../scripts/check-db-error-handling";

/**
 * S-2-4 の陽性・陰性コントロール。
 *
 * 「握りつぶしを検出する検査」自体が空洞になっていないことを固定する。
 * 検査スクリプトを緩めた瞬間に、このテストが赤くなる。
 */

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, `../fixtures/db-access/${name}.ts.fixture`), "utf8");
}

describe("findSwallowedDbCalls", () => {
  it("陽性コントロール: 全アクセスが mustData/mustOk を通る書き方は violation 0件", () => {
    const violations = findSwallowedDbCalls(fixture("good"), "good.ts");
    expect(violations).toEqual([]);
  });

  it("陰性コントロール: 握りつぶし3件をすべて検出する", () => {
    const violations = findSwallowedDbCalls(fixture("bad"), "bad.ts");

    expect(violations.map((v) => v.table)).toEqual(["events", "company_summary", "findings"]);
  });

  it("陰性コントロールの violation に、直せる場所（行番号）が付く", () => {
    const violations = findSwallowedDbCalls(fixture("bad"), "bad.ts");

    for (const v of violations) {
      expect(v.file).toBe("bad.ts");
      expect(v.line).toBeGreaterThan(0);
    }
    // 行番号が実際にソースの位置を指していること（すべて同じ値を返す実装を弾く）
    const lines = violations.map((v) => v.line);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("Array.from など Supabase クライアント以外の .from() は violation にしない", () => {
    const src = `
      const a = Array.from(new Set([1, 2]));
      const b = Object.fromEntries([["k", "v"]]);
      const c = Uint8Array.from([1, 2, 3]);
    `;
    expect(findSwallowedDbCalls(src, "x.ts")).toEqual([]);
  });

  it("コメント内・文字列内の .from() は violation にしない", () => {
    const src = `
      // await supabase.from("events").select("*")
      /* const { data } = await supabase.from("findings").select("*"); */
      const note = 'supabase.from("baselines")';
    `;
    expect(findSwallowedDbCalls(src, "x.ts")).toEqual([]);
  });

  it("mustData で包んでいても、同じ文の別のアクセスが素通しなら検出する", () => {
    const src = `
      const [a, b] = await Promise.all([
        mustData(supabase.from("events").select("event_id"), "a"),
        supabase.from("findings").select("id"),
      ]);
    `;
    const violations = findSwallowedDbCalls(src, "x.ts");
    expect(violations.map((v) => v.table)).toEqual(["findings"]);
  });

  it("改行を挟んだメソッドチェーンでも、包まれていれば violation にしない", () => {
    const src = `
      const events = mustData(
        await supabase
          .from("events")
          .select("event_id"),
        "ctx",
      );
    `;
    expect(findSwallowedDbCalls(src, "x.ts")).toEqual([]);
  });

  it("mustData に似た別名（mustDataSomething）を包みとして認めない", () => {
    const src = `const x = mustDataMaybe(await supabase.from("events").select("id"), "ctx");`;
    expect(findSwallowedDbCalls(src, "x.ts").map((v) => v.table)).toEqual(["events"]);
  });
});
