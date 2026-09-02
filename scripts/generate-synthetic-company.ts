/**
 * Synthetic company generator: 株式会社アオバ製作所
 * Generates 12 months of deterministic event fixtures with 8 planted signals.
 * No real names, companies, keys, or contacts.
 */

// 本番の Scanner が受け取る形（`src/sense/scanner.ts` は 2026-08-31 に削除）
import type { ScanEvent } from "@edge/_shared/scan";

/** 合成会社のイベント。走査が見る形に `company_id` を足したもの */
type TimelineEvent = ScanEvent & { company_id: string | null };

export interface SyntheticCompany {
  meta: {
    name: "株式会社アオバ製作所";
    address: string;
    industry: "manufacturing";
    url: string;
    companyId: string;
  };
  events: TimelineEvent[];
  plantedSignals: PlantedSignal[];
}

export interface PlantedSignal {
  id: number;
  label: string;
  type: "positive" | "negative";
  scanType: string;
  eventIds: string[];
}

const COMPANY_ID = "a0ba0000-0000-0000-0000-000000000001";
// Use current date as base so events fall within Scanner's 90-day window
const BASE_DATE = new Date();

function deterministicId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(4, "0")}`;
}

function monthsAgo(months: number): Date {
  const d = new Date(BASE_DATE);
  d.setMonth(d.getMonth() - months);
  return d;
}

function daysAgo(days: number): Date {
  return new Date(BASE_DATE.getTime() - days * 24 * 60 * 60 * 1000);
}

export function generateSyntheticCompany(): SyntheticCompany {
  const events: TimelineEvent[] = [];
  const plantedSignals: PlantedSignal[] = [];

  // Normal transaction baseline: 12 months of revenue ~100k/month
  for (let m = 0; m < 12; m++) {
    const date = monthsAgo(11 - m);
    // Normal seasonal pattern: slight dip in Feb/Aug
    const seasonal = [98, 92, 100, 105, 108, 110, 105, 93, 100, 108, 112, 100];
    const revenue = seasonal[m] * 1000;
    const id = deterministicId("txn_normal", m);
    events.push({
      event_id: id,
      company_id: COMPANY_ID,
      occurred_at: date.toISOString(),
      source: "csv:accounting",
      event_type: "transaction",
      metrics: { revenue, amount: revenue, description: `Month ${m + 1} revenue` },
      sensitivity: "S1",
    });
  }

  // ① Order interval elongation (trend scan) — 3 months
  //
  // **2026-09-02 修正。名前と逆の形になっていた。**
  // 旧実装は `i` が増えるほど過去へ遠ざかる書き方で、時系列に並べると
  // 間隔が 50 → 35 → 25 → 18 と**縮み**、売上は 30000 → 50000 と**増えていた**。
  // すなわち「取引先が離れていく」ではなく「発注が増えて単価も上がる」という
  // **良い兆候**のデータだった（golden の記述「発注間隔が3ヶ月かけて伸長」とも食い違う）。
  //
  // 時系列（古い→新しい）で間隔が 14 → 18 → 25 → 35 と伸び、
  // 売上が 50000 → 30000 と落ちる形に組み直した。**古い順に組み立てる。**
  const signal1Ids: string[] = [];
  // 古い順の間隔（日）。末尾ほど新しい側の間隔で、単調に伸びる
  const orderGaps = [14, 18, 25, 35];
  // 直近の発注からの経過日数。中央値(21.5)の3倍(64.5)を下回るので、途絶では発火しない
  const sinceLastOrder = 20;
  const orderSpan = orderGaps.reduce((a, b) => a + b, 0); // 92
  for (let i = 0; i < 5; i++) {
    const id = deterministicId("txn_order", i);
    signal1Ids.push(id);
    // i=0 が最も古い。古い順に間隔を足していく
    const elapsed = orderGaps.slice(0, i).reduce((a, b) => a + b, 0);
    events.push({
      event_id: id,
      company_id: COMPANY_ID,
      occurred_at: daysAgo(orderSpan + sinceLastOrder - elapsed).toISOString(),
      source: "csv:accounting",
      event_type: "transaction",
      // 古いほど高く、新しいほど低い（取引が細っていく）
      metrics: { revenue: 50000 - i * 5000, order_client: "entity_customer_a" },
      sensitivity: "S1",
    });
  }
  plantedSignals.push({
    id: 1,
    label: "order_interval_elongation",
    type: "positive",
    scanType: "trend",
    eventIds: signal1Ids,
  });

  // ② Payment overdue (deadline scan) — 1 event
  const overdueId = deterministicId("txn_overdue", 0);
  events.push({
    event_id: overdueId,
    company_id: COMPANY_ID,
    occurred_at: daysAgo(10).toISOString(),
    source: "csv:accounting",
    event_type: "transaction",
    metrics: {
      expected_date: daysAgo(10).toISOString(),
      is_overdue: true,
      amount: 500000,
      description: "Invoice #2026-042 payment",
    },
    sensitivity: "S1",
  });
  plantedSignals.push({
    id: 2,
    label: "payment_overdue",
    type: "positive",
    scanType: "deadline",
    eventIds: [overdueId],
  });

  // ③ Reply delay (deviation scan via communication) — 3 weeks worsening
  const signal3Ids: string[] = [];
  for (let w = 0; w < 3; w++) {
    const id = deterministicId("comm_reply", w);
    signal3Ids.push(id);
    events.push({
      event_id: id,
      company_id: COMPANY_ID,
      occurred_at: daysAgo(21 - w * 7).toISOString(),
      source: "communication:slack",
      event_type: "communication",
      metrics: {
        reply_time_hours: 2 + w * 8, // 2h, 10h, 18h — worsening
        actor: "entity_employee_tanaka",
      },
      sensitivity: "S2",
    });
  }
  plantedSignals.push({
    id: 3,
    label: "reply_delay",
    type: "positive",
    scanType: "trend",
    eventIds: signal3Ids,
  });

  // ④ Overtime creep (trend scan via attendance) — 1 employee
  const signal4Ids: string[] = [];
  for (let w = 0; w < 6; w++) {
    const id = deterministicId("att_overtime", w);
    signal4Ids.push(id);
    events.push({
      event_id: id,
      company_id: COMPANY_ID,
      occurred_at: daysAgo(42 - w * 7).toISOString(),
      source: "attendance:kotimes",
      event_type: "attendance",
      metrics: {
        late_hours: 0.5 + w * 0.5, // 0.5, 1.0, 1.5, 2.0, 2.5, 3.0 — creeping
        actor: "entity_employee_suzuki",
      },
      sensitivity: "S2",
    });
  }
  plantedSignals.push({
    id: 4,
    label: "overtime_creep",
    type: "positive",
    scanType: "trend",
    eventIds: signal4Ids,
  });

  // ⑤ Seasonal normal decline (NEGATIVE CONTROL — must NOT detect)
  // Already covered by normal baseline seasonal[7] = 93k (Aug dip)
  plantedSignals.push({
    id: 5,
    label: "seasonal_normal",
    type: "negative",
    scanType: "none",
    eventIds: [],
  });

  // ⑥ Inquiry decline (deviation scan)
  const signal6Ids: string[] = [];
  for (let w = 0; w < 4; w++) {
    const id = deterministicId("web_inquiry", w);
    signal6Ids.push(id);
    events.push({
      event_id: id,
      company_id: COMPANY_ID,
      occurred_at: daysAgo(28 - w * 7).toISOString(),
      source: "web:form",
      event_type: "web",
      metrics: {
        inquiry_count: 10 - w * 3, // 10, 7, 4, 1 — declining
      },
      sensitivity: "S1",
    });
  }
  plantedSignals.push({
    id: 6,
    label: "inquiry_decline",
    type: "positive",
    scanType: "trend",
    eventIds: signal6Ids,
  });

  // ⑦ Meeting silence (silence scan) — regular weekly meeting disappeared
  const signal7Ids: string[] = [];
  // 8 regular meetings, then nothing for 5 weeks
  for (let w = 0; w < 8; w++) {
    const id = deterministicId("sched_meeting", w);
    signal7Ids.push(id);
    events.push({
      event_id: id,
      company_id: COMPANY_ID,
      occurred_at: daysAgo(77 - w * 7).toISOString(), // last meeting was ~35 days ago
      source: "calendar:google",
      event_type: "schedule",
      metrics: { meeting_type: "weekly_standup" },
      sensitivity: "S1",
    });
  }
  plantedSignals.push({
    id: 7,
    label: "meeting_silence",
    type: "positive",
    scanType: "silence",
    eventIds: signal7Ids,
  });

  // ⑧ Competitor hiring (external scan)
  const competitorId = deterministicId("ext_competitor", 0);
  events.push({
    event_id: competitorId,
    company_id: null,
    occurred_at: daysAgo(3).toISOString(),
    source: "gbizinfo",
    event_type: "external",
    metrics: { relevance: "competitor_hiring", competitor: "株式会社テスト競合" },
    sensitivity: "S0",
  });
  plantedSignals.push({
    id: 8,
    label: "competitor_hire",
    type: "positive",
    scanType: "external",
    eventIds: [competitorId],
  });

  return {
    meta: {
      name: "株式会社アオバ製作所",
      address: "東京都架空区テスト町1-1-1",
      industry: "manufacturing",
      url: "https://aoba-seisakusho.example.com",
      companyId: COMPANY_ID,
    },
    events,
    plantedSignals,
  };
}

// CLI execution
if (typeof process !== "undefined" && process.argv[1]?.includes("generate-synthetic-company")) {
  const company = generateSyntheticCompany();
  console.log(
    `Generated ${company.events.length} events with ${company.plantedSignals.length} planted signals`,
  );
  console.log("Positive:", company.plantedSignals.filter((s) => s.type === "positive").length);
  console.log("Negative:", company.plantedSignals.filter((s) => s.type === "negative").length);
}
