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

/**
 * 正規表現リテラルの取り違え（2026-08-19 実測）。
 *
 * `day0/index.ts:142` の `/<meta[^>]+charset=["']?([^"'\s;>]+)/i` を
 * 「文字列の始まり」と読んだ結果、**142行目以降のほぼ全域が文字列の中身として
 * 空白化され、握りつぶし2件（`index.ts:953` / `1009`）が検出されていなかった。**
 * 検査が落ちるのではなく静かに見えなくなる形なので、テストで固定する。
 */
describe("findSwallowedDbCalls — 正規表現リテラル", () => {
  it("正規表現の中の引用符を文字列の開始と読まない", () => {
    // day0/index.ts:142 の実物と同じ形。`["']` の 2 文字が「文字列の開始」に見える
    const src = String.raw`
      const mc = html.match(/<meta[^>]+charset=["']?([^"'\s;>]+)/i);
      const { data } = await supabase.from("events").select("id");
    `;
    expect(findSwallowedDbCalls(src, "x.ts").map((v) => v.table)).toEqual(["events"]);
  });

  it("正規表現リテラルの中の .from() は violation にしない", () => {
    const src = String.raw`const re = /supabase\.from\("events"\)/;`;
    expect(findSwallowedDbCalls(src, "x.ts")).toEqual([]);
  });

  it("除算の / を正規表現の始まりと読まない（後続コードを飲み込まない）", () => {
    const src = `
      const ratio = total / count;
      const share = used / limit;
      const { data } = await supabase.from("findings").select("id");
    `;
    expect(findSwallowedDbCalls(src, "x.ts").map((v) => v.table)).toEqual(["findings"]);
  });

  it("正規表現の文字クラス内の / で終端しない", () => {
    const src = String.raw`
      const re = /[/"']+/g;
      const { data } = await supabase.from("baselines").select("stats");
    `;
    expect(findSwallowedDbCalls(src, "x.ts").map((v) => v.table)).toEqual(["baselines"]);
  });
});

/**
 * 型引数つきの包み（2026-08-20 実測）。
 *
 * `mustMaybe` は呼び出し元が期待する行の形を型引数で明示する契約にしたが、
 * 検査器が `mustMaybe<{ id: string }>(` を「包み」と認識せず、
 * **正しく包んだ7箇所を握りつぶしとして報告した**。
 * 検査が緩む向きではなく厳しすぎる向きの誤りだが、放置すると
 * 「検査を通すために包みを外す」圧力になるので直す。
 */
describe("findSwallowedDbCalls — 型引数つきの包み", () => {
  it("mustMaybe<T>( を包みとして認識する", () => {
    const src = `const r = await mustMaybe<{ id: string }>(supabase.from("events").select("id"), "ctx");`;
    expect(findSwallowedDbCalls(src, "x.ts")).toEqual([]);
  });

  it("入れ子の型引数でも認識する", () => {
    const src = `const r = await mustData<Array<{ a: Map<string, number> }>>(supabase.from("events").select("a"), "ctx");`;
    expect(findSwallowedDbCalls(src, "x.ts")).toEqual([]);
  });

  it("複数行にまたがる型引数でも認識する", () => {
    const src = `
      const r = await mustMaybe<{
        id: string;
        status: string;
      }>(supabase.from("delivery_log").select("id, status").maybeSingle(), "ctx");
    `;
    expect(findSwallowedDbCalls(src, "x.ts")).toEqual([]);
  });

  it("型引数を付けても包みでない名前は認めない", () => {
    const src = `const x = mustDataMaybe<{ id: string }>(supabase.from("events").select("id"), "ctx");`;
    expect(findSwallowedDbCalls(src, "x.ts").map((v) => v.table)).toEqual(["events"]);
  });

  it("比較演算子を型引数の閉じと読み違えない", () => {
    const src = `
      const flag = a > b;
      const { data } = await supabase.from("findings").select("id");
    `;
    expect(findSwallowedDbCalls(src, "x.ts").map((v) => v.table)).toEqual(["findings"]);
  });
});
