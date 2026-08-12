import { describe, it, expect } from "vitest";
import {
  createFinding,
  handleRedetection,
  transitionStatus,
  type FindingRecord,
} from "../../src/sense/finding-lifecycle";

describe("Finding lifecycle (D6)", () => {
  function makeFinding(overrides: Partial<FindingRecord> = {}): FindingRecord {
    return {
      id: "f_001",
      company_id: "550e8400-e29b-41d4-a716-446655440000",
      status: "open",
      urgency: "weekly",
      what: "Revenue dropped 30%",
      evidence_event_ids: ["evt_001", "evt_002"],
      confidence: 0.8,
      hypotheses: [
        { text: "Customer churn", plausibility: "high" as const },
        { text: "Seasonal effect", plausibility: "medium" as const },
        { text: "Pricing issue", plausibility: "low" as const },
      ],
      parent_finding_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("D6: redetection updates existing finding instead of creating new", () => {
    const existing = makeFinding();
    const newEvidence = ["evt_003", "evt_004"];
    const redetected = handleRedetection(existing, newEvidence);
    expect(redetected.id).toBe(existing.id); // same ID
    expect(redetected.status).toBe("open"); // re-opened
    expect(redetected.evidence_event_ids.length).toBeGreaterThan(
      existing.evidence_event_ids.length,
    );
    expect(redetected.evidence_event_ids).toContain("evt_003");
    expect(redetected.evidence_event_ids).toContain("evt_004");
  });

  it("D6: redetection on resolved finding re-opens it", () => {
    const resolved = makeFinding({ status: "resolved" });
    const redetected = handleRedetection(resolved, ["evt_005"]);
    expect(redetected.status).toBe("open");
  });

  it("D6: watching -> resolved transition", () => {
    const watching = makeFinding({
      status: "watching",
      updated_at: new Date(Date.now() - 1000).toISOString(),
    });
    const resolved = transitionStatus(watching, "resolved");
    expect(resolved.status).toBe("resolved");
    expect(new Date(resolved.updated_at).getTime()).toBeGreaterThan(
      new Date(watching.updated_at).getTime(),
    );
  });

  it("D6: open -> watching transition", () => {
    const open = makeFinding({ status: "open" });
    const watching = transitionStatus(open, "watching");
    expect(watching.status).toBe("watching");
  });

  it("D6: open -> expired transition", () => {
    const open = makeFinding({ status: "open" });
    const expired = transitionStatus(open, "expired");
    expect(expired.status).toBe("expired");
  });

  it("D6: evidence deduplication on redetection", () => {
    const existing = makeFinding({ evidence_event_ids: ["evt_001", "evt_002"] });
    const redetected = handleRedetection(existing, ["evt_002", "evt_003"]);
    // evt_002 should not be duplicated
    const evt002Count = redetected.evidence_event_ids.filter(
      (id) => id === "evt_002",
    ).length;
    expect(evt002Count).toBe(1);
    expect(redetected.evidence_event_ids).toHaveLength(3);
  });

  it("createFinding produces valid structure", () => {
    const finding = createFinding({
      company_id: "550e8400-e29b-41d4-a716-446655440000",
      what: "Test finding",
      evidence_event_ids: ["evt_001"],
      hypotheses: [
        { text: "H1", plausibility: "high" },
        { text: "H2", plausibility: "medium" },
        { text: "H3", plausibility: "low" },
      ],
      urgency: "weekly",
      confidence: 0.7,
    });
    expect(finding.status).toBe("open");
    expect(finding.id).toBeDefined();
    expect(finding.parent_finding_id).toBeNull();
  });
});
