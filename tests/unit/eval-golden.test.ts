/**
 * `eval/golden/**` のローダ（スライスE・E-3-1）。
 *
 * `eval/golden` は12ケース分の `meta.json` を持ちながら、
 * **`engine.test.ts` から一度も読まれていなかった**。読まれない期待値は文書であって検査ではない。
 *
 * `real-diseno/meta.json` には過去に実際に起きた誤採点が記録されている。
 * **その再発防止（E-4）は別PRに切り出した**（ブロッカー2件のため未着手）。
 * ここで見るのは golden を**実際に読む**ことと、仕込みとの突合だけである。
 */

import { describe, it, expect } from "vitest";
import { generateSyntheticCompany } from "../../scripts/generate-synthetic-company";
import { loadGoldenCases, compareGoldenWithPlanted } from "../eval/golden";

const GOLDEN_ROOT = "eval/golden";

describe("eval/golden を実際に読む（スライスE）", () => {
  it("E-3-1: 12ケースの meta.json を実際に読み込む", () => {
    const cases = loadGoldenCases(GOLDEN_ROOT);

    expect(cases).toHaveLength(12);
    expect(cases.filter((c) => c.meta.type === "positive")).toHaveLength(7);
    expect(cases.filter((c) => c.meta.type === "negative")).toHaveLength(4);
    expect(cases.filter((c) => c.meta.type === "real")).toHaveLength(1);
    // 読めているかを内容で確かめる。件数だけだと空オブジェクトでも通る
    const first = cases.find((c) => c.meta.id === 1);
    expect(first?.meta.scanType).toBe("trend");
    expect(first?.name).toBe("positive-01-order-interval");
  });

  it("E-3-1: 仕込みの id / type / scanType が golden と一致する", () => {
    const cases = loadGoldenCases(GOLDEN_ROOT);
    const company = generateSyntheticCompany();

    expect(compareGoldenWithPlanted(cases, company.plantedSignals).problems).toEqual([]);
  });

  it("E-3-1（陰性コントロール）: 仕込みの scanType が golden とずれたら問題として出す", () => {
    const cases = loadGoldenCases(GOLDEN_ROOT);
    const company = generateSyntheticCompany();
    const tampered = company.plantedSignals.map((s) =>
      s.id === 1 ? { ...s, scanType: "silence" } : s,
    );

    const problems = compareGoldenWithPlanted(cases, tampered).problems;
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("scanType");
  });
});
