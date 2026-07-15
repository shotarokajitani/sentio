import { describe, it, expect } from "vitest";
import {
  calculateBaseline,
  calculateBaselinesByDow,
  type BaselineResult,
} from "../../src/state/baselines";

describe("Baselines (C1)", () => {
  const observations3 = [100, 200, 300];
  const observations10 = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it("C1: observations below minObs -> is_established=false", () => {
    const result = calculateBaseline(observations3, { minObs: 5 });
    expect(result.is_established).toBe(false);
    expect(result.stats).toBeUndefined();
  });

  it("C1: observations at/above minObs -> is_established=true with stats", () => {
    const result = calculateBaseline(observations10, { minObs: 5 });
    expect(result.is_established).toBe(true);
    expect(result.stats).toBeDefined();
    expect(result.stats!.median).toBe(55); // median of 10..100
    expect(result.stats!.count).toBe(10);
    expect(result.stats!).toHaveProperty("iqr");
    expect(result.stats!).toHaveProperty("p25");
    expect(result.stats!).toHaveProperty("p75");
  });

  it("C1: median calculation is correct for odd-length arrays", () => {
    const oddObs = [5, 15, 25, 35, 45, 55, 65];
    const result = calculateBaseline(oddObs, { minObs: 3 });
    expect(result.is_established).toBe(true);
    expect(result.stats!.median).toBe(35);
  });

  it("C1: IQR = p75 - p25", () => {
    const result = calculateBaseline(observations10, { minObs: 5 });
    expect(result.stats!.iqr).toBe(result.stats!.p75 - result.stats!.p25);
  });

  it("C1: empty observations -> is_established=false", () => {
    const result = calculateBaseline([], { minObs: 5 });
    expect(result.is_established).toBe(false);
  });

  it("day-of-week adjustment: different baselines per DOW", () => {
    const byDow = new Map<number, number[]>();
    // Monday (1): high values
    byDow.set(1, [100, 110, 120, 130, 140]);
    // Friday (5): low values
    byDow.set(5, [20, 25, 30, 35, 40]);
    // Wednesday (3): insufficient data
    byDow.set(3, [50, 60]);

    const results = calculateBaselinesByDow(byDow, { minObs: 5 });

    expect(results.get(1)!.is_established).toBe(true);
    expect(results.get(5)!.is_established).toBe(true);
    expect(results.get(3)!.is_established).toBe(false);

    // Monday median > Friday median
    expect(results.get(1)!.stats!.median).toBeGreaterThan(
      results.get(5)!.stats!.median,
    );
  });
});
