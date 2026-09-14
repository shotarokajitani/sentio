/**
 * freee の再連携で connect_failed にならない（2026-09-13 の点検・PR-3 の 19）。
 *
 * ## 何が起きていたか
 *
 * `src/app/auth/callback/freee/route.ts` は、連携のたびに `store_vault_secret` を
 * **固定名 `freee:<company_id>`** で呼んでいた。`vault.secrets.name` には一意制約があるので、
 * **2回目の連携から duplicate key で失敗し、`/connect?e=connect_failed` に戻っていた。**
 *
 * ## 何を差し替えて、何を差し替えないか
 *
 * **差し替えるのは、セッション（`getAuthedContext`）と freee への HTTP だけ。**
 * callback の route、Vault の RPC、connections の upsert は本物を通す。
 * freee の API は CI から叩けないので、トークン交換と `/users/me` だけを返す偽の fetch を置く
 * （`/users/me` が会社を返さないので、取引の同期は0件で終わる）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";
import { oauthStateCookieName } from "@/lib/auth/oauth-state";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const mode = resolveRlsRunMode({
  ci: Boolean(process.env.CI),
  anonKey: ANON_KEY,
  serviceKey: SERVICE_KEY,
});

const authState: { ctx: unknown } = { ctx: null };
vi.mock("@/lib/auth/company", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/company")>("@/lib/auth/company");
  return { ...actual, getAuthedContext: async () => authState.ctx };
});

if (mode === "skip") {
  process.stderr.write(
    "\n[freee-relink.test] SKIP: SUPABASE_* が未設定のため未実行（ローカル環境）。" +
      "CI では env が注入され必ず実行される。\n\n",
  );
  describe.skip("PR-3 19: freee の再連携（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "fail") {
  describe("PR-3 19: freee の再連携 — 実行環境ガード", () => {
    it("CIではSUPABASE_*が注入されていること", () => {
      throw new Error(
        "CI環境で SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
          "再連携の検証がskipされる状態は fail-open のため失敗として扱う。",
      );
    });
  });
}

if (mode === "run") {
  describe("PR-3 19: freee を同じ会社で2回連携しても壊れない（実DB・本物の route）", () => {
    let admin: SupabaseClient;
    const COMPANY_ID = crypto.randomUUID();
    const STATE = `st-${crypto.randomUUID()}`;
    const realFetch = globalThis.fetch;
    let currentAccessToken = "";

    /** freee への HTTP だけを差し替える。**Supabase への HTTP は本物に流す** */
    function stubFreee() {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("https://accounts.secure.freee.co.jp/")) {
          return new Response(
            JSON.stringify({
              access_token: currentAccessToken,
              refresh_token: `${currentAccessToken}-refresh`,
              expires_in: 21600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.startsWith("https://api.freee.co.jp/")) {
          // 会社を返さない → 取引の同期は0件で終わる
          return new Response(JSON.stringify({ user: { companies: [] } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(input, init);
      }) as typeof fetch;
    }

    async function connectOnce(accessToken: string): Promise<Response> {
      currentAccessToken = accessToken;
      const { GET } = await import("@/app/auth/callback/freee/route");
      return GET(
        new NextRequest(
          `http://localhost/auth/callback/freee?code=c-${accessToken}&state=${STATE}`,
          {
            headers: { cookie: `${oauthStateCookieName("freee")}=${STATE}` },
          },
        ),
      );
    }

    async function connection() {
      const { data, error } = await admin
        .from("connections")
        .select("vault_secret_id, status")
        .eq("company_id", COMPANY_ID)
        .eq("provider", "freee");
      if (error) throw new Error(`connections 照会失敗: ${error.message}`);
      return data ?? [];
    }

    async function readSecret(id: string): Promise<string | null> {
      const { data, error } = await admin.rpc("read_vault_secret", { p_id: id });
      if (error) throw new Error(`read_vault_secret 失敗: ${error.message}`);
      return data as string | null;
    }

    beforeAll(() => {
      admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      authState.ctx = { companyId: COMPANY_ID, email: null, siteUrl: null, supabase: null };
      vi.stubEnv("FREEE_CLIENT_ID", "integration-placeholder");
      vi.stubEnv("FREEE_CLIENT_SECRET", "integration-placeholder");
      stubFreee();
    });

    afterAll(async () => {
      globalThis.fetch = realFetch;
      vi.unstubAllEnvs();
      if (!admin) return;
      for (const row of await connection()) {
        if (row.vault_secret_id)
          await admin.rpc("delete_vault_secret", { p_id: row.vault_secret_id });
      }
      await admin.from("connections").delete().eq("company_id", COMPANY_ID);
    });

    it("1回目: 連携でき、Vault に secret が作られる（陽性）", async () => {
      const res = await connectOnce("token-first");

      expect(res.headers.get("location")).toBe("http://localhost/connect?freee_synced=0");

      const rows = await connection();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("active");
      const secret = await readSecret(rows[0].vault_secret_id as string);
      expect(JSON.parse(secret ?? "{}").access_token).toBe("token-first");
    });

    it("**陰性**: 2回目も connect_failed にならず、同じ secret の中身が新しいトークンに変わる（古い secret を残さない）", async () => {
      const before = (await connection())[0].vault_secret_id as string;

      const res = await connectOnce("token-second");

      expect(res.headers.get("location")).not.toContain("connect_failed");
      expect(res.headers.get("location")).toBe("http://localhost/connect?freee_synced=0");

      const rows = await connection();
      expect(rows).toHaveLength(1);
      // **新しい secret を作らず、既存の secret を更新している**
      expect(rows[0].vault_secret_id).toBe(before);
      const secret = await readSecret(before);
      expect(JSON.parse(secret ?? "{}").access_token).toBe("token-second");
    });

    it("3回目も同じ（再連携を繰り返しても壊れない）", async () => {
      const before = (await connection())[0].vault_secret_id as string;
      const res = await connectOnce("token-third");

      expect(res.headers.get("location")).toBe("http://localhost/connect?freee_synced=0");
      expect((await connection())[0].vault_secret_id).toBe(before);
      expect(JSON.parse((await readSecret(before)) ?? "{}").access_token).toBe("token-third");
    });
  });
}
