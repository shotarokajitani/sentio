import { describe, it, expect } from "vitest";
import {
  buildEvaluatorInput,
  parseEvalResult,
  shouldReject,
  computeDay0Pass,
  EVALUATOR_CRITERIA_NAMES,
  DAY0_CRITERIA_NAMES,
  type EvalCriterion,
} from "../../src/sense/evaluator";

describe("Evaluator (D3)", () => {
  it("D3: evaluator input contains exactly 5 criteria names", () => {
    expect(EVALUATOR_CRITERIA_NAMES).toHaveLength(5);
    expect(EVALUATOR_CRITERIA_NAMES).toEqual([
      "image",      // 像
      "evidence",   // 証拠
      "dismissal",  // 棄却
      "tone",       // トーン
      "action",     // 行動
    ]);
  });

  it("D3: eval result has 5 criteria judgments", () => {
    const mockResult: EvalCriterion[] = EVALUATOR_CRITERIA_NAMES.map((name) => ({
      name,
      pass: true,
      reason: `Criterion ${name} passed`,
    }));
    const parsed = parseEvalResult({
      criteria: mockResult,
      revisions: 0,
      result: "pass",
    });
    expect(parsed.criteria).toHaveLength(5);
    parsed.criteria.forEach((c) => {
      expect(c).toHaveProperty("name");
      expect(c).toHaveProperty("pass");
      expect(c).toHaveProperty("reason");
    });
  });

  it("D3: revise is capped at 2 — 3rd revision triggers reject", () => {
    expect(shouldReject(0)).toBe(false);
    expect(shouldReject(1)).toBe(false);
    expect(shouldReject(2)).toBe(false);
    expect(shouldReject(3)).toBe(true);
  });

  it("D3: evaluator input does NOT contain generator reasoning", () => {
    const finding = {
      what: "Revenue dropped",
      evidence_event_ids: ["evt_001"],
      hypotheses: [
        { text: "H1", plausibility: "high" as const },
        { text: "H2", plausibility: "medium" as const },
        { text: "H3", plausibility: "low" as const },
      ],
    };
    const evidence = [{ event_id: "evt_001", summary: "Revenue was 50k, baseline 100k" }];

    const input = buildEvaluatorInput(finding, evidence);
    // Must not contain generator's internal reasoning
    expect(input).not.toHaveProperty("generatorReasoning");
    expect(input).not.toHaveProperty("generator_reasoning");
    expect(input).not.toHaveProperty("reasoning_trace");
    // Must contain finding and evidence
    expect(input).toHaveProperty("finding");
    expect(input).toHaveProperty("evidence");
  });

  it("D3: all-pass result returns pass", () => {
    const allPass: EvalCriterion[] = EVALUATOR_CRITERIA_NAMES.map((name) => ({
      name,
      pass: true,
      reason: "OK",
    }));
    const parsed = parseEvalResult({ criteria: allPass, revisions: 0, result: "pass" });
    expect(parsed.result).toBe("pass");
  });

  it("D3: any-fail result with revisions < 3 returns revise", () => {
    const criteria: EvalCriterion[] = EVALUATOR_CRITERIA_NAMES.map((name, i) => ({
      name,
      pass: i !== 2, // 3rd criterion fails
      reason: i === 2 ? "Insufficient dismissal" : "OK",
    }));
    const parsed = parseEvalResult({ criteria, revisions: 1, result: "revise" });
    expect(parsed.result).toBe("revise");
  });
});

describe("Day0 Evaluator (D+3)", () => {
  it("D+3: all criteria pass → computeDay0Pass returns true", () => {
    const results: Record<string, { pass: boolean; reason: string }> = {};
    for (let i = 1; i <= 5; i++) {
      results[`criteria_${i}`] = { pass: true, reason: "OK" };
    }
    expect(computeDay0Pass(results)).toBe(true);
  });

  it("D+3: one criterion fails → computeDay0Pass returns false", () => {
    const results: Record<string, { pass: boolean; reason: string }> = {};
    for (let i = 1; i <= 5; i++) {
      results[`criteria_${i}`] = {
        pass: i !== 5, // criteria_5 (specificity) fails
        reason: i === 5 ? "抽象的な一般論のみで具体的な数字・固有名詞がない" : "OK",
      };
    }
    expect(computeDay0Pass(results)).toBe(false);
  });

  it("D+3: vague input must fail specificity criterion", () => {
    // This is the exact test input from the contract D+3
    const _vagueInput = "御社の事業は順調に推移していると思われます。今後もこの調子で成長が続く可能性があります。";
    // The input has no numbers, no specific names, no data sources
    // When evaluated by the LLM, criteria_5 (specificity) must fail
    // Here we test the AND logic: even if LLM returns overall_pass:true,
    // computeDay0Pass correctly rejects when criteria_5 is false
    const results: Record<string, { pass: boolean; reason: string }> = {
      criteria_1: { pass: true, reason: "OK" },
      criteria_2: { pass: true, reason: "OK" },
      criteria_3: { pass: true, reason: "OK" },
      criteria_4: { pass: true, reason: "OK" },
      criteria_5: { pass: false, reason: "具体的な数字・傾向・固有名詞が含まれていない" },
    };
    expect(computeDay0Pass(results)).toBe(false);
  });

  it("D+3: fewer than 5 criteria → computeDay0Pass returns false", () => {
    const results: Record<string, { pass: boolean; reason: string }> = {
      criteria_1: { pass: true, reason: "OK" },
      criteria_2: { pass: true, reason: "OK" },
      criteria_3: { pass: true, reason: "OK" },
    };
    expect(computeDay0Pass(results)).toBe(false);
  });

  it("Day0 criteria names are defined", () => {
    expect(DAY0_CRITERIA_NAMES).toHaveLength(5);
    expect(DAY0_CRITERIA_NAMES).toContain("specificity");
    expect(DAY0_CRITERIA_NAMES).toContain("provisional");
  });
});
