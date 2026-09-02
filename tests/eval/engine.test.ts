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

  it("D1: 現在地は 7/7（合格線6・達成）", () => {
    const candidates = runScan(company.events, baselines);
    const result = countDetectedSignals(positiveSignals, candidates);

    // 実測値を必ずログに残す。赤の理由が閾値ではなく実測であることを証跡にする
    console.log(`D1 実測: ${result.detected}/7 検知`);
    for (const m of result.matched) {
      console.log(
        `  ✓ signal ${m.signalId} ← 候補#${m.candidateIndex}（証拠 ${m.overlap.length}件）`,
      );
    }
    for (const s of result.missed) {
      console.log(`  ✗ signal ${s.id} ${s.label}（scanType=${s.scanType}）を検知できていない`);
    }

    /**
     * **契約の合格線は6。現在地は7で、仕込み7件すべてを検知している。**
     *
     * **2026-09-02（4）: 6 → 7。シリーズ単位の間隔を見る走査を足した。**
     * イベントを定例の名前・取引先で束ね、その系列ごとに
     * 「途絶（平常の間隔の3倍を超えて空いた）」と「伸長（間隔が単調に伸びる）」を見る。
     * **両方が同じ間隔列から出る**ので、1つの仕掛けで `#1` と `#7` の両方が埋まった。
     *
     * あわせて仕込み `#1` を直している。**名前と逆の形になっていた**——
     * 時系列に並べると間隔が 50 → 35 → 25 → 18 と縮み、売上は増えていた。
     * すなわち「取引先が離れていく」ではなく「発注が増えて単価も上がる」データで、
     * golden の記述「発注間隔が3ヶ月かけて伸長」とも食い違っていた。
     *
     * **2026-08-31（3）: 5 → 6。途絶（沈黙）を本番に実装した。**
     * 検出器（`_shared/scan.ts`）と `schedule_interval` ベースラインの生成
     * （`state-baselines`）を対で入れている。片方だけでは発火しない。
     *
     * **合格線に届いたことを「検知が十分になった」と読まないこと。**
     * この途絶は `entity_id = null`、すなわち**会社全体の予定間隔**を見ており、
     * 捉えるのは「会社の予定が丸ごと途絶えた」であって
     * 「毎週の定例が消えた」ではない。会議が密な会社ではほぼ発火しない。
     * 限界は `_shared/scan.ts` の走査6に明記した。
     *
     * **2026-08-31（2）: 4 → 5 に更新した。仕様適合の修正による。**
     * `scanMetricChange` が「連続N期同方向」を見ているのに `deviation` と
     * 名乗っていたのを `trend` に直した（`docs/spec/03_sense.md` の
     * 乖離＝平常レンジ逸脱 / 傾向＝連続N期同方向 という定義に合わせた）。
     * **この走査はベースラインを一度も参照しない**ので、定義上「乖離」ではありえない。
     * 仕込み `#3 reply_delay` / `#6 inquiry_decline` の期待も同じ理由で
     * `deviation` → `trend` に揃えた（同じ検出器から出ているため）。
     *
     * **2026-08-31（1）: 5 → 4 に更新した。Scanner の挙動は変わっていない。**
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
     * 残る2件は**どちらも未実装**であり、ラベルの問題ではない。
     * `#1 order_interval_elongation` は発注間隔を見る検出器が無い。
     * `#7 meeting_silence` は途絶の検出器が無く、**加えて `schedule_interval` の
     * ベースラインを誰も作っていない**（本番は `revenue` のみ）。
     * 検出器だけ足しても発火しない。両方を要する（`07_open_items` の判断待ち）。
     *
     * 赤を常設しない理由（2026-08-29 梶谷さん判断）: main が赤だと `deploy.yml` の
     * `verify` が落ちて `deploy-migrations` に到達せず、**本番へ何も出せなくなる**。
     * `tests/eval/` は `verify` の除外対象に入っていない。
     * また常設した赤は一週間で「CI は赤いもの」になり、本物の回帰がその後ろに隠れる。
     */
    expect(result.detected).toBe(7);
  });

  it("D2: 現在地は誤検知 0件（合格線2以下・達成）", () => {
    const candidates = runScan(company.events, baselines);
    const result = countFalsePositives(positiveSignals, candidates);

    console.log(`D2 実測: 誤検知 ${result.count}件 / 候補 ${candidates.length}件`);
    for (const c of result.candidates) {
      console.log(
        `  誤検知: scanType=${c.scanType} 証拠=${c.evidence_event_ids.slice(0, 3).join(",")}`,
      );
    }

    /**
     * **D1 と同じく実測値そのものに固定する。**
     *
     * **2026-09-01: `toBeLessThanOrEqual(2)` から `toBe(0)` に変えた。**
     * 合格線で受けていると、**誤検知が 1 や 2 に増えても緑のまま通る。**
     * PR #51 の判断は「上振れも赤にして現在地の更新を強制する」であり、
     * D1 だけをその形にして D2 を合格線のまま残していたのは、その判断の適用漏れである。
     *
     * 誤検知が 0 でなくなったら、**この行を直すのではなく現在地を更新すること。**
     * すなわち「なぜ増えたか」を確かめ、契約 `docs/contracts/slice-eval-repair.md` の
     * 実測記録を書き換えてから、期待値を新しい実測値に合わせる。
     *
     * いま 0 件なのは、誤検知を出していた `trend`（売上の連続同方向）が
     * **本番の走査に存在しない**ためである（2026-08-31 実測）。
     * 売上の傾向検知を足すと、まずここが赤くなる。**それは正しい赤である。**
     */
    expect(result.count).toBe(0);
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
