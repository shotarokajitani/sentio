/**
 * 同じ明細をマイナス記号（U+2212）と全角ハイフン（U+FF0D）で取り込んでも行が増えない
 * （2026-09-13 の点検・PR-3 の 22b）。
 *
 * ## 何が起きたか
 *
 * Shift_JIS の 0x817C は、iconv の SHIFT_JIS では U+2212、ブラウザの TextDecoder（CP932）では
 * U+FF0D になる。2026-09-13 に検収側が同じ8月分の CSV を再送信したところ、**19行が新規になった。**
 * 摘要の正規化が U+FF0D だけを '-' に寄せ、U+2212 を寄せていなかった。
 *
 * ## 何を差し替えて、何を差し替えないか
 *
 * **差し替えるのはセッション（`getAuthedContext`）だけ。** 取り込みの route・鍵の組み立て・
 * 回数制限・DB への upsert は本物を通す。見分けにくい文字はソースに直接書かず、
 * コードポイントで作る。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";

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

const MINUS = String.fromCharCode(0x2212);
const FULLWIDTH_HYPHEN = String.fromCharCode(0xff0d);

if (mode === "skip") {
  process.stderr.write(
    "\n[csv-hyphen.test] SKIP: SUPABASE_* が未設定のため未実行（ローカル環境）。" +
      "CI では env が注入され必ず実行される。\n\n",
  );
  describe.skip("PR-3 22b: ハイフン類の取り込み（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "fail") {
  describe("PR-3 22b: ハイフン類の取り込み — 実行環境ガード", () => {
    it("CIではSUPABASE_*が注入されていること", () => {
      throw new Error(
        "CI環境で SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
          "取り込みの検証がskipされる状態は fail-open のため失敗として扱う。",
      );
    });
  });
}

if (mode === "run") {
  describe("PR-3 22b: 同じ明細を U+2212 と U+FF0D で取り込んでも行が増えない（実DB・本物の route）", () => {
    let admin: SupabaseClient;
    const COMPANY_ID = crypto.randomUUID();

    /** 同じ3行の明細。摘要のハイフンだけを差し替える */
    function csv(hyphen: string): string {
      return [
        "日付,摘要,入金金額,出金金額,残高",
        `2026/08/01,ｶ)ﾄﾘﾋｷ${hyphen}ｻｷ,,3300,120000`,
        `2026/08/02,ﾌﾘｺﾐ ﾃｽﾀ${hyphen}ﾕｳｹﾞﾝ,50000,,170000`,
        "2026/08/03,ﾃﾞﾝｷﾀﾞｲ,,8800,161200",
      ].join("\n");
    }

    async function ingest(text: string) {
      const { POST } = await import("@/app/api/csv/ingest/route");
      const res = await POST(
        new NextRequest("http://localhost/api/csv/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            csv_text: text,
            file_name: "hyphen.csv",
            mapping: {
              date: "日付",
              description: "摘要",
              amount: null,
              direction: null,
              credit: "入金金額",
              debit: "出金金額",
              balance: "残高",
            },
          }),
        }),
      );
      return { status: res.status, body: await res.json() };
    }

    async function rowCount(): Promise<number> {
      const { count, error } = await admin
        .from("events")
        .select("event_id", { count: "exact", head: true })
        .eq("company_id", COMPANY_ID)
        .eq("source", "csv:accounting");
      if (error) throw new Error(`件数の照会に失敗: ${error.message}`);
      return count ?? -1;
    }

    beforeAll(() => {
      admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      authState.ctx = { companyId: COMPANY_ID, email: null, siteUrl: null, supabase: null };
    });

    afterAll(async () => {
      if (!admin) return;
      await admin.from("events").delete().eq("company_id", COMPANY_ID);
      await admin.from("api_rate_limits").delete().eq("subject", `company:${COMPANY_ID}`);
    });

    it("1回目: ブラウザの読み方（U+FF0D）で3行入る（陽性）", async () => {
      const first = await ingest(csv(FULLWIDTH_HYPHEN));
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.count).toBe(3);
      expect(await rowCount()).toBe(3);
    });

    it("**陰性**: 2回目に iconv の読み方（U+2212）で同じ明細を入れても、行は3のまま", async () => {
      const second = await ingest(csv(MINUS));
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.count).toBe(3);
      expect(await rowCount()).toBe(3);
    });
  });
}
