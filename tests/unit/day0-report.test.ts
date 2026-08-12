import { describe, it, expect } from "vitest";
import {
  generateDay0Report,
  DAY0_BLOCK_KEYS,
  type Day0Input,
} from "../../src/day0/day0-report";
import { Day0ReportSchema } from "../../shared/contracts/day0-report";

function makeInput(overrides: Partial<Day0Input> = {}): Day0Input {
  return {
    companyId: "550e8400-e29b-41d4-a716-446655440000",
    companyName: "株式会社アオバ製作所",
    url: "https://aoba-seisakusho.example.com",
    industry: "manufacturing",
    concern: null,
    siteHealth: { ssl_days_remaining: 120, response_time_ms: 450 },
    publicRecords: [{ source: "gBizINFO", content: "補助金採択: ものづくり補助金" }],
    opportunities: [{ source: "jGrants", title: "IT導入補助金", deadline: "2026-09-30" }],
    industryData: [{ source: "e-Stat", content: "製造業出荷指数: 前年比+2.1%" }],
    ...overrides,
  };
}

describe("Day0 report (A1-A5)", () => {
  it("A2: report has 8 blocks with correct keys", () => {
    const report = generateDay0Report(makeInput());
    expect(report.blocks).toHaveLength(8);
    expect(report.blocks.map((b) => b.key)).toEqual(DAY0_BLOCK_KEYS);
  });

  it("A2: at least 3 blocks have data", () => {
    const report = generateDay0Report(makeInput());
    const populated = report.blocks.filter((b) => b.hasData);
    expect(populated.length).toBeGreaterThanOrEqual(3);
  });

  it("A3: all data blocks have source attribution", () => {
    const report = generateDay0Report(makeInput());
    report.blocks.forEach((block) => {
      if (block.hasData) {
        expect(block.sources.length).toBeGreaterThan(0);
      }
    });
  });

  it("A3: no assertive expressions in content", () => {
    const report = generateDay0Report(makeInput());
    report.blocks.forEach((block) => {
      if (block.hasData) {
        expect(block.content).not.toMatch(/である。|に違いない|確実に|必ず/);
      }
    });
  });

  it("A4: concern input produces initial_hypothesis block referencing it", () => {
    const report = generateDay0Report(
      makeInput({ concern: "売上が3ヶ月連続で減少している" }),
    );
    const hypothesis = report.blocks.find((b) => b.key === "initial_hypothesis");
    expect(hypothesis).toBeDefined();
    expect(hypothesis!.hasData).toBe(true);
    expect(hypothesis!.content).toContain("売上");
  });

  it("A4: no concern still produces initial_hypothesis block (empty)", () => {
    const report = generateDay0Report(makeInput({ concern: null }));
    const hypothesis = report.blocks.find((b) => b.key === "initial_hypothesis");
    expect(hypothesis).toBeDefined();
    // Without concern, block exists but may have limited data
  });

  it("A5: unreachable URL still produces a valid report", () => {
    const report = generateDay0Report(
      makeInput({ url: "https://unreachable.example.com", siteHealth: null }),
    );
    expect(report).toBeDefined();
    expect(report.blocks.length).toBe(8);
    // At least some blocks should still have data (public records, opportunities, etc.)
    const populated = report.blocks.filter((b) => b.hasData);
    expect(populated.length).toBeGreaterThanOrEqual(1);
  });

  it("output conforms to Day0ReportSchema", () => {
    const report = generateDay0Report(makeInput());
    const result = Day0ReportSchema.safeParse(report);
    expect(result.success).toBe(true);
  });

  it("generation_time_ms is recorded", () => {
    const report = generateDay0Report(makeInput());
    expect(report.generation_time_ms).toBeGreaterThanOrEqual(0);
  });
});
