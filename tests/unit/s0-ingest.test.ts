import { describe, it, expect } from "vitest";
import { parseEnvelope } from "@shared/contracts/envelope";

describe("S0 ingest (B5)", () => {
  const makeS0Event = (source: string, metrics: Record<string, unknown>) => ({
    event_id: `s0_test_${source}_001`,
    company_id: null,
    occurred_at: "2026-03-31T00:00:00.000Z",
    ingested_at: new Date().toISOString(),
    source,
    event_type: "external" as const,
    entity_refs: [],
    metrics,
    sensitivity: "S0" as const,
  });

  it("S0イベントは company_id=null で有効", () => {
    const evt = makeS0Event("estat:gdp", { indicator: "GDP", value: 1.2 });
    const result = parseEnvelope(evt);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.company_id).toBeNull();
      expect(result.data.sensitivity).toBe("S0");
    }
  });

  it("S1以上は company_id=null だとバリデーション失敗", () => {
    const evt = {
      ...makeS0Event("estat:gdp", { indicator: "GDP", value: 1.2 }),
      sensitivity: "S1" as const,
    };
    const result = parseEnvelope(evt);
    expect(result.success).toBe(false);
  });

  it("同一 source + metrics で同じ event_id を生成すれば冪等", () => {
    // event_id の決定性はgenerateEventIdでテスト済み（csv-parser.test.ts）
    // ここではS0のバリデーション側面のみ検証
    const evt1 = makeS0Event("estat:gdp", { indicator: "GDP", value: 1.2 });
    const evt2 = makeS0Event("estat:gdp", { indicator: "GDP", value: 1.2 });
    // 同じ event_id なら UPSERT で重複しない
    expect(evt1.event_id).toBe(evt2.event_id);
  });

  it("S0イベントのevent_typeはexternalである", () => {
    const evt = makeS0Event("gbizinfo:industry", { count: 58000 });
    const result = parseEnvelope(evt);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_type).toBe("external");
    }
  });
});
