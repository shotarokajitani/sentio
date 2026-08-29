import { describe, it, expect } from "vitest";
import { generateSyntheticCompany } from "../../scripts/generate-synthetic-company";
import { runScan, type Baseline } from "../../src/sense/scanner";
import { countDetectedSignals, countFalsePositives } from "./scoring";
import {
  loadGoldenCases,
  compareGoldenWithPlanted,
  checkDay0Artifact,
  loadDay0Artifact,
  type Day0Expectations,
} from "./golden";

/**
 * エンジン評価スイート（契約 `docs/contracts/slice-eval-repair.md`・スライスE）。
 *
 * D1: 陽性7件のうち6件以上を検知する
 * D2: 誤検知2件以下 ＋ 陰性コントロール⑤は検知されない
 *
 * **判定は証拠まで見る。** 直す前は `c.scanType === signal.scanType` しか見ておらず、
 * 仕込み7件が5種類の `scanType` しか持たないため、
 * **正しい型の候補が5件あれば 7/7 と採点されていた**（`detectedTypes` は計算されるだけで未使用だった）。
 * 採点器そのものの検査は `tests/unit/eval-scoring.test.ts` にある。
 *
 * Scanner（`src/sense/scanner.ts`）はこのスライスでは直さない（E-D5）。
 * **測り方だけを直す。** 測った結果が合格線に届かないなら、それが現在地である。
 */

const GOLDEN_ROOT = "eval/golden";

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
  const positiveSignals = company.plantedSignals.filter((s) => s.type === "positive");

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
    const result = countDetectedSignals(positiveSignals, candidates);

    // 実測値を必ずログに残す。赤の理由が閾値ではなく実測であることを証跡にする
    console.log(`D1 実測: ${result.detected}/7 検知`);
    for (const m of result.matched) {
      console.log(`  ✓ signal ${m.signalId} ← 候補#${m.candidateIndex}（証拠 ${m.overlap.length}件）`);
    }
    for (const s of result.missed) {
      console.log(`  ✗ signal ${s.id} ${s.label}（scanType=${s.scanType}）を検知できていない`);
    }

    expect(result.detected).toBeGreaterThanOrEqual(6);
  });

  it("D2: false positives <= 2", () => {
    const candidates = runScan(company.events, baselines);
    const result = countFalsePositives(positiveSignals, candidates);

    console.log(`D2 実測: 誤検知 ${result.count}件 / 候補 ${candidates.length}件`);
    for (const c of result.candidates) {
      console.log(`  誤検知: scanType=${c.scanType} 証拠=${c.evidence_event_ids.slice(0, 3).join(",")}`);
    }

    expect(result.count).toBeLessThanOrEqual(2);
  });

  it("D2: negative control ⑤ (seasonal normal) is NOT detected", () => {
    const candidates = runScan(company.events, baselines);
    // Normal seasonal revenue (93k in Aug) should be within p25-p75 range
    // and not trigger deviation scan
    const seasonalFalsePositive = candidates.filter((c) => {
      if (c.scanType !== "deviation") return false;
      return c.evidence_event_ids.some((id) => id.startsWith("txn_normal"));
    });
    expect(seasonalFalsePositive).toHaveLength(0);
  });
});

describe("Golden set (E-3-1)", () => {
  it("eval/golden の meta.json を実際に読み、仕込みと突き合わせる", () => {
    const cases = loadGoldenCases(GOLDEN_ROOT);
    const company = generateSyntheticCompany();

    expect(cases).toHaveLength(12);
    expect(compareGoldenWithPlanted(cases, company.plantedSignals).problems).toEqual([]);
  });
});

describe("real-diseno の再発防止条件 (E-4-1 / E-4-2)", () => {
  it("Day0 成果物が meta.json の条件を満たす", () => {
    const cases = loadGoldenCases(GOLDEN_ROOT);
    const realCase = cases.find((c) => c.name === "real-diseno");
    if (!realCase) throw new Error("real-diseno ケースが無い");

    const expectations = realCase.meta.expected as unknown as Day0Expectations;
    const artifact = loadDay0Artifact(realCase.dir);

    const result = checkDay0Artifact(expectations, artifact);
    if (result.problems.length > 0) {
      console.log("E-4 実測: Day0 成果物の検査に問題あり");
      for (const p of result.problems) console.log(`  - ${p}`);
    }

    // **成果物が無いことを pass にしない**（E-4-2）。fail-open を潰す
    expect(result.problems).toEqual([]);
  });
});
