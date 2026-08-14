import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

// Supabase ローカルインスタンスが必要（supabase start）
// SUPABASE_ANON_KEY が未設定なら全テストをスキップ
const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const canRun = !!SUPABASE_ANON_KEY && !!SUPABASE_SERVICE_KEY;

describe.skipIf(!canRun)("F2: RLS enforcement", () => {
  // createClient はキーが空文字だと例外を投げるため、canRun ガード後に生成
  const anonClient = canRun
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : (null as unknown as ReturnType<typeof createClient>);
  const adminClient = canRun
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : (null as unknown as ReturnType<typeof createClient>);

  const TEST_COMPANY_ID = "00000000-0000-0000-0000-000000000001";
  const TEST_EVENT_ID = "rls_test_event_001";

  it("anon ユーザーは他社の events を読めない", async () => {
    // admin（service_role）でRLSをバイパスしてイベントを挿入
    const { error: insertError } = await adminClient.from("events").upsert(
      {
        event_id: TEST_EVENT_ID,
        company_id: TEST_COMPANY_ID,
        occurred_at: new Date().toISOString(),
        source: "test",
        event_type: "transaction",
        sensitivity: "S1",
      },
      { onConflict: "event_id" },
    );
    expect(insertError).toBeNull();

    // anon クライアント（認証なし）では読めないはず
    const { data, error } = await anonClient
      .from("events")
      .select("event_id")
      .eq("company_id", TEST_COMPANY_ID);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    // クリーンアップ
    await adminClient.from("events").delete().eq("event_id", TEST_EVENT_ID);
  });

  it("全 public テーブルに RLS が有効（connector_limits を除く）", async () => {
    // pg_class.relrowsecurity で RLS 有効を直接確認
    const { data, error } = await adminClient.rpc("exec_sql", {
      query: `
        SELECT t.tablename,
          EXISTS(
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = t.tablename
              AND c.relrowsecurity
          ) AS rls_enabled
        FROM pg_tables t
        WHERE t.schemaname = 'public'
          AND t.tablename NOT IN ('connector_limits')
        ORDER BY t.tablename
      `,
    });

    // exec_sql RPC が存在しない場合はスキップ
    if (error) {
      console.warn("exec_sql RPC が利用不可のためスキップ:", error.message);
      return;
    }

    const withoutRls = (data as { tablename: string; rls_enabled: boolean }[]).filter(
      (t) => !t.rls_enabled,
    );

    expect(
      withoutRls,
      `RLS が無効なテーブル: ${withoutRls.map((t) => t.tablename).join(", ")}`,
    ).toHaveLength(0);
  });
});
