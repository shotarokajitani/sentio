/**
 * レート制限・service_role の書き込み・CAPTCHA の受け渡しを、実 DB と本物の route で確かめる
 * （2026-09-13 の点検・PR-2a）。
 *
 * ## 何を差し替えて、何を差し替えないか
 *
 * **差し替えるのは、セッション（`getAuthedContext`）と Anthropic だけ。**
 * 回数を数える `hit_rate_limit`（00049）、書き込み、Supabase Auth は本物を通す。
 * 回数の判定をテスト側に書き写すと、書き写したほうを検証してしまう。
 *
 * ## CI で3回走ることへの備え
 *
 * `ci.yml` は統合試験を3回続けて走らせる。回数は DB に残るので、
 * **会社も IP も実行ごとに新しく作る**（`RUN` を含める）。前の回の件数を拾わない。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
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

const authState: { ctx: unknown } = { ctx: null };
vi.mock("@/lib/auth/company", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/company")>("@/lib/auth/company");
  return { ...actual, getAuthedContext: async () => authState.ctx };
});

/** Anthropic を呼んだ回数。**429 の回は LLM に触れていないこと**を見る */
const llm = vi.fn(async () => ({
  content: [{ type: "text", text: '[{"name":"試験用の競合","reason":"試験"}]' }],
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: llm };
  },
}));

