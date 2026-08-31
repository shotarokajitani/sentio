import { describe, it, expect } from "vitest";
/**
 * **本番の Scanner を検査する。**
 *
 * 2026-08-31 まで、このファイルは `src/sense/scanner.ts` という
 * **本番で走っていない別実装**を検査していた（`tests/` と `scripts/` からしか
 * 参照が無く、本番は `run-sense` → `functions/v1/scan` を通る）。
 * 死にコードを消すにあたり、**テストは捨てずに本番実装へ付け替えた。**
 * 経緯は `docs/reports/2026-08-31_検知5of7の内訳実測.md`。
 */
import {
  runScan,
  type ScanEvent as TimelineEvent,
  type ScanBaseline as Baseline,
  type ScanCandidate,
} from "@edge/_shared/scan";

// Helper to create timeline events
function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    event_id: "evt_" + Math.random().toString(36).slice(2, 8),
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

  /**
   * **本番には売上の傾向検知が無い。現在地としてここに固定する。**
   *
   * 削除した `src/sense/scanner.ts` には `scanTrend`（売上が N期連続で同方向）が
   * あったが、本番の `_shared/scan.ts` には無い。移植しなかったのは、
   * 評価で**正常データに誤検知していた**ためである
   * （`trend: Rising trend over 4 periods` が仕込みのどれとも交差しなかった）。
   *
   * このテストは「無いこと」を陽性で主張しているのではなく、
   * **黙って消えたのではないと分かるようにする**ためにある。
   * 足すと決めたらここが赤くなり、現在地の更新を強制する。
   * 未検知の `#1 order_interval_elongation` はこの穴と関係している。
   */
  it("売上の連続同方向は検知しない（本番に傾向走査が無い・現在地の固定）", () => {
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
    // 売上由来の傾向候補は出ない（`source: "transaction"` の trend）
    expect(candidates.filter((c) => c.scanType === "trend" && c.source === "transaction")).toEqual(
      [],
    );
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
        metrics: {
          expected_date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          is_overdue: true,
        },
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
    const events: TimelineEvent[] = [makeEvent({ metrics: { revenue: 50000 } })];
    const baselines: Baseline[] = [makeBaseline({ is_established: false })];
    const candidates = runScan(events, baselines);
    // Deviation scan should not trigger for non-established baselines
    expect(candidates.filter((c) => c.scanType === "deviation")).toHaveLength(0);
  });

  it("metric change: detects reply_time worsening (#3 reply_delay)", () => {
    const now = Date.now();
    const events: TimelineEvent[] = [
      makeEvent({
        event_id: "comm_reply_0",
        event_type: "communication",
        metrics: { reply_time_hours: 2, actor: "entity_employee_tanaka" },
        occurred_at: new Date(now - 21 * 24 * 60 * 60 * 1000).toISOString(),
        sensitivity: "S2",
      }),
      makeEvent({
        event_id: "comm_reply_1",
        event_type: "communication",
        metrics: { reply_time_hours: 10, actor: "entity_employee_tanaka" },
        occurred_at: new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString(),
        sensitivity: "S2",
      }),
      makeEvent({
        event_id: "comm_reply_2",
        event_type: "communication",
        metrics: { reply_time_hours: 18, actor: "entity_employee_tanaka" },
        occurred_at: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
        sensitivity: "S2",
      }),
    ];
    const candidates = runScan(events, []);
    const replyCandidate = candidates.find(
      (c) => c.source === "communication" && c.scanType === "trend",
    );
    expect(replyCandidate).toBeDefined();
    expect(replyCandidate!.evidence_event_ids).toHaveLength(3);
  });

  it("metric change: detects inquiry_count decline (#6 inquiry_decline)", () => {
    const now = Date.now();
    const events: TimelineEvent[] = [0, 1, 2, 3].map((w) =>
      makeEvent({
        event_id: `web_inquiry_${w}`,
        event_type: "web",
        metrics: { inquiry_count: 10 - w * 3 }, // 10, 7, 4, 1
        occurred_at: new Date(now - (28 - w * 7) * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const candidates = runScan(events, []);
    const inquiryCandidate = candidates.find(
      (c) => c.source === "web" && c.scanType === "trend",
    );
    expect(inquiryCandidate).toBeDefined();
    expect(inquiryCandidate!.evidence_event_ids).toHaveLength(4);
  });

  it("metric change: no detection for non-monotonic data", () => {
    const now = Date.now();
    const events: TimelineEvent[] = [
      makeEvent({
        event_type: "communication",
        metrics: { reply_time_hours: 2 },
        occurred_at: new Date(now - 21 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      makeEvent({
        event_type: "communication",
        metrics: { reply_time_hours: 10 },
        occurred_at: new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      makeEvent({
        event_type: "communication",
        metrics: { reply_time_hours: 5 }, // goes back down — not monotonic
        occurred_at: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const candidates = runScan(events, []);
    expect(candidates.filter((c) => c.source === "communication")).toHaveLength(0);
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
