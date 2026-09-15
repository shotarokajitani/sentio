/**
 * 制御文字を含む見出しで `csv/analyze` が落ちない（2026-09-13 の点検・PR-3 の 21）。
 *
 * 見出しをそのままプロンプトに入れると、LLM が制御文字ごと列名を返したときに
 * 応答の JSON が壊れ、500 で落ちる。**プロンプトに入れる見出しから制御文字を落とし、
 * 返ってきた列名は元の見出しに戻す。**
 *
 * route を本物で走らせ、Anthropic・認証・回数制限だけを差し替える。
 * 制御文字はソースに直接書かず `String.fromCharCode` で作る（ファイルに生の制御文字を置かない）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { originalHeaderFor, stripControlChars } from "@/lib/csv/limits";

const NUL = String.fromCharCode(0x00);
const BEL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x85);

const prompts: string[] = [];
const llm = vi.fn(async (args: { messages: { content: string }[] }) => {
  prompts.push(args.messages[0].content);
  return {
    content: [
      {
        type: "text",
        text: '{"date":"日付","description":"摘要","amount":"金額","direction":null,"credit":null,"debit":null,"balance":null}',
      },
    ],
  };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: llm };
  },
}));

vi.mock("@/lib/auth/company", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/company")>("@/lib/auth/company");
  return {
    ...actual,
    getAuthedContext: async () => ({
      companyId: "44444444-4444-4444-8444-444444444444",
      email: null,
      siteUrl: null,
      supabase: null,
    }),
  };
});

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, hitRate: async () => ({ allowed: true, count: 1 }) };
});

describe("見出しの制御文字", () => {
  it("U+0000〜U+001F・U+007F〜U+009F を落とし、改行は空白1つにする", () => {
    expect(stripControlChars(`日${NUL}付`)).toBe("日付");
    expect(stripControlChars(`摘${BEL}要${DEL}${C1}`)).toBe("摘要");
    expect(stripControlChars("入金\n金額")).toBe("入金 金額");
  });

  it("返ってきた列名を元の見出しに戻す。見つからなければ null", () => {
    const headers = [`日${NUL}付`, "摘要"];
    expect(originalHeaderFor("日付", headers)).toBe(`日${NUL}付`);
    expect(originalHeaderFor("存在しない列", headers)).toBeNull();
    expect(originalHeaderFor(3, headers)).toBeNull();
  });
});

describe("csv/analyze の route", () => {
  beforeEach(() => {
    prompts.length = 0;
    llm.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "unit-test-placeholder");
    vi.stubEnv("ANTHROPIC_MODEL", "unit-test-placeholder");
  });

  it("**陰性**: 制御文字を含む見出し（摘要）でも落ちず、プロンプトに制御文字を入れず、元の見出しで返す", async () => {
    const headers = [`日付${NUL}`, `摘要${BEL}`, "金額"];
    const { POST } = await import("@/app/api/csv/analyze/route");
    const res = await POST(
      new NextRequest("http://localhost/api/csv/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headers,
          row_count: 2,
          type_stats: {
            [`日付${NUL}`]: {
              type: "date",
              digits: null,
              sample_count: 2,
              samples: [`2026/09/01${BEL}`],
            },
            [`摘要${BEL}`]: { type: "string", digits: null, sample_count: 2 },
            金額: { type: "number", digits: 5, sample_count: 2, samples: ["1000"] },
          },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mapping: {
        date: `日付${NUL}`,
        description: `摘要${BEL}`,
        amount: "金額",
        direction: null,
        credit: null,
        debit: null,
        balance: null,
      },
    });

    expect(llm).toHaveBeenCalledTimes(1);
    const controls = Array.from(prompts[0]).filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return (code <= 0x1f && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
    });
    expect(controls).toEqual([]);
  });
});
