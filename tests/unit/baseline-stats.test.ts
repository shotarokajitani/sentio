import { describe, it, expect } from "vitest";
import {
  buildBaselineStats,
  parseBaselineStats,
  toFlatBaseline,
  toFlatBaselines,
} from "@edge/_shared/baseline-stats";
import { calculateBaseline } from "@/state/baselines";

/**
 * S-1-2 / P-3: baselines の表現を1つに固定する。
 *
 * 修復前は DB（`stats` JSONB）・`src/state/baselines.ts`（`stats`）・
 * `src/sense/scanner.ts`（フラット）・`state-baselines`（フラットを列として書く）の
 * **4箇所で3種類**の形が併存し、繋ぐアダプタが1つも無かった。
 * ここで固定するのは「フラット形へは1本の変換だけを通って到達する」ことである。
 */

const stats = { median: 100, iqr: 20, p25: 90, p75: 110, count: 12 };

describe("parseBaselineStats", () => {
  it("5つの数値が揃っていれば読み取れる", () => {
    expect(parseBaselineStats(stats)).toEqual(stats);
  });

  it("**欠けていたら null。0 で埋めない**", () => {
    // 0 で埋めると「基準値が0」として比較が走り、あらゆるイベントが乖離になる
    expect(parseBaselineStats({ median: 100, iqr: 20, p25: 90, p75: 110 })).toBeNull();
    expect(parseBaselineStats({})).toBeNull();
    expect(parseBaselineStats(null)).toBeNull();
    expect(parseBaselineStats(undefined)).toBeNull();
  });

  it("数値でない値・NaN・Infinity を通さない", () => {
    expect(parseBaselineStats({ ...stats, median: "100" })).toBeNull();
    expect(parseBaselineStats({ ...stats, iqr: NaN })).toBeNull();
    expect(parseBaselineStats({ ...stats, p25: Infinity })).toBeNull();
  });
});

describe("toFlatBaseline", () => {
  it("DB の行を走査側のフラット形にする", () => {
    expect(toFlatBaseline({ metric_key: "revenue", is_established: true, stats })).toEqual({
      metric_key: "revenue",
      is_established: true,
      ...stats,
    });
  });

  it("stats が読めない行は null（呼び出し元が落とす）", () => {
    expect(toFlatBaseline({ metric_key: "revenue", is_established: true, stats: {} })).toBeNull();
  });

  it("配列変換では読めない行が落ちる。0 埋めの行を混ぜない", () => {
    const rows = [
      { metric_key: "revenue", is_established: true, stats },
      { metric_key: "broken", is_established: true, stats: {} },
    ];
    expect(toFlatBaselines(rows).map((b) => b.metric_key)).toEqual(["revenue"]);
  });
});

describe("buildBaselineStats", () => {
  it("観測数が min_obs 未満なら null（空オブジェクトを書かない）", () => {
    expect(buildBaselineStats([1, 2, 3, 4], 5)).toBeNull();
  });

  it("min_obs 以上なら stats を作る", () => {
    const built = buildBaselineStats([10, 20, 30, 40, 50], 5);
    expect(built).toMatchObject({ median: 30, count: 5 });
    expect(built!.p75).toBeGreaterThan(built!.p25);
    expect(built!.iqr).toBe(built!.p75 - built!.p25);
  });

  it("偶数個の中央値は中央2つの平均", () => {
    expect(buildBaselineStats([10, 20, 30, 40], 4)!.median).toBe(25);
  });

  /**
   * **DB へ書く側（Edge）と `src/` の計算が同じ値を出すこと。**
   * ここがずれると、同じ「baseline」という名前で違う数字が2種類できる。
   */
  it("src/state/baselines.ts の calculateBaseline と同じ stats を出す", () => {
    const observations = [12, 7, 30, 21, 18, 25, 9];

    const fromEdge = buildBaselineStats(observations, 5);
    const fromSrc = calculateBaseline(observations, { minObs: 5 });

    expect(fromSrc.is_established).toBe(true);
    expect(fromEdge).toEqual(fromSrc.stats);
  });

  it("確立しない場合も両者の判定が一致する", () => {
    const observations = [1, 2, 3];
    expect(buildBaselineStats(observations, 5)).toBeNull();
    expect(calculateBaseline(observations, { minObs: 5 }).is_established).toBe(false);
  });
});
