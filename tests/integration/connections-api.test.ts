import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";
import { makeTenant, type Tenant } from "../helpers/tenant";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const mode = resolveRlsRunMode({
  ci: Boolean(process.env.CI),
  anonKey: ANON_KEY,
  serviceKey: SERVICE_KEY,
});

if (mode === "skip") {
  process.stderr.write(
    "\n[connections-api.test] SKIP: SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定のため " +
      "API越境検証は未実行（ローカル環境）。CIでは env が注入され必ず実行される。\n\n",
  );
  describe.skip("A-2: /api/connections の認証保護（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "fail") {
  describe("A-2: /api/connections の認証保護 — 実行環境ガード", () => {
    it("CIではSUPABASE_*が注入されていること", () => {
      throw new Error(
        "CI環境で SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
          "越境検証がskipされる状態は fail-open のため失敗として扱う。",
      );
    });
  });
}

if (mode === "run") {
  describe("A-2: /api/connections の認証保護と越境不可", () => {
    let admin: SupabaseClient;
    let tenantA: Tenant;
    let tenantB: Tenant;

    const RUN_ID = `capi${Date.now().toString(36)}`;

    function eventRow(companyId: string, label: string) {
      return {
        event_id: `${RUN_ID}_${label}`,
        company_id: companyId,
        occurred_at: new Date().toISOString(),
        source: "google_calendar",
        event_type: "schedule" as const,
        sensitivity: "S1" as const,
      };
    }

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      tenantA = await makeTenant({
        admin,
        supabaseUrl: SUPABASE_URL,
        anonKey: ANON_KEY,
        runId: RUN_ID,
        label: "a",
      });
      tenantB = await makeTenant({
        admin,
        supabaseUrl: SUPABASE_URL,
        anonKey: ANON_KEY,
        runId: RUN_ID,
        label: "b",
      });

      const { error: connError } = await admin.from("connections").insert([
        { company_id: tenantA.id, provider: "google_calendar", status: "active" },
        { company_id: tenantB.id, provider: "google_calendar", status: "reauth_required" },
      ]);
      if (connError) throw new Error(`connections 投入に失敗: ${connError.message}`);

      const { error: evError } = await admin
        .from("events")
        .insert([
          eventRow(tenantA.id, "a1"),
          eventRow(tenantB.id, "b1"),
          eventRow(tenantB.id, "b2"),
        ]);
      if (evError) throw new Error(`events 投入に失敗: ${evError.message}`);
    });

    afterAll(async () => {
      await admin.from("events").delete().like("event_id", `${RUN_ID}_%`);
      for (const t of [tenantA, tenantB]) {
        if (!t) continue;
        await admin.from("connections").delete().eq("company_id", t.id);
        await admin.auth.admin.deleteUser(t.id);
      }
    });

    it("A-2-3 他社の connections は company_id を明示指定しても読めない", async () => {
      const { data, error } = await tenantA.client
        .from("connections")
        .select("provider, status")
        .eq("company_id", tenantB.id);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("A-2-3 他社の events は company_id を明示指定しても件数が漏れない", async () => {
      const { count, error } = await tenantA.client
        .from("events")
        .select("*", { count: "exact", head: true })
        .eq("company_id", tenantB.id)
        .eq("source", "google_calendar");

      expect(error).toBeNull();
      expect(count).toBe(0);
    });

    it("A-2-3 他社スコープの events は書き込めない", async () => {
      const { error } = await tenantA.client.from("events").insert(eventRow(tenantB.id, "a_cross"));

      expect(error).not.toBeNull();

      const { count } = await admin
        .from("events")
        .select("*", { count: "exact", head: true })
        .eq("event_id", `${RUN_ID}_a_cross`);
      expect(count).toBe(0);
    });

    it("陽性: 自社の connections と events は読める", async () => {
      const { data: conns } = await tenantA.client
        .from("connections")
        .select("provider, status")
        .eq("company_id", tenantA.id);
      expect(conns).toHaveLength(1);

      const { count } = await tenantA.client
        .from("events")
        .select("*", { count: "exact", head: true })
        .eq("company_id", tenantA.id)
        .eq("source", "google_calendar");
      expect(count).toBe(1);
    });
  });
}
