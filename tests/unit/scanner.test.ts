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

/**
 * シリーズ単位の間隔（走査7・8／2026-09-02 追加）。
 *
 * 会社全体の予定間隔（走査6）では「**毎週の定例が消えた**」を捉えられない。
 * イベントを定例の名前・取引先で束ね、系列ごとに見る。
 * **途絶と伸長は同じ間隔列から出る。**
 */
describe("シリーズ単位の間隔（途絶・伸長）", () => {
  /** `daysAgo` 日前の予定イベント */
  function scheduleAt(daysAgo: number, title: string): TimelineEvent {
    return makeEvent({
      event_type: "schedule",
      occurred_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
      metrics: { title },
    });
  }

  function orderAt(daysAgo: number, client: string): TimelineEvent {
    return makeEvent({
      event_type: "transaction",
      occurred_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
      metrics: { order_client: client },
    });
  }

  const baselines: Baseline[] = [makeBaseline()];

  it("途絶: 週次の定例が平常の3倍を超えて空いたら検知する", () => {
    // 7日おきに5回 → 平常7日。最後が28日前なので 28 > 21 で発火する
    const weekly = [56, 49, 42, 35, 28].map((d) => scheduleAt(d, "週次定例"));
    const candidates = runScan(weekly, baselines);
    const silence = candidates.filter((c) => c.scanType === "silence");
    expect(silence).toHaveLength(1);
    expect(silence[0].description).toContain("週次定例");
  });

  it("陰性: 平常どおり続いている定例は検知しない", () => {
    const weekly = [28, 21, 14, 7, 1].map((d) => scheduleAt(d, "週次定例"));
    expect(runScan(weekly, baselines).filter((c) => c.scanType === "silence")).toEqual([]);
  });

  it("伸長: 間隔が単調に伸びていれば検知する", () => {
    // 古い順の間隔 14 → 18 → 25 → 35
    const orders = [112, 98, 80, 55, 20].map((d) => orderAt(d, "取引先A"));
    const trend = runScan(orders, baselines).filter(
      (c) => c.scanType === "trend" && c.source === "transaction",
    );
    expect(trend).toHaveLength(1);
    expect(trend[0].description).toContain("取引先A");
  });

  it("**陰性: 縮む側は検知しない**（発注が増えるのは良い兆候である）", () => {
    // 古い順の間隔 35 → 25 → 18 → 14
    const orders = [92, 57, 32, 14, 0].map((d) => orderAt(d, "取引先A"));
    expect(
      runScan(orders, baselines).filter(
        (c) => c.scanType === "trend" && c.source === "transaction",
      ),
    ).toEqual([]);
  });

  it("陰性: 間隔がばらついていれば伸長ではない", () => {
    const orders = [90, 60, 50, 20, 10].map((d) => orderAt(d, "取引先A"));
    expect(
      runScan(orders, baselines).filter(
        (c) => c.scanType === "trend" && c.source === "transaction",
      ),
    ).toEqual([]);
  });

  it("陰性: 間隔が3本未満の系列は見ない（平常が定まらない）", () => {
    const few = [30, 20, 10].map((d) => scheduleAt(d, "たまの打合せ")); // 間隔2本
    expect(runScan(few, baselines).filter((c) => c.scanType === "silence")).toEqual([]);
  });

  it("系列の鍵が無いイベントは束ねない（title も meeting_type も無い）", () => {
    const noKey = [56, 49, 42, 35, 28].map((d) =>
      makeEvent({
        event_type: "schedule",
        occurred_at: new Date(Date.now() - d * 86400000).toISOString(),
        metrics: {},
      }),
    );
    expect(runScan(noKey, baselines).filter((c) => c.scanType === "silence")).toEqual([]);
  });

  it("**本番の鍵**（カレンダーの title / CSV の description）で束ねる", () => {
    const byTitle = [56, 49, 42, 35, 28].map((d) => scheduleAt(d, "経営会議"));
    expect(runScan(byTitle, baselines).some((c) => c.description.includes("経営会議"))).toBe(true);

    const byDescription = [112, 98, 80, 55, 20].map((d) =>
      makeEvent({
        event_type: "transaction",
        occurred_at: new Date(Date.now() - d * 86400000).toISOString(),
        metrics: { description: "ｶ)ﾃｽﾄ ﾌﾘｺﾐ" },
      }),
    );
    expect(
      runScan(byDescription, baselines).some((c) => c.description.includes("ｶ)ﾃｽﾄ")),
    ).toBe(true);
  });

  it("別々の系列は混ざらない", () => {
    const mixed = [
      ...[56, 49, 42, 35, 28].map((d) => scheduleAt(d, "止まった定例")),
      ...[28, 21, 14, 7, 1].map((d) => scheduleAt(d, "続いている定例")),
    ];
    const silence = runScan(mixed, baselines).filter((c) => c.scanType === "silence");
    expect(silence).toHaveLength(1);
    expect(silence[0].description).toContain("止まった定例");
  });
});
