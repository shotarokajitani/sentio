/**
 * レート制限を数えられないとき（DB に届かない）の route の振る舞い（#126 の検収で決定）。
 *
 * - **analyze / suggest は 503（reason: rate_limit_unavailable）で止め、LLM を呼ばない**
 * - ingest / session は通す
 *
 * DB に届かない状態は CI の実 DB では作れないので、Supabase のクライアントを差し替え、
 * `hit_rate_limit` の RPC だけを失敗させる。**`hitRate` と route は本物を通す。**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const rpc = vi.fn(async () => ({ data: null, error: { message: "fetch failed" } }));

vi.mock("@supabase/supabase-js", async () => {
  const actual =
    await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
  const query = {
    select: () => query,
    eq: () => query,
    limit: async () => ({ data: [], error: null }),
    insert: async () => ({ error: null }),
    upsert: async () => ({ error: null }),
  };
  return { ...actual, createClient: () => ({ rpc, from: () => query }) };
});

const llm = vi.fn(async () => ({ content: [{ type: "text", text: "[]" }] }));
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
      companyId: "22222222-2222-4222-8222-222222222222",
      email: null,
      siteUrl: null,
      supabase: null,
    }),
  };
});

function jsonPost(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("DB に届かず回数を数えられないとき", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "http://unreachable.invalid");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "unit-test-placeholder");
    vi.stubEnv("ANTHROPIC_API_KEY", "unit-test-placeholder");
    vi.stubEnv("ANTHROPIC_MODEL", "unit-test-placeholder");
    vi.stubEnv("GBIZINFO_TOKEN", "");
    llm.mockClear();
    rpc.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("**陰性**: csv/analyze は 503（rate_limit_unavailable）で止め、LLM を呼ばない", async () => {
    const { POST } = await import("@/app/api/csv/analyze/route");
    const res = await POST(
      jsonPost("/api/csv/analyze", {
        headers: ["日付", "摘要", "金額"],
        row_count: 3,
        type_stats: {},
      }),
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "service_unavailable",
      reason: "rate_limit_unavailable",
    });
    expect(llm).not.toHaveBeenCalled();
  });

  it("**陰性**: competitors/suggest は 503（rate_limit_unavailable）で止め、LLM を呼ばない", async () => {
    const { POST } = await import("@/app/api/competitors/suggest/route");
    const res = await POST(jsonPost("/api/competitors/suggest", { url: "https://example.com" }));

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("rate_limit_unavailable");
    expect(llm).not.toHaveBeenCalled();
  });

  it("auth/session は通す（ログインの入口を止めない）", async () => {
    vi.stubEnv("SUPABASE_ANON_KEY", "unit-test-placeholder");
    const { POST } = await import("@/app/api/auth/session/route");
    // 欄を空で送る。Supabase Auth まで行かず、入力不足でログイン画面に戻る
    const res = await POST(
      new NextRequest("http://localhost/api/auth/session", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.9" },
        body: new FormData(),
      }),
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login?e=missing_fields");
  });

  it("csv/ingest は通す（取り込みを止めない）", async () => {
    const { POST } = await import("@/app/api/csv/ingest/route");
    const res = await POST(
      jsonPost("/api/csv/ingest", {
        csv_text: ["日付,摘要,金額", "2026/09/01,売上,1000"].join("\n"),
        file_name: "x.csv",
        mapping: {
          date: "日付",
          description: "摘要",
          amount: "金額",
          direction: null,
          credit: null,
          debit: null,
          balance: null,
        },
      }),
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(1);
  });
});
