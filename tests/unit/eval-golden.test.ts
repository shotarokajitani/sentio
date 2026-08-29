/**
 * `eval/golden/**` のローダと Day0 成果物の検査器（スライスE・E-3-1 / E-4-1 / E-4-2）。
 *
 * `eval/golden` は12ケース分の `meta.json` を持ちながら、
 * **`engine.test.ts` から一度も読まれていなかった**。読まれない期待値は文書であって検査ではない。
 *
 * `real-diseno/meta.json` には過去に実際に起きた誤採点が記録されている
 * （テンプレ差し込みの Day0 を pass と誤採点。生成時間135ms が証拠）。
 * 再発防止の条件は機械検査可能な形で書かれているのに、**検査するコードが無かった**。
 */

import { describe, it, expect } from "vitest";
import { generateSyntheticCompany } from "../../scripts/generate-synthetic-company";
import {
  loadGoldenCases,
  compareGoldenWithPlanted,
  checkDay0Artifact,
  type Day0Artifact,
} from "../eval/golden";

const GOLDEN_ROOT = "eval/golden";

function validArtifact(): Day0Artifact {
  return {
    evaluator_ran: true,
    generation_time_ms: 4200,
    blocks: {
      initial_hypothesis: "入出金の推移とカレンダーの会議件数から、月次で出金超過の傾向が見えます",
      external_view: "サイト分析: タイトルとメタ情報を取得しました",
      coverage_map: "カレンダー / 入出金CSV（暫定集計）",
    },
  };
}

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

describe("Day0 成果物の検査（スライスE・real-diseno の再発防止）", () => {
  const expectations = {
    evaluator_must_run: true,
    generation_time_min_ms: 2000,
    day0_must_contain: {
      initial_hypothesis: ["入出金", "カレンダー", "具体的金額or件数or傾向"],
      external_view: ["サイト分析", "タイトルorメタ情報"],
      coverage_map: ["カレンダー", "入出金CSV", "暫定集計"],
    },
  };

  it("E-4-1: 条件を満たす成果物は pass する", () => {
    expect(checkDay0Artifact(expectations, validArtifact()).problems).toEqual([]);
  });

  it("E-4-2（陰性コントロール）: 成果物が無いときは fail する。黙って pass しない", () => {
    const result = checkDay0Artifact(expectations, null);

    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.join("\n")).toContain("成果物");
  });

  it("E-4-1（陰性コントロール）: Evaluator が走っていなければ問題として出す", () => {
    const artifact = { ...validArtifact(), evaluator_ran: false };
    expect(checkDay0Artifact(expectations, artifact).problems.join("\n")).toContain("Evaluator");
  });

  it("E-4-1（陰性コントロール）: 生成時間が下限未満なら問題として出す（135ms 事故の形）", () => {
    const artifact = { ...validArtifact(), generation_time_ms: 135 };
    const problems = checkDay0Artifact(expectations, artifact).problems.join("\n");
    expect(problems).toContain("135");
    expect(problems).toContain("2000");
  });

  it("E-4-1（陰性コントロール）: 必須語を含まないブロックを問題として出す", () => {
    const artifact = validArtifact();
    artifact.blocks.initial_hypothesis = "テンプレートの文章です";
    expect(checkDay0Artifact(expectations, artifact).problems.join("\n")).toContain(
      "initial_hypothesis",
    );
  });

  it("E-4-1: 「AorB」形式の必須語はどちらか一方で満たす", () => {
    const artifact = validArtifact();
    // 「具体的金額or件数or傾向」を「件数」だけで満たす
    artifact.blocks.initial_hypothesis = "入出金とカレンダーの件数を集計しました";
    expect(checkDay0Artifact(expectations, artifact).problems).toEqual([]);
  });
});
