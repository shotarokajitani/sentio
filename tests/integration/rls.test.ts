import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";

// Supabase ローカルインスタンスが必要（supabase start）
const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const mode = resolveRlsRunMode({
  ci: Boolean(process.env.CI),
  anonKey: ANON_KEY,
  serviceKey: SERVICE_KEY,
});

if (mode === "skip") {
  // 静かなskipにしない。何が実行されなかったかを必ず出力する。
  // vitest は収集時の console を握りつぶすため stderr へ直接書く
  process.stderr.write(
    "\n[rls.test] SKIP: SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定のため " +
      "RLS越境検証は未実行（ローカル環境）。CIでは env が注入され必ず実行される。\n\n",
  );
}

// CIで env が欠落していた場合、skipではなく失敗させる（fail-open防止）
if (mode === "fail") {
  describe("F2: RLS enforcement — 実行環境ガード", () => {
    it("CIではSUPABASE_*が注入されていること", () => {
      throw new Error(
        "CI環境で SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
          "RLS検証がskipされる状態は fail-open のため失敗として扱う。" +
          "ci.yml の integration ジョブで supabase start と env 注入を確認すること。",
      );
    });
  });
}

if (mode === "skip") {
  // describe.skipIf / runIf は本体を収集し beforeAll も走らせるため、
  // 実行しない場合はスイート自体を登録しない
  describe.skip("F2: RLS enforcement（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "run") {
  describe("F2: RLS enforcement（実クエリによる越境検証）", () => {
    // describe の本体は runIf の結果に関わらず収集時に評価されるため、
    // クライアント生成は beforeAll まで遅らせる（鍵が空だと createClient が例外を投げる）
    let admin: SupabaseClient;

    type Tenant = { id: string; email: string; client: SupabaseClient };

    const RUN_ID = `rls${Date.now().toString(36)}`;
    const eventId = (label: string) => `${RUN_ID}_${label}`;

    let tenantA: Tenant;
    let tenantB: Tenant;
    const createdUserIds: string[] = [];

    /** テナント用ユーザーを作り、サインイン済みクライアントを返す */
    async function makeTenant(label: string): Promise<Tenant> {
      const email = `${RUN_ID}-${label}@example.test`;
      const password = `Rls!${RUN_ID}${label}9x`;

      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`createUser(${label}) 失敗: ${error?.message}`);
      createdUserIds.push(data.user.id);

      const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const { error: signInError } = await client.auth.signInWithPassword({ email, password });
      if (signInError) throw new Error(`signIn(${label}) 失敗: ${signInError.message}`);

      // ポリシーが company_id = auth.uid() のため、company_id はユーザーIDそのもの
      return { id: data.user.id, email, client };
    }

    /** events の必須列を埋めた1行を組む */
    function eventRow(companyId: string | null, label: string) {
      return {
        event_id: eventId(label),
        company_id: companyId,
        occurred_at: new Date().toISOString(),
        source: "rls-test",
        event_type: "transaction" as const,
        sensitivity: "S1" as const,
      };
    }

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      tenantA = await makeTenant("a");
      tenantB = await makeTenant("b");

      // service_role はRLSをバイパスするので、前提データはadminで置く
      const { error } = await admin
        .from("events")
        .insert([
          eventRow(tenantA.id, "a_own"),
          eventRow(tenantA.id, "a_update"),
          eventRow(tenantA.id, "a_delete"),
          eventRow(tenantB.id, "b_own"),
          eventRow(tenantB.id, "b_update"),
          eventRow(tenantB.id, "b_delete"),
          eventRow(null, "shared_s0"),
        ]);
      if (error) throw new Error(`前提データ投入に失敗: ${error.message}`);
    });

    afterAll(async () => {
      await admin.from("events").delete().like("event_id", `${RUN_ID}_%`);
      await admin.from("known_explanations").delete().eq("source", `rls-test-${RUN_ID}`);
      for (const id of createdUserIds) {
        await admin.auth.admin.deleteUser(id);
      }
    });

    // ---------- 陽性: 自社データは操作できる ----------

    it("陽性: 自社の行をSELECTできる", async () => {
      const { data, error } = await tenantA.client
        .from("events")
        .select("event_id")
        .eq("event_id", eventId("a_own"));

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("陽性: 自社スコープでINSERTできる", async () => {
      const { error } = await tenantA.client
        .from("events")
        .insert(eventRow(tenantA.id, "a_insert"));
      expect(error).toBeNull();

      const { data } = await admin
        .from("events")
        .select("company_id")
        .eq("event_id", eventId("a_insert"));
      expect(data?.[0]?.company_id).toBe(tenantA.id);
    });

    it("陽性: 自社の行をUPDATEできる", async () => {
      const { error } = await tenantA.client
        .from("events")
        .update({ source: "rls-test-updated" })
        .eq("event_id", eventId("a_update"));
      expect(error).toBeNull();

      const { data } = await admin
        .from("events")
        .select("source")
        .eq("event_id", eventId("a_update"));
      expect(data?.[0]?.source).toBe("rls-test-updated");
    });

    it("陽性: 自社の行をDELETEできる", async () => {
      const { error } = await tenantA.client
        .from("events")
        .delete()
        .eq("event_id", eventId("a_delete"));
      expect(error).toBeNull();

      const { data } = await admin
        .from("events")
        .select("event_id")
        .eq("event_id", eventId("a_delete"));
      expect(data).toHaveLength(0);
    });

    it("陽性: NULLスコープ（S0共有）行は読める — 設計意図の維持", async () => {
      const { data, error } = await tenantA.client
        .from("events")
        .select("event_id")
        .eq("event_id", eventId("shared_s0"));

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    // ---------- 陰性: 他社データは操作できない ----------

    it("陰性: 他社の行はSELECTで見えない", async () => {
      const { data, error } = await tenantA.client
        .from("events")
        .select("event_id")
        .eq("event_id", eventId("b_own"));

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("陰性: 他社company_idでのINSERTは拒否される", async () => {
      const { error } = await tenantA.client
        .from("events")
        .insert(eventRow(tenantB.id, "cross_insert"));

      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501"); // insufficient_privilege / RLS violation

      const { data } = await admin
        .from("events")
        .select("event_id")
        .eq("event_id", eventId("cross_insert"));
      expect(data).toHaveLength(0);
    });

    it("陰性: 他社の行はUPDATEできない（0件更新かつ実データが不変）", async () => {
      const { data: updated, error } = await tenantA.client
        .from("events")
        .update({ source: "hijacked" })
        .eq("event_id", eventId("b_update"))
        .select();

      expect(error).toBeNull();
      expect(updated).toHaveLength(0); // RLSで対象行が見えないため0件

      // 0件返却を「成功」と読み違えないよう、実データ側でも不変を確認する
      const { data } = await admin
        .from("events")
        .select("source")
        .eq("event_id", eventId("b_update"));
      expect(data?.[0]?.source).toBe("rls-test");
    });

    it("陰性: 他社の行はDELETEできない（0件削除かつ行が残存）", async () => {
      const { data: deleted, error } = await tenantA.client
        .from("events")
        .delete()
        .eq("event_id", eventId("b_delete"))
        .select();

      expect(error).toBeNull();
      expect(deleted).toHaveLength(0);

      const { data } = await admin
        .from("events")
        .select("event_id")
        .eq("event_id", eventId("b_delete"));
      expect(data).toHaveLength(1);
    });

    it("陰性: 自社行のcompany_idを他社IDへ書き換えられない（WITH CHECK）", async () => {
      const { error } = await tenantA.client
        .from("events")
        .update({ company_id: tenantB.id })
        .eq("event_id", eventId("a_own"));

      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");

      const { data } = await admin
        .from("events")
        .select("company_id")
        .eq("event_id", eventId("a_own"));
      expect(data?.[0]?.company_id).toBe(tenantA.id);
    });

    // ---------- 陰性: NULLスコープへの書き込み（00019 が塞いだ穴） ----------

    it("陰性: events に company_id=NULL でINSERTできない", async () => {
      const { error } = await tenantA.client.from("events").insert(eventRow(null, "null_insert"));

      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");

      const { data } = await admin
        .from("events")
        .select("event_id")
        .eq("event_id", eventId("null_insert"));
      expect(data).toHaveLength(0);
    });

    it("陰性: known_explanations に company_id=NULL でINSERTできない", async () => {
      const { error } = await tenantA.client.from("known_explanations").insert({
        company_id: null,
        kind: "holiday",
        period: "2026-08",
        source: `rls-test-${RUN_ID}`,
      });

      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
    });

    it("陰性: NULLスコープ行をUPDATEできない（読めても書けない）", async () => {
      const { data: updated, error } = await tenantA.client
        .from("events")
        .update({ source: "hijacked-s0" })
        .eq("event_id", eventId("shared_s0"))
        .select();

      expect(error).toBeNull();
      expect(updated).toHaveLength(0);

      const { data } = await admin
        .from("events")
        .select("source")
        .eq("event_id", eventId("shared_s0"));
      expect(data?.[0]?.source).toBe("rls-test");
    });

    // ---------- 陰性: 未認証 ----------

    it("陰性: 未認証(anon)は自社スコープの行を読めない", async () => {
      const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const { data, error } = await anon
        .from("events")
        .select("event_id")
        .eq("event_id", eventId("a_own"));

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("陰性: 未認証(anon)はINSERTできない", async () => {
      const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const { error } = await anon.from("events").insert(eventRow(null, "anon_insert"));

      expect(error).not.toBeNull();
    });
  });
}
