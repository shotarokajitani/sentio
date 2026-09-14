/**
 * ログインの POST が自分のサイトから来たか（2026-09-13 の点検・PR-3 の 16・login CSRF）。
 *
 * 判断は `lib/auth/origin.ts` の純関数で固定し、route がそれを先頭で通っているかは
 * route を本物で走らせて見る（Supabase のクライアントと回数制限だけを差し替える）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { checkOrigin } from "@/lib/auth/origin";

const auth = { signIn: vi.fn(async () => ({ error: null })) };
const hits = vi.fn(async () => ({ allowed: true, count: 1 }));

vi.mock("@/lib/supabase/server", () => ({
  createAuthClient: () => ({
    pending: [],
    supabase: { auth: { signInWithPassword: auth.signIn, getUser: async () => ({ data: { user: null } }) } },
  }),
}));

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, hitRate: hits };
});

describe("Origin の判定", () => {
  const SITE = "https://www.sentio-ai.jp";

  it("一致すれば通す（末尾の / と大文字小文字は無視する）", () => {
    expect(checkOrigin(SITE, SITE)).toEqual({ ok: true });
    expect(checkOrigin("https://WWW.sentio-ai.jp", `${SITE}/`)).toEqual({ ok: true });
  });

  it("**陰性**: 他のサイトからは断る", () => {
    expect(checkOrigin("https://evil.example.com", SITE)).toEqual({ ok: false, reason: "origin_mismatch" });
  });

  it("**陰性**: 前方一致で通さない（sentio-ai.jp.evil.example）", () => {
    expect(checkOrigin(`${SITE}.evil.example`, SITE)).toEqual({ ok: false, reason: "origin_mismatch" });
  });

  it("**陰性**: Origin が無ければ断る（フォームの POST には必ず付く）", () => {
    expect(checkOrigin(null, SITE)).toEqual({ ok: false, reason: "origin_missing" });
    expect(checkOrigin("", SITE)).toEqual({ ok: false, reason: "origin_missing" });
  });

  it("**陰性**: サイトの origin が未設定なら断る（照合できない状態を通さない）", () => {
    expect(checkOrigin(SITE, undefined)).toEqual({ ok: false, reason: "site_origin_unset" });
    expect(checkOrigin(SITE, " ")).toEqual({ ok: false, reason: "site_origin_unset" });
  });
});

describe("session route は Origin を先頭で見る", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://www.sentio-ai.jp");
    auth.signIn.mockClear();
    hits.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function post(origin: string | null) {
    const form = new FormData();
    form.set("intent", "login");
    form.set("email", "e@example.com");
    form.set("password", "password-5");
    return new NextRequest("https://www.sentio-ai.jp/api/auth/session", {
      method: "POST",
      body: form,
      headers: origin ? { origin } : {},
    });
  }

  it("**陰性**: 他のサイトからの POST は 403。回数も数えず、Supabase Auth にも進まない", async () => {
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(post("https://evil.example.com"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(hits).not.toHaveBeenCalled();
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it("**陰性**: Origin の無い POST は 403", async () => {
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(post(null));

    expect(res.status).toBe(403);
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it("自分のサイトからの POST は通る（ログインまで進む）", async () => {
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(post("https://www.sentio-ai.jp"));

    expect(res.status).toBe(303);
    expect(auth.signIn).toHaveBeenCalledTimes(1);
  });
});
