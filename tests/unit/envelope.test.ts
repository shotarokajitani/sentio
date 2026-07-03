import { describe, it, expect } from "vitest";
import { EventEnvelope, parseEnvelope } from "@shared/contracts/envelope";

describe("EventEnvelope contract", () => {
  const validEvent = {
    event_id: "hash_freee_txn_001",
    company_id: "550e8400-e29b-41d4-a716-446655440000",
    occurred_at: "2026-06-15T10:00:00Z",
    ingested_at: "2026-07-01T00:00:00Z",
    source: "freee:v1",
    event_type: "transaction",
    metrics: { amount: 150000, tax: 15000 },
    sensitivity: "S1",
  };

  it("有効なイベントをパースできる", () => {
    const result = parseEnvelope(validEvent);
    expect(result.success).toBe(true);
  });

  it("event_type が8分類外ならエラー", () => {
    const result = parseEnvelope({ ...validEvent, event_type: "unknown" });
    expect(result.success).toBe(false);
  });

  it("sensitivity が S0-S3 外ならエラー", () => {
    const result = parseEnvelope({ ...validEvent, sensitivity: "S4" });
    expect(result.success).toBe(false);
  });

  it("S0 は company_id = null を許容", () => {
    const result = parseEnvelope({
      ...validEvent,
      company_id: null,
      sensitivity: "S0",
    });
    expect(result.success).toBe(true);
  });

  it("S1以上は company_id 必須", () => {
    const result = parseEnvelope({
      ...validEvent,
      company_id: null,
      sensitivity: "S1",
    });
    expect(result.success).toBe(false);
  });
});
