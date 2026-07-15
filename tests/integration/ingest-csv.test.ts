import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * CSV投入の統合テスト (B1-B3 DB往復)
 * Supabase ローカルインスタンスが必要（supabase start）
 */
const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const canRun = !!SUPABASE_SERVICE_KEY;

describe.skipIf(!canRun)("CSV投入の統合テスト (B1-B3)", () => {
  let admin: SupabaseClient;
  const companyId = "00000000-0000-0000-0000-000000000099";
  const fingerprint = "sha256:integration_test";

  const sampleCsv = `date,description,amount,tax
2026-06-01,売上A,100000,10000
2026-06-02,仕入B,-50000,-5000`;

  beforeAll(() => {
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  });

  afterAll(async () => {
    // テストデータのクリーンアップ
    if (canRun) {
      await admin
        .from("events")
        .delete()
        .eq("company_id", companyId);
    }
  });

  /**
   * ヘルパー: CSV→エンベロープをDBにUPSERT
   * Edge Functionを呼ばず直接DBに挿入（Edge Functionの起動不要）
   */
  async function ingestCsvDirect(csvText: string) {
    const { parseCsvToEnvelopes } = await import("@/ingest/csv-parser");
    const envelopes = parseCsvToEnvelopes(csvText, fingerprint, companyId);

    const { error } = await admin
      .from("events")
      .upsert(
        envelopes.map((e) => ({
          ...e,
          entity_refs: e.entity_refs ?? [],
        })),
        { onConflict: "event_id" },
      );

    if (error) throw new Error(`UPSERT failed: ${error.message}`);
    return envelopes;
  }

  it("B1: CSV投入後にtransactionイベントがタイムラインに存在、金額合計がCSV一致", async () => {
    const envelopes = await ingestCsvDirect(sampleCsv);

    const { data, error } = await admin
      .from("events")
      .select("*")
      .eq("company_id", companyId)
      .eq("event_type", "transaction");

    expect(error).toBeNull();
    expect(data).toHaveLength(envelopes.length);

    const totalAmount = data!.reduce(
      (sum: number, row: { metrics: { amount: number } }) =>
        sum + row.metrics.amount,
      0,
    );
    // 100000 + (-50000) = 50000
    expect(totalAmount).toBe(50000);
  });

  it("B2: 同一CSV再投入で件数が増えない（UPSERT冪等）", async () => {
    // 2回目の投入
    await ingestCsvDirect(sampleCsv);

    const { data, error } = await admin
      .from("events")
      .select("event_id")
      .eq("company_id", companyId)
      .eq("event_type", "transaction");

    expect(error).toBeNull();
    // 1回目と同じ2件のまま
    expect(data).toHaveLength(2);
  });

  it("B3: 修正CSV再投入は差分行のみ新イベント", async () => {
    const modifiedCsv = sampleCsv.replace("100000", "120000");
    await ingestCsvDirect(modifiedCsv);

    const { data, error } = await admin
      .from("events")
      .select("event_id, metrics")
      .eq("company_id", companyId)
      .eq("event_type", "transaction");

    expect(error).toBeNull();
    // 元の2件 + 修正1行（新event_id）= 3件
    // 2行目は同じevent_idなのでUPSERTで上書き = 増えない
    expect(data).toHaveLength(3);

    // 修正行（120000）が含まれていることを確認
    const hasModified = data!.some(
      (row: { metrics: { amount: number } }) => row.metrics.amount === 120000,
    );
    expect(hasModified).toBe(true);
  });
});
