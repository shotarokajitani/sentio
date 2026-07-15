import { describe, it, expect } from "vitest";
import {
  buildEvaluatorInput,
  parseEvalResult,
  shouldReject,
  EVALUATOR_CRITERIA_NAMES,
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
