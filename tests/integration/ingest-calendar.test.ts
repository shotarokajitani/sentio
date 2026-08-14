import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * カレンダーフィクスチャ注入の統合テスト (B4)
 * Supabase ローカルインスタンスが必要（supabase start）
 */
const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const canRun = !!SUPABASE_SERVICE_KEY;

/**
 * 過去12ヶ月のカレンダーフィクスチャを生成
 */
function generateCalendarFixtures(companyId: string) {
  const now = new Date();
  const events = [];

  for (let monthsAgo = 0; monthsAgo < 12; monthsAgo++) {
    const date = new Date(now);
    date.setMonth(date.getMonth() - monthsAgo);
    date.setDate(15); // 各月15日

    const start = new Date(date);
    start.setHours(10, 0, 0, 0);
    const end = new Date(date);
    end.setHours(11, 0, 0, 0);

    events.push({
      title: `月次定例会議 ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
      start: start.toISOString(),
      end: end.toISOString(),
      attendees: ["member-a", "member-b"],
    });
  }

  return events;
}

describe.skipIf(!canRun)("カレンダーフィクスチャ注入 (B4)", () => {
  let admin: SupabaseClient;
  const companyId = "00000000-0000-0000-0000-000000000098";

  beforeAll(() => {
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  });

  afterAll(async () => {
    if (canRun) {
      await admin.from("events").delete().eq("company_id", companyId);
    }
  });

  /**
   * ヘルパー: カレンダーフィクスチャをDBに直接UPSERT
   */
  async function ingestCalendarDirect(fixtures: ReturnType<typeof generateCalendarFixtures>) {
    // Deno Edge Function と同等のロジックをNode側で再現
    const { createHash } = await import("crypto");

    const now = new Date().toISOString();
    const rows = fixtures.map((evt) => {
      const fingerprint = `calendar:${companyId}`;
      const rowContent = `${evt.title}:${evt.start}:${evt.end}`;
      const eventId = createHash("sha256").update(`${fingerprint}:${rowContent}`).digest("hex");

      return {
        event_id: eventId,
        company_id: companyId,
        occurred_at: evt.start,
        period_start: evt.start,
        period_end: evt.end,
        ingested_at: now,
        source: "calendar:fixture",
        event_type: "schedule",
        entity_refs: [],
        metrics: {
          title: evt.title,
          attendees: evt.attendees,
        },
        sensitivity: "S1",
      };
    });

    const { error } = await admin.from("events").upsert(rows, { onConflict: "event_id" });

    if (error) throw new Error(`UPSERT failed: ${error.message}`);
    return rows;
  }

  it("過去12ヶ月分のscheduleイベントが存在する", async () => {
    const fixtures = generateCalendarFixtures(companyId);
    await ingestCalendarDirect(fixtures);

    const { data, error } = await admin
      .from("events")
      .select("*")
      .eq("company_id", companyId)
      .eq("event_type", "schedule");

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(12);
  });

  it("全てのoccurred_atが過去である", async () => {
    const { data, error } = await admin
      .from("events")
      .select("occurred_at")
      .eq("company_id", companyId)
      .eq("event_type", "schedule");

    expect(error).toBeNull();
    const now = new Date();
    for (const row of data!) {
      expect(new Date(row.occurred_at).getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });
});
