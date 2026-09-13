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

/** Supabase Auth が返すエラー。既定は成功（null） */
const stub: { authError: { code?: string; message: string } | null } = { authError: null };

/** 本番ログの形（2026-09-13 16:48〜16:49 UTC） */
const CAPTCHA_DUPLICATE = {
  code: "captcha_failed",
  message: "captcha protection: request disallowed (timeout-or-duplicate)",
};

/** セッションの cookie 名（@supabase/ssr の形）。**これが要求に載っていれば、getUser が利用者を返す** */
const SESSION_COOKIE = "sb-127-auth-token";

vi.mock("@/lib/supabase/server", () => ({
  createAuthClient: (request: { cookies: { getAll: () => { name: string }[] } }) => ({
    pending: [],
    supabase: {
      auth: {
        signUp: async (args: unknown) => {
          calls.signUp.push(args);
          return { data: { session: null }, error: stub.authError };
        },
        signInWithPassword: async (args: unknown) => {
          calls.signIn.push(args);
          return { error: stub.authError };
        },
        // **要求の cookie だけを見る。** 1回目で入った cookie が2回目に載っているかどうか
        getUser: async () => {
          const signedIn = request.cookies.getAll().some((c) => c.name === SESSION_COOKIE);
          return { data: { user: signedIn ? { id: "user-1" } : null }, error: null };
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

function post(fields: Record<string, string>, cookie?: string) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new NextRequest("http://localhost/api/auth/session", {
    method: "POST",
    body: form,
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

describe("session route が captchaToken を渡す", () => {
  beforeEach(() => {
    stub.authError = null;
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

/**
 * 二度押し（2026-09-13 16:48〜16:49 UTC の本番ログ・3回とも同じ形）。
 *
 * 1回目が成功して cookie が入り、同じトークンの2回目が `timeout-or-duplicate` で断られ、
 * **ログイン済みなのに「メールアドレスかパスワードが違います」と出ていた。**
 */
describe("CAPTCHA で断られたとき", () => {
  beforeEach(() => {
    calls.signUp = [];
    calls.signIn = [];
    stub.authError = CAPTCHA_DUPLICATE;
  });

  const login = {
    intent: "login",
    email: "d@example.com",
    password: "password-4",
    next: "/connect",
    "cf-turnstile-response": "tok-used",
  };
  const signup = { ...login, intent: "signup" };

  it("(l) **陰性**: ログインで、有効なセッションの cookie が既にあれば next へ 303（エラーにしない）", async () => {
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(post(login, `${SESSION_COOKIE}=base64-session`));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/connect");
  });

  it("(m) **陰性**: ログインで cookie が無ければ captcha_failed に戻す（invalid_credentials にしない）", async () => {
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(post(login));

    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login?e=captcha_failed");
    expect(location).not.toContain("invalid_credentials");
  });

  it("(l) 登録も同じ: cookie があれば next へ 303", async () => {
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(post(signup, `${SESSION_COOKIE}=base64-session`));

    expect(res.headers.get("location")).toBe("http://localhost/connect");
  });

  it("(m) 登録も同じ: cookie が無ければ captcha_failed（登録の入口を保つ）", async () => {
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(post(signup));

    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login?e=captcha_failed");
    expect(location).toContain("mode=signup");
  });

  it("CAPTCHA 以外の失敗（パスワード違い）は、cookie があっても invalid_credentials のまま", async () => {
    stub.authError = { code: "invalid_credentials", message: "Invalid login credentials" };
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(post(login, `${SESSION_COOKIE}=base64-session`));

    expect(res.headers.get("location")).toContain("/login?e=invalid_credentials");
  });
});
