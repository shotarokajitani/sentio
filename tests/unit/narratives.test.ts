import { describe, it, expect } from "vitest";
import {
  createNarrative,
  decayConfidence,
  applyCorrection,
  upsertNarrative,
} from "../../src/state/narratives";

describe("Narratives upsert", () => {
  it("new narrative gets confidence=1.0", () => {
    const n = createNarrative("cash_flow_concern", "Worried about cash flow", "evt_001");
    expect(n.confidence).toBe(1.0);
    expect(n.key).toBe("cash_flow_concern");
    expect(n.content).toBe("Worried about cash flow");
    expect(n.source_event_id).toBe("evt_001");
    expect(n.updated_at).toBeDefined();
  });

  it("confidence decays over time (~30 day half-life)", () => {
    const n = createNarrative("concern", "test", "evt_001");
    const now = new Date(n.updated_at);

    // After 0 days: still 1.0
    expect(decayConfidence(n, now)).toBeCloseTo(1.0, 2);

    // After 30 days: ~0.5 (half-life)
    const plus30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const after30 = decayConfidence(n, plus30);
    expect(after30).toBeCloseTo(0.5, 1);

    // After 60 days: ~0.25
    const plus60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const after60 = decayConfidence(n, plus60);
    expect(after60).toBeLessThan(0.3);
    expect(after60).toBeGreaterThan(0.2);
  });

  it("correction reduces confidence immediately", () => {
    const n = createNarrative("wrong_info", "Original content", "evt_001");
    const corrected = applyCorrection(n, "Corrected content", "evt_002");
    expect(corrected.confidence).toBeCloseTo(0.0, 1);
    expect(corrected.content).toBe("Corrected content");
    expect(corrected.source_event_id).toBe("evt_002");
  });

  it("upsert with same key updates existing", () => {
    const existing = createNarrative("topic_a", "Old content", "evt_001");
    const updated = upsertNarrative(existing, "topic_a", "New content", "evt_002");
    expect(updated.key).toBe("topic_a");
    expect(updated.content).toBe("New content");
    expect(updated.source_event_id).toBe("evt_002");
    expect(updated.confidence).toBe(1.0); // refreshed
  });

  it("upsert with null existing creates new", () => {
    const created = upsertNarrative(null, "new_topic", "Brand new", "evt_003");
    expect(created.key).toBe("new_topic");
    expect(created.confidence).toBe(1.0);
  });

  it("decay is deterministic", () => {
    const n = createNarrative("det_test", "content", "evt_001");
    const futureDate = new Date(new Date(n.updated_at).getTime() + 15 * 24 * 60 * 60 * 1000);
    const a = decayConfidence(n, futureDate);
    const b = decayConfidence(n, futureDate);
    expect(a).toBe(b);
  });
});
