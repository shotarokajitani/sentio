import { describe, it, expect } from "vitest";
import { normalizeDate } from "../../src/app/api/csv/ingest/route";

describe("normalizeDate", () => {
  // 1. YYYYMMDD (8-digit, no separator)
  it("parses YYYYMMDD format", () => {
    expect(normalizeDate("20260115")).toBe("2026-01-15");
    expect(normalizeDate("20250701")).toBe("2025-07-01");
    expect(normalizeDate("20241231")).toBe("2024-12-31");
  });

  // 2. YYYY/MM/DD and YYYY-MM-DD
  it("parses YYYY/MM/DD format", () => {
    expect(normalizeDate("2026/01/15")).toBe("2026-01-15");
    expect(normalizeDate("2026/1/5")).toBe("2026-01-05");
  });

  it("parses YYYY-MM-DD format", () => {
    expect(normalizeDate("2026-01-15")).toBe("2026-01-15");
    expect(normalizeDate("2026-7-1")).toBe("2026-07-01");
  });

  // 3. YYYY年M月D日
  it("parses YYYY年M月D日 format", () => {
    expect(normalizeDate("2026年1月15日")).toBe("2026-01-15");
    expect(normalizeDate("2026年12月3日")).toBe("2026-12-03");
    expect(normalizeDate("2025年7月1日")).toBe("2025-07-01");
  });

  // 4. M/D (year-less) → null (skip)
  it("returns null for year-less M/D format", () => {
    expect(normalizeDate("1/15")).toBeNull();
    expect(normalizeDate("12/3")).toBeNull();
    expect(normalizeDate("7-1")).toBeNull();
  });

  // 5. Japanese era → "era_unsupported"
  it("returns era_unsupported for Japanese era dates", () => {
    expect(normalizeDate("令和6年1月15日")).toBe("era_unsupported");
    expect(normalizeDate("R6.1.15")).toBe("era_unsupported");
    expect(normalizeDate("平成31年4月1日")).toBe("era_unsupported");
    expect(normalizeDate("H31.4.1")).toBe("era_unsupported");
    expect(normalizeDate("昭和63年12月1日")).toBe("era_unsupported");
  });

  // Edge cases
  it("handles whitespace", () => {
    expect(normalizeDate("  20260115  ")).toBe("2026-01-15");
    expect(normalizeDate(" 2026/01/15 ")).toBe("2026-01-15");
  });

  it("returns null for empty or garbage", () => {
    expect(normalizeDate("")).toBeNull();
    expect(normalizeDate("abc")).toBeNull();
    expect(normalizeDate("12345")).toBeNull();
  });
});
