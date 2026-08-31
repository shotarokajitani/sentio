import { describe, it, expect } from "vitest";
import { generateSyntheticCompany } from "../../scripts/generate-synthetic-company";
// **本番が動かす実装を測る。** `src/sense/scanner.ts` は本番で走っていない
import { runScan, type ScanBaseline } from "@edge/_shared/scan";
import { countDetectedSignals, countFalsePositives } from "./scoring";
import { loadGoldenCases, compareGoldenWithPlanted } from "./golden";

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
function buildBaselines(): ScanBaseline[] {
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

  it("D1: 現在地は 4/7（合格線6・未達）", () => {
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

    /**
     * **契約の合格線は6。現在地は4で未達である。**
     *
     * **2026-08-31: 5 → 4 に更新した。Scanner の挙動は変わっていない。**
     * このスイートが測る対象を `src/sense/scanner.ts` から
     * `@edge/_shared/scan`（**本番が動かす実装**）に向け直したためである。
     * それまで測っていた `src/sense/scanner.ts` は `tests/` と `scripts/` からしか
     * 参照されておらず、**本番では1行も走っていなかった**
     * （`run-sense` が `functions/v1/scan` を叩く）。
     * 差の内訳は `#7 meeting_silence` で、**本番には silence 検出器が無い。**
     * 経緯は `docs/reports/2026-08-31_検知5of7の内訳実測.md`。
     *
     * `toBeGreaterThanOrEqual` にしない。**実測値そのものに固定する。**
     * 上振れ（6/7 になった）も赤にして、**現在地の更新を強制する**ためである。
     * 4/7 への回帰も同じく赤になる。
     *
     * 数字が変わったら、**この行を直すのではなく現在地を更新すること**。
     * すなわち「なぜ変わったか」を確かめ、契約 `docs/contracts/slice-eval-repair.md` の
     * 実測記録を書き換えてから、この期待値を新しい実測値に合わせる。
     *
     * 落ちている3件の内訳は別物である。**まとめて「ラベルのずれ」と呼ばない。**
     * `#4 overtime_creep` は現象を捉えているが `deviation` と名乗っている（ラベル）。
     * `#1 order_interval_elongation` は発注間隔を見る検出器が無い（未実装）。
     * `#7 meeting_silence` は本番に silence 検出器が無い（未実装）。
     * どれをどう直すかは `docs/spec/07_open_items.md` の判断待ちである。
     *
     * 赤を常設しない理由（2026-08-29 梶谷さん判断）: main が赤だと `deploy.yml` の
     * `verify` が落ちて `deploy-migrations` に到達せず、**本番へ何も出せなくなる**。
     * `tests/eval/` は `verify` の除外対象に入っていない。
     * また常設した赤は一週間で「CI は赤いもの」になり、本物の回帰がその後ろに隠れる。
     */
    expect(result.detected).toBe(4);
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
