/**
 * CSV の上限・実在しない日付・DB エラー文（2026-09-13 の点検・PR-3 の 18）。
 *
 * 判断は `lib/csv/limits.ts` と `normalizeDate` の純関数で固定し、
 * route が実際にそれを通っているかは route を本物で走らせて見る
 * （Supabase のクライアントと認証・回数制限だけを差し替える）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  CSV_MAX_BYTES,
  CSV_MAX_COLUMNS,
  CSV_MAX_HEADER_CHARS,
  CSV_MAX_ROWS,
  checkCsvSize,
  checkHeaderSize,
} from "@/lib/csv/limits";
import { normalizeDate } from "@/app/api/csv/ingest/route";

const upsertError: { value: { message: string } | null } = { value: null };

vi.mock("@supabase/supabase-js", async () => {
  const actual =
    await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
  return {
    ...actual,
    createClient: () => ({
      from: () => ({ upsert: async () => ({ error: upsertError.value }) }),
    }),
  };
});

vi.mock("@/lib/auth/company", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/company")>("@/lib/auth/company");
  return {
    ...actual,
    getAuthedContext: async () => ({
      companyId: "33333333-3333-4333-8333-333333333333",
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

const MAPPING = {
  date: "日付",
  description: "摘要",
  amount: "金額",
  direction: null,
  credit: null,
  debit: null,
  balance: null,
};

function csvWithRows(rows: number): string {
  const lines = ["日付,摘要,金額"];
  for (let i = 0; i < rows; i++) lines.push(`2026/09/01,売上${i},1000`);
  return lines.join("\n");
}

function ingest(body: unknown) {
  return new NextRequest("http://localhost/api/csv/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("取り込む本文の大きさ", () => {
  it("上限ちょうど（データ行 20,000 行）は通す", () => {
    expect(checkCsvSize(csvWithRows(CSV_MAX_ROWS))).toEqual({ ok: true, rows: CSV_MAX_ROWS });
  });

  it("**陰性**: データ行 20,001 行は断る（見出しの1行は数えない）", () => {
    expect(checkCsvSize(csvWithRows(CSV_MAX_ROWS + 1))).toEqual({
      ok: false,
      reason: "too_many_rows",
      rows: CSV_MAX_ROWS + 1,
    });
  });

  it("**陰性**: 2MB を1バイトでも超えたら断る（UTF-8 のバイト数で数える）", () => {
    // 「あ」は UTF-8 で3バイト。文字数ではなくバイト数で見ていることを確かめる
    const chars = Math.floor(CSV_MAX_BYTES / 3) + 1;
    const verdict = checkCsvSize(`日付\n${"あ".repeat(chars)}`);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("too_many_bytes");
  });

  it("2MB ちょうどは通す", () => {
    expect(checkCsvSize("a".repeat(CSV_MAX_BYTES)).ok).toBe(true);
  });
});

describe("見出しの大きさ（csv/analyze）", () => {
  it("100 列・200 文字ちょうどは通す", () => {
    expect(checkHeaderSize(Array(CSV_MAX_COLUMNS).fill("x".repeat(CSV_MAX_HEADER_CHARS)))).toEqual({
      ok: true,
    });
  });

  it("**陰性**: 101 列は断る", () => {
    expect(checkHeaderSize(Array(CSV_MAX_COLUMNS + 1).fill("日付"))).toEqual({
      ok: false,
      reason: "too_many_columns",
      columns: 101,
    });
  });

  it("**陰性**: 1列 201 文字は断る。理由に見出しの中身を載せない（列の番号と文字数だけ）", () => {
    const verdict = checkHeaderSize(["日付", "秘密の列名".padEnd(CSV_MAX_HEADER_CHARS + 1, "x")]);
    expect(verdict).toEqual({ ok: false, reason: "header_too_long", column: 2, chars: 201 });
    expect(JSON.stringify(verdict)).not.toContain("秘密の列名");
  });
});

describe("実在しない日付", () => {
  it("**陰性**: 2026-99-99 / 2026-02-30 / 2026-13-01 / 2026-04-31 は弾く", () => {
    for (const bad of ["2026-99-99", "2026-02-30", "2026-13-01", "2026-04-31", "2026/00/10"]) {
      expect(normalizeDate(bad), bad).toBeNull();
    }
  });

  it("**陰性**: 区切りなし・和文の形でも実在しない日付は弾く", () => {
    expect(normalizeDate("20260230")).toBeNull();
    expect(normalizeDate("2026年2月30日")).toBeNull();
  });

  it("実在する日付は通す（うるう年の 2/29 を含む）", () => {
    expect(normalizeDate("2024-02-29")).toBe("2024-02-29");
    expect(normalizeDate("2026/12/31")).toBe("2026-12-31");
    expect(normalizeDate("20260101")).toBe("2026-01-01");
  });

  it("**陰性**: うるう年でない年の 2/29 は弾く", () => {
    expect(normalizeDate("2026-02-29")).toBeNull();
  });
});

describe("csv/ingest の route", () => {
  beforeEach(() => {
    upsertError.value = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("**陰性**: データ行 20,001 行は 413 で断り、DB に書かない", async () => {
    const { POST } = await import("@/app/api/csv/ingest/route");
    const res = await POST(
      ingest({ csv_text: csvWithRows(CSV_MAX_ROWS + 1), file_name: "big.csv", mapping: MAPPING }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "csv_too_large",
      reason: "too_many_rows",
      rows: CSV_MAX_ROWS + 1,
    });
  });

  it("**陰性**: DB のエラー文を返さない（ingest_failed と件数だけ）", async () => {
    upsertError.value = {
      message: 'duplicate key value violates unique constraint "events_pkey" on table events',
    };
    const { POST } = await import("@/app/api/csv/ingest/route");
    const res = await POST(
      ingest({ csv_text: csvWithRows(3), file_name: "x.csv", mapping: MAPPING }),
    );
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "ingest_failed", count: 0 });
    expect(JSON.stringify(body)).not.toContain("events_pkey");
  });

  it("**陰性**: 実在しない日付の行は取り込まず、理由を返す", async () => {
    const { POST } = await import("@/app/api/csv/ingest/route");
    const res = await POST(
      ingest({
        csv_text: ["日付,摘要,金額", "2026-02-30,売上,1000", "2026-02-28,売上,2000"].join("\n"),
        file_name: "x.csv",
        mapping: MAPPING,
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.skipped).toBe(1);
  });
});

describe("csv/analyze の route", () => {
  it("**陰性**: 101 列の見出しは 413 で断り、LLM に進まない", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "unit-test-placeholder");
    vi.stubEnv("ANTHROPIC_MODEL", "unit-test-placeholder");
    const { POST } = await import("@/app/api/csv/analyze/route");
    const res = await POST(
      new NextRequest("http://localhost/api/csv/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headers: Array.from({ length: 101 }, (_, i) => `列${i}`),
          row_count: 1,
          type_stats: {},
        }),
      }),
    );

    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("too_many_columns");
    vi.unstubAllEnvs();
  });
});
