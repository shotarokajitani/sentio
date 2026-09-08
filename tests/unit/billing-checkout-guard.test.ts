/**
 * `/api/billing/checkout` の二重購読ガード（2026-09-08 決定）。
 *
 * **押せない画面を作っただけでは足りない。** `checkout.sessions.create` に
 * `customer` を渡していないので、直接叩かれると**新しい Customer と2本目の購読**ができる。
 * さらに webhook が `user_metadata.subscription` を**まるごと上書き**するため、
 * 古い購読はこちらから辿れなくなる。だからサーバ側でも止める（二重の関門の内側）。
 *
 * ここは**通り抜けないこと**が主役なので、陰性コントロールを対で置く。
 * 通り抜けたことは「設定の欠落（500）まで進んだ」ことで見る——
 * **試験から Stripe を叩かない**（本番にも試験にも購読を作らない）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { PORTAL_ENDPOINT } from "@/lib/billing/portal";

/** モックから読む可変の状態。`vi.mock` は巻き上がるので、値は後から差し替える */
const session = { subscriptionStatus: null as string | null };

vi.mock("@/lib/auth/company", () => ({
  getAuthedContext: async () => ({
    // 実在しない値に固定する（契約 停止点。実在の値をフィクスチャに書かない）
    companyId: "00000000-0000-0000-0000-000000000000",
    email: "nobody@example.invalid",
    siteUrl: null,
    subscriptionStatus: session.subscriptionStatus,
    stripeCustomerId: null,
    supabase: null,
  }),
  unauthorized: () => NextResponse.json({ error: "unauthorized" }, { status: 401 }),
}));

async function post(status: string | null): Promise<Response> {
  session.subscriptionStatus = status;
  const { POST } = await import("@/app/api/billing/checkout/route");
  return POST();
}

beforeEach(() => {
  // **Stripe を叩かせない。** 門を通り抜けたら設定の欠落で 500 になり、
  // それが「通り抜けた」ことの証拠になる
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("STRIPE_PRICE_STANDARD", "");
  vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("すでに購読がある状態では checkout を作らない（409）", () => {
  // 画面側の `hasStripeSubscription` と同じ3つ。**片方だけ直すと割れる**ので対で見る
  it.each(["active", "past_due", "trialing"])("status=%s は 409 で止める", async (status) => {
    const res = await post(status);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.error).toBe("already_subscribed");
    // **行き先を返す。** past_due の直し方は「支払い方法の更新」であって新規購読ではない
    expect(body.portal).toBe(PORTAL_ENDPOINT);
    expect(body.status).toBe(status);
  });

  it("409 の本文に Stripe の値を混ぜない（内部事情を出さない）", async () => {
    const text = await (await post("active")).text();

    for (const leak of ["sk_", "cus_", "sub_", "price_", "STRIPE"]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

describe("**陰性コントロール**: 購読が無い状態は止めない", () => {
  /**
   * `canceled` は購読が終わっている。**新しく始めるのが正しい**（BU-1-4）。
   * `unpaid` の扱いは未判断で、`docs/spec/07_open_items.md` に登録した。
   */
  it.each([null, "canceled", "incomplete", "unpaid", "", "ACTIVE"])(
    "status=%s は 409 にしない（門を通り抜ける）",
    async (status) => {
      const res = await post(status);

      expect(res.status).not.toBe(409);
      // 通り抜けた先は設定の欠落。**ここまで来たことが「止めていない」ことの証拠**
      expect(res.status).toBe(500);
    },
  );
});
