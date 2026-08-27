/**
 * D-1-3 / D-1-4: 画面からの解除が実際に何を消すかを、実DBで確かめる。
 *
 * **本物の `POST /api/connections/disconnect` を走らせている。** `getAuthedContext` だけを
 * 差し替え、RLS が効くテナントのクライアントを渡す。ルートの中身（件数の門・
 * `sourcesForProvider` の絞り込み・トークン破棄の順序）はそのまま走る。
 * 削除の条件をテスト側に書き写すと、**書き写したほうを検証してしまう**ので写さない。
 *
 * 陰性コントロール（D-1-4）が主眼である。解除は「消える」ことより
 * **「消えてはいけないものが残る」**ほうが壊れやすい。
 * 同じ会社の別 provider と、他社の同じ provider の両方を置いて、どちらも減らないことを見る。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

// セッションから company_id を取る本番の経路だけを差し替える。
// company_id をリクエストから受け取る形にはしない（既存 API の前提を崩さない）
const authState: { ctx: unknown } = { ctx: null };
vi.mock("@/lib/auth/company", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/company")>("@/lib/auth/company");
  return { ...actual, getAuthedContext: async () => authState.ctx };
});

if (mode === "skip") {
  process.stderr.write(
    "\n[disconnect-api.test] SKIP: SUPABASE_* が未設定のため未実行（ローカル環境）。" +
      "CI では env が注入され必ず実行される。\n\n",
  );
  describe.skip("D-1: disconnect API の削除範囲（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "fail") {
  describe("D-1: disconnect API の削除範囲 — 実行環境ガード", () => {
    it("CIではSUPABASE_*が注入されていること", () => {
      throw new Error(
        "CI環境で SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
          "削除範囲の検証がskipされる状態は fail-open のため失敗として扱う。",
      );
    });
  });
}

if (mode === "run") {
  describe("D-1: disconnect API が消すものと、消さないもの", () => {
    let admin: SupabaseClient;
    let tenantA: Tenant;
    let tenantB: Tenant;
    let vaultId: string;
    let post: (body: unknown) => Promise<Response>;

    const RUN_ID = `dc${Date.now().toString(36)}`;

    function eventRow(companyId: string, label: string, source: string) {
      return {
        event_id: `${RUN_ID}_${label}`,
        company_id: companyId,
        occurred_at: new Date().toISOString(),
        source,
        event_type: source === "google_calendar" ? ("schedule" as const) : ("transaction" as const),
        sensitivity: "S1" as const,
      };
    }

    async function countEvents(companyId: string, source: string): Promise<number | null> {
      const { count, error } = await admin
        .from("events")
        .select("event_id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("source", source)
        .like("event_id", `${RUN_ID}_%`);
      if (error) throw new Error(`count 失敗 (${source}): ${error.message}`);
      return count;
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

      // 破棄されることを実物で見るため、本物の Vault シークレットを置く。
      // 中身は検証に使わない任意の文字列で足りる（秘密そのものは置かない）
      const { data: storedId, error: storeErr } = await admin.rpc("store_vault_secret", {
        p_name: `disconnect-test:${RUN_ID}`,
        p_secret: JSON.stringify({ marker: RUN_ID }),
        p_description: "slice-D disconnect integration",
      });
      if (storeErr || !storedId) throw new Error(`store_vault_secret 失敗: ${storeErr?.message}`);
      vaultId = storedId as string;

      const { error: connErr } = await admin.from("connections").insert([
        {
          company_id: tenantA.id,
          provider: "google_calendar",
          status: "active",
          vault_secret_id: vaultId,
        },
        { company_id: tenantA.id, provider: "freee", status: "active" },
        { company_id: tenantB.id, provider: "google_calendar", status: "active" },
      ]);
      if (connErr) throw new Error(`connections 投入に失敗: ${connErr.message}`);

      const { error: evErr } = await admin
        .from("events")
        .insert([
          eventRow(tenantA.id, "a_gc1", "google_calendar"),
          eventRow(tenantA.id, "a_gc2", "google_calendar"),
          eventRow(tenantA.id, "a_freee1", "freee"),
          eventRow(tenantA.id, "a_csv1", "csv:accounting"),
          eventRow(tenantB.id, "b_gc1", "google_calendar"),
        ]);
      if (evErr) throw new Error(`events 投入に失敗: ${evErr.message}`);

      authState.ctx = {
        companyId: tenantA.id,
        email: tenantA.email,
        supabase: tenantA.client,
      };

      const route = await import("@/app/api/connections/disconnect/route");
      post = (body: unknown) =>
        route.POST(
          new Request("http://localhost/api/connections/disconnect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
    });

    afterAll(async () => {
      await admin.from("events").delete().like("event_id", `${RUN_ID}_%`);
      for (const t of [tenantA, tenantB]) {
        if (!t) continue;
        await admin.from("connections").delete().eq("company_id", t.id);
        await admin.auth.admin.deleteUser(t.id);
      }
      if (vaultId) await admin.rpc("delete_vault_secret", { p_id: vaultId });
    });

    it("D-1-3 陽性: 解除で connections 行が消え、当該 provider の events が0件になる", async () => {
      expect(await countEvents(tenantA.id, "google_calendar")).toBe(2);

      const res = await post({ provider: "google_calendar" });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.eventsDeleted).toBe(2);
      // §6「トークンを直ちに破棄」。Vault に本物の秘密を置いてあったので true になる
      expect(body.tokenDestroyed).toBe(true);

      expect(await countEvents(tenantA.id, "google_calendar")).toBe(0);

      const { data: conn } = await admin
        .from("connections")
        .select("provider")
        .eq("company_id", tenantA.id)
        .eq("provider", "google_calendar");
      expect(conn).toEqual([]);

      // 参照を消しただけでなく、Vault の実体が消えていること
      const { data: secret } = await admin.rpc("read_vault_secret", { p_id: vaultId });
      expect(secret).toBeNull();
    });

    it("D-1-4 陰性: 同じ会社の別 provider の events が1件も減らない", async () => {
      expect(await countEvents(tenantA.id, "freee")).toBe(1);
      expect(await countEvents(tenantA.id, "csv:accounting")).toBe(1);

      const { data: freeeConn } = await admin
        .from("connections")
        .select("provider")
        .eq("company_id", tenantA.id)
        .eq("provider", "freee");
      expect(freeeConn).toHaveLength(1);
    });

    it("D-1-4 陰性: 他社の同じ provider の events が1件も減らない", async () => {
      expect(await countEvents(tenantB.id, "google_calendar")).toBe(1);

      const { data: conn } = await admin
        .from("connections")
        .select("provider")
        .eq("company_id", tenantB.id)
        .eq("provider", "google_calendar");
      expect(conn).toHaveLength(1);
    });

    it("陰性: 知らない provider は 400 で弾かれ、1行も消えない", async () => {
      const before = await countEvents(tenantA.id, "freee");

      const res = await post({ provider: "unknown_provider" });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("unknown_provider");
      expect(await countEvents(tenantA.id, "freee")).toBe(before);
    });

    it("陰性: 既に解除済みの provider は 404。二重押しで別の何かを消さない", async () => {
      const res = await post({ provider: "google_calendar" });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("not_connected");
      expect(await countEvents(tenantA.id, "freee")).toBe(1);
      expect(await countEvents(tenantB.id, "google_calendar")).toBe(1);
    });
  });
}
