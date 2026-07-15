import { describe, it, expect } from "vitest";
import {
  generateSummary,
  MAX_SUMMARY_TOKENS,
  CHAPTER_KEYS,
  type CompanyData,
} from "../../src/state/company-summary";
import { CompanySummarySchema } from "../../shared/contracts/company-summary";

describe("company_summary (C2)", () => {
  const minimalData: CompanyData = {
    companyId: "550e8400-e29b-41d4-a716-446655440000",
    overview: "Small manufacturing company",
    financial: "Revenue stable",
    operations: "Normal operations",
    people: "5 employees",
    external: "No notable external events",
  };

  it("C2: chapters have fixed structure keys", () => {
    const summary = generateSummary(minimalData);
    const keys = summary.chapters.map((c) => c.key);
    expect(keys).toEqual(["overview", "financial", "operations", "people", "external"]);
  });

  it("C2: CHAPTER_KEYS constant matches expected", () => {
    expect(CHAPTER_KEYS).toEqual([
      "overview",
      "financial",
      "operations",
      "people",
      "external",
    ]);
  });

  it("C2: token_count does not exceed MAX_SUMMARY_TOKENS", () => {
    const largeData: CompanyData = {
      companyId: "550e8400-e29b-41d4-a716-446655440000",
      overview: "A".repeat(5000),
      financial: "B".repeat(5000),
      operations: "C".repeat(5000),
      people: "D".repeat(5000),
      external: "E".repeat(5000),
    };
    const summary = generateSummary(largeData);
    expect(summary.token_count).toBeLessThanOrEqual(MAX_SUMMARY_TOKENS);
  });

  it("C2: output conforms to CompanySummarySchema", () => {
    const summary = generateSummary(minimalData);
    const result = CompanySummarySchema.safeParse(summary);
    expect(result.success).toBe(true);
  });

  it("C2: empty/minimal input produces valid structure", () => {
    const emptyData: CompanyData = {
      companyId: "550e8400-e29b-41d4-a716-446655440000",
      overview: "",
      financial: "",
      operations: "",
      people: "",
      external: "",
    };
    const summary = generateSummary(emptyData);
    expect(summary.chapters).toHaveLength(5);
    const result = CompanySummarySchema.safeParse(summary);
    expect(result.success).toBe(true);
  });
});
