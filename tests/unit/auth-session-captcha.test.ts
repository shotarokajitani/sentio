/**
 * `POST /api/auth/session` が CAPTCHA のトークンを Supabase Auth に渡す（2026-09-13 の点検・13b）。
 *
 * `lib/auth/captcha.ts` の関数が正しくても、**route が使っていなければ意味が無い。**
 * Supabase で CAPTCHA を有効にした瞬間に、渡し忘れた経路の登録・ログインが全部拒否される。
 * ここは route を本物で走らせ、Supabase のクライアントだけを差し替えて、渡した引数を見る。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const calls: { signUp: unknown[]; signIn: unknown[] } = { signUp: [], signIn: [] };

vi.mock("@/lib/supabase/server", () => ({
  createAuthClient: () => ({
    pending: [],
    supabase: {
      auth: {
        signUp: async (args: unknown) => {
          calls.signUp.push(args);
          return { data: { session: null }, error: null };
        },
        signInWithPassword: async (args: unknown) => {
          calls.signIn.push(args);
          return { error: null };
        },
      },
    },
  }),
}));

// 回数を数える先は DB。ここでは常に通す（429 は tests/integration/rate-limit.test.ts）
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, hitRate: async () => ({ allowed: true, count: 1 }) };
});

function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new NextRequest("http://localhost/api/auth/session", { method: "POST", body: form });
}

describe("session route が captchaToken を渡す", () => {
  beforeEach(() => {
    calls.signUp = [];
    calls.signIn = [];
  });

  it("**陰性**: ログインでトークンが signInWithPassword の options.captchaToken に載る", async () => {
    const { POST } = await import("@/app/api/auth/session/route");
    await POST(
      post({
        intent: "login",
        email: "a@example.com",
        password: "password-1",
        "cf-turnstile-response": "tok-login",
      }),
    );
    expect(calls.signIn).toEqual([
      { email: "a@example.com", password: "password-1", options: { captchaToken: "tok-login" } },
    ]);
  });

  it("**陰性**: 登録でトークンと自社サイトの URL の両方が signUp の options に載る", async () => {
    const { POST } = await import("@/app/api/auth/session/route");
    await POST(
      post({
        intent: "signup",
        email: "b@example.com",
        password: "password-2",
        site_url: "https://example.co.jp",
        "cf-turnstile-response": "tok-signup",
      }),
    );
    expect(calls.signUp).toEqual([
      {
        email: "b@example.com",
        password: "password-2",
        options: { data: { site_url: "https://example.co.jp" }, captchaToken: "tok-signup" },
      },
    ]);
  });

  it("トークンが無ければ captchaToken を送らない（Supabase で無効の間はそのまま通る）", async () => {
    const { POST } = await import("@/app/api/auth/session/route");
    await POST(post({ intent: "login", email: "c@example.com", password: "password-3" }));
    expect(calls.signIn).toEqual([{ email: "c@example.com", password: "password-3", options: {} }]);
  });
});
