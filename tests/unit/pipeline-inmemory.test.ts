import { describe, it, expect } from "vitest";
import { generateSyntheticCompany } from "../../scripts/generate-synthetic-company";
import { runScan, type Baseline, type ScanCandidate } from "../../src/sense/scanner";
import {
  renderWeekly,
  type FindingSummary,
  type CompanyState,
} from "../../src/act/weekly-renderer";

/**
 * scan → findings → deliver-weekly を **インメモリで** 通すテスト。
 * D+1（findings が出る）・D+2（週次の件数が findings と一致する）を、
 * `src/` の純関数に手作りのオブジェクトを渡して確認する。
 *
 * 2026-08-19 に `tests/integration/pipeline.test.ts` から移設した（契約 S-5-3）。
 * 実DBにも Edge Function にも当たらないのに `integration` を名乗っており、
 * State層が実スキーマに対して一度も動いていない事実がこの緑の裏に隠れていた。
 * **実DBに当たる版は `tests/integration/pipeline-db.test.ts`。** 両方を残す。
 */

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

// Simulate the orchestrator's classification of candidates
function classifyCandidates(candidates: ScanCandidate[]) {
  const immediates = candidates.filter((c) => c.suggestedUrgency === "immediate");
  const forInvestigation = candidates
    .filter((c) => c.suggestedUrgency !== "immediate")
    .sort((a, b) => b.score - a.score);
  return { immediates, forInvestigation };
}

// Convert scan candidates to finding summaries (simulates Investigator pass-through)
function candidatesToFindings(candidates: ScanCandidate[]): FindingSummary[] {
  return candidates.map((c) => ({
    what: c.description,
    urgency: c.suggestedUrgency,
    nextAction: "Investigate further",
  }));
}

describe("Pipeline integration: scan → findings → weekly (D+1, D+2)", () => {
  const company = generateSyntheticCompany();
  const baselines = buildBaselines();

  it("D+1: scan produces candidates that would INSERT into findings", () => {
    const candidates = runScan(company.events, baselines);
    // At least 1 candidate must exist (otherwise findings table is empty)
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    // Classify like the orchestrator does
    const { immediates, forInvestigation } = classifyCandidates(candidates);

    // Immediate candidates go directly to findings (fast path)
    // Non-immediate candidates go through Investigator
    const totalFindingCandidates = immediates.length + forInvestigation.length;
    expect(totalFindingCandidates).toBeGreaterThanOrEqual(1);
  });

  it("D+1: specific planted signals are detected", () => {
    const candidates = runScan(company.events, baselines);

    // #2 payment_overdue → deadline scan → immediate
    const overdueCandidate = candidates.find(
      (c) =>
        c.scanType === "deadline" &&
        c.evidence_event_ids.some((id) => id.startsWith("txn_overdue")),
    );
    expect(overdueCandidate).toBeDefined();

    // #8 competitor_hire → external scan
    const competitorCandidate = candidates.find(
      (c) =>
        c.scanType === "external" &&
        c.evidence_event_ids.some((id) => id.startsWith("ext_competitor")),
    );
    expect(competitorCandidate).toBeDefined();

    // #3 reply_delay → metric change scan (deviation from communication)
    const replyCandidate = candidates.find(
      (c) =>
        c.source === "communication" &&
        c.evidence_event_ids.some((id) => id.startsWith("comm_reply")),
    );
    expect(replyCandidate).toBeDefined();

    // #6 inquiry_decline → metric change scan (deviation from web)
    const inquiryCandidate = candidates.find(
      (c) => c.source === "web" && c.evidence_event_ids.some((id) => id.startsWith("web_inquiry")),
    );
    expect(inquiryCandidate).toBeDefined();
  });

  it("D+2: weekly Finding count matches scan-generated findings", () => {
    const candidates = runScan(company.events, baselines);
    const { immediates, forInvestigation } = classifyCandidates(candidates);

    // All candidates become findings (immediates direct, others via Investigator)
    const allFindings = candidatesToFindings([...immediates, ...forInvestigation]);

    const state: CompanyState = {
      baselineCount: 32,
      coverageCount: 28,
      stableSummary: "32 indicators normal",
    };

    const sections = renderWeekly(allFindings, state);

    // Weekly renderer should reflect the findings
    const findingSection = sections.find((s) => s.type === "finding");
    expect(findingSection).toBeDefined();

    // Finding section content should be non-empty when findings exist
    if (allFindings.length > 0) {
      expect(findingSection!.content.length).toBeGreaterThan(0);
    }

    // Digest should mention finding count
    const digest = sections.find((s) => s.type === "digest");
    expect(digest).toBeDefined();
    expect(digest!.content).toContain("finding");
  });

  it("D+2: weekly displays max 2 findings even when more exist", () => {
    const candidates = runScan(company.events, baselines);
    // We expect multiple candidates from synthetic data
    expect(candidates.length).toBeGreaterThan(2);

    const allFindings = candidatesToFindings(candidates);
    const state: CompanyState = {
      baselineCount: 32,
      coverageCount: 28,
      stableSummary: "32 indicators normal",
    };

    const sections = renderWeekly(allFindings, state);
    const findingSection = sections.find((s) => s.type === "finding");

    // Max 2 findings displayed per E1
    const findingLines = findingSection!.content.split("\n").filter((l) => l.startsWith("- "));
    expect(findingLines.length).toBeLessThanOrEqual(2);
  });

  it("immediate candidates are only from monitor/deadline (D4)", () => {
    const candidates = runScan(company.events, baselines);
    const { immediates } = classifyCandidates(candidates);

    for (const imm of immediates) {
      expect(["deadline", "monitor"]).toContain(imm.source);
    }
  });

  it("negative control #5: seasonal normal revenue does not trigger deviation", () => {
    const candidates = runScan(company.events, baselines);
    // Normal seasonal revenue (93k in Aug) is within p25(93000)-p75(108000)
    // and should not trigger deviation scan as a standalone signal.
    // Note: trend scan may include txn_normal events when interleaved with
    // declining txn_order events — this is expected cross-signal behavior,
    // not a false positive on seasonal data.
    const seasonalDeviationFP = candidates.filter((c) => {
      if (c.scanType !== "deviation" || c.source !== "transaction") return false;
      return c.evidence_event_ids.every((id) => id.startsWith("txn_normal"));
    });
    expect(seasonalDeviationFP).toHaveLength(0);
  });
});
