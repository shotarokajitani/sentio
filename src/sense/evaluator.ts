export const EVALUATOR_CRITERIA_NAMES = [
  "image",     // 像: 経営者の頭に自社の状態が一枚の絵として浮かぶか
  "evidence",  // 証拠: 全主張が証拠イベントIDに遡れるか
  "dismissal", // 棄却: 平凡な説明を検討し排除根拠が残っているか
  "tone",      // トーン: 断定しない・責めない・用途制限フラグ非抵触
  "action",    // 行動: 緊急度の判定根拠と次の一手が具体か
] as const;

export interface EvalCriterion {
  name: string;
  pass: boolean;
  reason: string;
}

export interface EvalResult {
  criteria: EvalCriterion[];
  revisions: number;
  result: "pass" | "revise" | "reject";
}

export interface EvaluatorInput {
  finding: {
    what: string;
    evidence_event_ids: string[];
    hypotheses: Array<{ text: string; plausibility: string }>;
  };
  evidence: Array<{ event_id: string; summary: string }>;
}

export function buildEvaluatorInput(
  finding: {
    what: string;
    evidence_event_ids: string[];
    hypotheses: Array<{ text: string; plausibility: string }>;
  },
  evidence: Array<{ event_id: string; summary: string }>,
): EvaluatorInput {
  // D3 independence: only pass finding + evidence, never generator reasoning
  return {
    finding: {
      what: finding.what,
      evidence_event_ids: finding.evidence_event_ids,
      hypotheses: finding.hypotheses,
    },
    evidence,
  };
}

export function parseEvalResult(raw: {
  criteria: EvalCriterion[];
  revisions: number;
  result: string;
}): EvalResult {
  return {
    criteria: raw.criteria,
    revisions: raw.revisions,
    result: raw.result as "pass" | "revise" | "reject",
  };
}

export function shouldReject(revisionCount: number): boolean {
  return revisionCount > 2;
}
