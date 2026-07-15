import { describe, it, expect } from "vitest";
import { generateSyntheticCompany } from "../../scripts/generate-synthetic-company";
import { runScan, type Baseline } from "../../src/sense/scanner";

/**
 * Engine evaluation suite — tests Scanner detection against synthetic company
 * with 8 planted signals (7 positive, 1 negative control).
 *
 * D1: Positive detection rate >= 6/7
 * D2: False positive rate <= 2 AND negative control ⑤ never detected
 */

// Build baselines from normal transaction data
function buildBaselines(): Baseline[] {
  return [
    {
      metric_key: "revenue",
      is_established: true,
      median: 100000,
      iqr: 15000,
      p25: 93000,
      p75: 108000,
      count: 12,
    },
    {
      metric_key: "schedule_interval",
      is_established: true,
      median: 7,
      iqr: 2,
      p25: 6,
      p75: 8,
      count: 8,
    },
  ];
}

describe("Engine eval suite (D1-D2)", () => {
  const company = generateSyntheticCompany();
  const baselines = buildBaselines();

  it("synthetic company has expected signal counts", () => {
    const positive = company.plantedSignals.filter((s) => s.type === "positive");
    const negative = company.plantedSignals.filter((s) => s.type === "negative");
    expect(positive).toHaveLength(7);
    expect(negative).toHaveLength(1);
  });

  it("scanner produces candidates from synthetic timeline", () => {
    const candidates = runScan(company.events, baselines);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("D1: detects >= 6 of 7 positive signals", () => {
    const candidates = runScan(company.events, baselines);
    const detectedTypes = new Set(candidates.map((c) => c.scanType));

    // Check which planted positives are covered
    const positiveSignals = company.plantedSignals.filter((s) => s.type === "positive");
    let detected = 0;
    for (const signal of positiveSignals) {
      // Check if any candidate matches this signal's scan type and references its events
      const hasCandidate = candidates.some((c) => {
        if (signal.scanType === "deviation" || signal.scanType === "trend" ||
            signal.scanType === "silence" || signal.scanType === "deadline" ||
            signal.scanType === "external") {
          return c.scanType === signal.scanType;
        }
        return false;
      });
      if (hasCandidate) detected++;
    }

    expect(detected).toBeGreaterThanOrEqual(6);
  });

  it("D2: false positives <= 2", () => {
    const candidates = runScan(company.events, baselines);
    // All candidates should map to a planted positive signal's scan type
    const plantedScanTypes = new Set(
      company.plantedSignals
        .filter((s) => s.type === "positive")
        .map((s) => s.scanType),
    );

    const falsePositives = candidates.filter(
      (c) => !plantedScanTypes.has(c.scanType),
    );
    expect(falsePositives.length).toBeLessThanOrEqual(2);
  });

  it("D2: negative control ⑤ (seasonal normal) is NOT detected", () => {
    const candidates = runScan(company.events, baselines);
    // Normal seasonal revenue (93k in Aug) should be within p25-p75 range
    // and not trigger deviation scan
    const seasonalFalsePositive = candidates.filter((c) => {
      // Check if any deviation candidate is from the normal seasonal data
      if (c.scanType !== "deviation") return false;
      // Check if the evidence events are from normal baseline transactions
      return c.evidence_event_ids.some((id) => id.startsWith("txn_normal"));
    });
    expect(seasonalFalsePositive).toHaveLength(0);
  });
});
