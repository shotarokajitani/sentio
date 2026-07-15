import { describe, it, expect } from "vitest";
import {
  runScan,
  type TimelineEvent,
  type Baseline,
  type ScanCandidate,
} from "../../src/sense/scanner";

// Helper to create timeline events
function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    event_id: "evt_" + Math.random().toString(36).slice(2, 8),
    company_id: "550e8400-e29b-41d4-a716-446655440000",
    occurred_at: new Date().toISOString(),
    source: "test",
    event_type: "transaction",
    metrics: {},
    sensitivity: "S1",
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    metric_key: "revenue",
    is_established: true,
    median: 100000,
    iqr: 20000,
    p25: 90000,
    p75: 110000,
    count: 30,
    ...overrides,
  };
}

describe("Scanner (D1-D2, D4)", () => {
  it("deviation scan: detects baseline range breach", () => {
    const events: TimelineEvent[] = [
      makeEvent({
        event_type: "transaction",
        metrics: { revenue: 50000 }, // well below p25 of 90000
        occurred_at: new Date().toISOString(),
      }),
    ];
    const baselines: Baseline[] = [makeBaseline()];
    const candidates = runScan(events, baselines);
    expect(candidates.some((c) => c.scanType === "deviation")).toBe(true);
  });

  it("trend scan: detects N consecutive same-direction periods", () => {
    // 5 consecutive declining revenue events
    const now = Date.now();
    const events: TimelineEvent[] = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        event_type: "transaction",
        metrics: { revenue: 100000 - i * 10000 },
        occurred_at: new Date(now - (4 - i) * 7 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const baselines: Baseline[] = [makeBaseline()];
    const candidates = runScan(events, baselines);
    expect(candidates.some((c) => c.scanType === "trend")).toBe(true);
  });

  it("silence scan: detects expected interval exceeded", () => {
    // Last event was 60 days ago, expected interval is 7 days
    const events: TimelineEvent[] = [
      makeEvent({
        event_type: "schedule",
        metrics: {},
        occurred_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const baselines: Baseline[] = [
      makeBaseline({
        metric_key: "schedule_interval",
        median: 7, // expected every 7 days
        iqr: 2,
        p25: 6,
        p75: 8,
      }),
    ];
    const candidates = runScan(events, baselines);
    expect(candidates.some((c) => c.scanType === "silence")).toBe(true);
  });

  it("deadline scan: detects overdue payment", () => {
    // Payment expected but not arrived
    const events: TimelineEvent[] = [
      makeEvent({
        event_type: "transaction",
        metrics: { expected_date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), is_overdue: true },
        occurred_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const baselines: Baseline[] = [makeBaseline()];
    const candidates = runScan(events, baselines);
    expect(candidates.some((c) => c.scanType === "deadline")).toBe(true);
  });

  it("external scan: S0 news matched with company context", () => {
    const events: TimelineEvent[] = [
      makeEvent({
        event_type: "external",
        sensitivity: "S0",
        company_id: null,
        metrics: { relevance: "competitor_hiring" },
        source: "gbizinfo",
      }),
    ];
    const baselines: Baseline[] = [makeBaseline()];
    const candidates = runScan(events, baselines);
    expect(candidates.some((c) => c.scanType === "external")).toBe(true);
  });

  it("D4: only monitor/deadline candidates can have immediate urgency", () => {
    const events: TimelineEvent[] = [
      makeEvent({
        event_type: "monitor",
        metrics: { status: "down", url: "https://example.com" },
        source: "monitor:health",
      }),
    ];
    const baselines: Baseline[] = [makeBaseline()];
    const candidates = runScan(events, baselines);
    const immediate = candidates.filter((c) => c.suggestedUrgency === "immediate");
    immediate.forEach((c) => {
      expect(["deadline", "monitor"]).toContain(c.source);
    });
  });

  it("baseline not established: no candidates generated", () => {
    const events: TimelineEvent[] = [
      makeEvent({ metrics: { revenue: 50000 } }),
    ];
    const baselines: Baseline[] = [
      makeBaseline({ is_established: false }),
    ];
    const candidates = runScan(events, baselines);
    // Deviation scan should not trigger for non-established baselines
    expect(candidates.filter((c) => c.scanType === "deviation")).toHaveLength(0);
  });

  it("D2: seasonal normal decline is NOT detected (negative control)", () => {
    // Revenue within normal seasonal range (between p25 and p75)
    const events: TimelineEvent[] = [
      makeEvent({
        event_type: "transaction",
        metrics: { revenue: 95000 }, // within p25(90000)-p75(110000)
        occurred_at: new Date().toISOString(),
      }),
    ];
    const baselines: Baseline[] = [makeBaseline()];
    const candidates = runScan(events, baselines);
    // No deviation should be detected for values within normal range
    expect(candidates.filter((c) => c.scanType === "deviation")).toHaveLength(0);
  });
});