if (mode === "skip") {
  process.stderr.write(
    "\n[rate-limit.test] SKIP: SUPABASE_* が未設定のため未実行（ローカル環境）。" +
      "CI では env が注入され必ず実行される。\n\n",
  );
  describe.skip("PR-2a: レート制限（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "fail") {
  describe("PR-2a: レート制限 — 実行環境ガード", () => {
    it("CIではSUPABASE_*が注入されていること", () => {
      throw new Error(
        "CI環境で SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
          "レート制限の検証がskipされる状態は fail-open のため失敗として扱う。",
      );
    });
  });
}

if (mode === "run") {
  describe("PR-2a: レート制限と service_role の書き込み（実DB）", () => {
    let admin: SupabaseClient;
    let suggestTenant: Tenant;
    let ingestTenant: Tenant;
    let otherTenant: Tenant;
    const RUN = `rl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    /** 実行ごとに違う送信元。**前の回の件数を拾わない** */
    const IP = `rl-test-${RUN}`;

    function ctxOf(t: Tenant) {
      // **`supabase` は渡さない。** route が利用者のクライアントで書こうとすれば、ここで落ちる
      return { companyId: t.id, email: t.email, siteUrl: null, supabase: null };
    }

    function sessionPost(fields: Record<string, string>, ip: string) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return new NextRequest("http://localhost/api/auth/session", {
        method: "POST",
        headers: { "x-forwarded-for": ip },
        body: form,
      });
    }

    function jsonPost(path: string, body: unknown) {
      return new NextRequest(`http://localhost${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const make = (label: string) =>
        makeTenant({ admin, supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, runId: RUN, label });
      suggestTenant = await make("suggest");
      ingestTenant = await make("ingest");
      otherTenant = await make("other");
    });

    afterAll(async () => {
      if (!admin) return;
      for (const t of [suggestTenant, ingestTenant, otherTenant]) {
        if (!t) continue;
        await admin.from("events").delete().eq("company_id", t.id);
        await admin.from("entities").delete().eq("company_id", t.id);
        await admin.from("api_rate_limits").delete().eq("subject", `company:${t.id}`);
        await admin.auth.admin.deleteUser(t.id);
      }
      await admin.from("api_rate_limits").delete().like("subject", `ip:rl-test-${RUN}%`);
    });

    it("(i) **陰性**: suggest の6回目は 429。entities を消しても回数は戻らず、LLM も呼ばれない", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "integration-placeholder");
      vi.stubEnv("ANTHROPIC_MODEL", "integration-placeholder");
      vi.stubEnv("GBIZINFO_TOKEN", "");
      authState.ctx = ctxOf(suggestTenant);
      llm.mockClear();
      const { POST } = await import("@/app/api/competitors/suggest/route");

      for (let i = 1; i <= 5; i++) {
        const res = await POST(
          jsonPost("/api/competitors/suggest", { url: "https://example.test" }),
        );
        expect(res.status, `${i}回目`).toBe(200);
        // **以前の冪等ガードを破った手順**: 利用者が entities を消す
        await admin.from("entities").delete().eq("company_id", suggestTenant.id);
      }
      expect(llm).toHaveBeenCalledTimes(5);

      const sixth = await POST(
        jsonPost("/api/competitors/suggest", { url: "https://example.test" }),
      );
      expect(sixth.status).toBe(429);
      expect(Number(sixth.headers.get("Retry-After"))).toBeGreaterThan(0);
      // **429 の回は Anthropic に触れていない**
      expect(llm).toHaveBeenCalledTimes(5);

      // 回数は service_role の表にあり、会社単位で数えられている
      const { data } = await admin
        .from("api_rate_limits")
        .select("route, count")
        .eq("subject", `company:${suggestTenant.id}`);
      expect(data).toEqual([{ route: "competitors/suggest", count: 6 }]);

      vi.unstubAllEnvs();
    });

    it("(j) **陰性**: 同じ IP からの session POST は31回目で 429。別の IP は止めない", async () => {
      const { POST } = await import("@/app/api/auth/session/route");

      // 欄を空で送る（Supabase Auth まで行かず、入力不足でログイン画面に戻る）
      for (let i = 1; i <= 30; i++) {
        const res = await POST(sessionPost({ intent: "login" }, IP));
        expect(res.status, `${i}回目`).toBe(303);
      }

      const over = await POST(sessionPost({ intent: "login" }, IP));
      expect(over.status).toBe(429);
      expect(Number(over.headers.get("Retry-After"))).toBeGreaterThan(0);

      // **止めすぎていない**: 別の送信元は通る
      const other = await POST(sessionPost({ intent: "login" }, `${IP}-other`));
      expect(other.status).toBe(303);
    });

    it("(k) 陽性: csv/ingest は利用者のクライアント無しで書け、自社の行だけが増える", async () => {
      authState.ctx = ctxOf(ingestTenant);
      const { POST } = await import("@/app/api/csv/ingest/route");

      const res = await POST(
        jsonPost("/api/csv/ingest", {
          csv_text: ["日付,摘要,入金,出金", "2026/09/01,売上,10000,", "2026/09/02,仕入,,3000"].join(
            "\n",
          ),
          file_name: "rate-limit.csv",
          mapping: {
            date: "日付",
            description: "摘要",
            amount: null,
            direction: null,
            credit: "入金",
            debit: "出金",
            balance: null,
          },
        }),
      );
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(body.count).toBe(2);

      const { data: rows } = await admin
        .from("events")
        .select("company_id")
        .eq("source", "csv:accounting")
        .in("company_id", [ingestTenant.id, otherTenant.id]);
      expect(rows?.map((r) => r.company_id)).toEqual([ingestTenant.id, ingestTenant.id]);
    });

    it("(k) 陽性: suggest の entities は利用者のクライアント無しで書け、company_id はセッションの会社", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "integration-placeholder");
      vi.stubEnv("ANTHROPIC_MODEL", "integration-placeholder");
      vi.stubEnv("GBIZINFO_TOKEN", "");
      authState.ctx = ctxOf(otherTenant);
      const { POST } = await import("@/app/api/competitors/suggest/route");

      const res = await POST(jsonPost("/api/competitors/suggest", { url: "https://example.test" }));
      expect(res.status).toBe(200);

      const { data } = await admin
        .from("entities")
        .select("company_id, canonical_name")
        .eq("company_id", otherTenant.id);
      expect(data).toEqual([{ company_id: otherTenant.id, canonical_name: "試験用の競合" }]);

      vi.unstubAllEnvs();
    });

    it("(k) 陰性: 競合を既に持つ会社は、LLM も回数も動かない（/connect を開くたびに叩かれる）", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "integration-placeholder");
      vi.stubEnv("ANTHROPIC_MODEL", "integration-placeholder");
      vi.stubEnv("GBIZINFO_TOKEN", "");
      authState.ctx = ctxOf(otherTenant);
      llm.mockClear();
      const { POST } = await import("@/app/api/competitors/suggest/route");

      const countOf = async () => {
        const { data } = await admin
          .from("api_rate_limits")
          .select("count")
          .eq("subject", `company:${otherTenant.id}`)
          .eq("route", "competitors/suggest");
        return data?.[0]?.count ?? 0;
      };
      const before = await countOf();

      for (let i = 1; i <= 7; i++) {
        const res = await POST(
          jsonPost("/api/competitors/suggest", { url: "https://example.test" }),
        );
        expect(res.status, `${i}回目`).toBe(200);
        expect((await res.json()).status).toBe("already");
      }

      expect(llm).not.toHaveBeenCalled();
      expect(await countOf()).toBe(before);

      vi.unstubAllEnvs();
    });

    it("13b 陽性: CAPTCHA のトークンを付けても、Supabase で無効の間はログインできる（有効化の前に配れる）", async () => {
      const { POST } = await import("@/app/api/auth/session/route");
      const res = await POST(
        sessionPost(
          {
            intent: "login",
            email: ingestTenant.email,
            password: ingestTenant.password,
            next: "/connect",
            "cf-turnstile-response": "integration-token",
          },
          `${IP}-captcha`,
        ),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("http://localhost/connect");
      expect(res.cookies.getAll().length).toBeGreaterThan(0);
    });

    it("13b **陰性**: メール確認前のユーザーにはセッションが発行されない（本番は Confirm email ON）", async () => {
      const email = `${RUN}-unconfirmed@example.com`;
      const password = `Unc!${RUN}9x`;
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: false,
      });
      if (error || !data.user) throw new Error(`createUser 失敗: ${error?.message}`);

      try {
        const { POST } = await import("@/app/api/auth/session/route");
        const res = await POST(
          sessionPost({ intent: "login", email, password, next: "/connect" }, `${IP}-unconfirmed`),
        );
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toContain("/login?e=invalid_credentials");
        expect(res.cookies.getAll()).toEqual([]);
      } finally {
        await admin.auth.admin.deleteUser(data.user.id);
      }
    });
  });
}
