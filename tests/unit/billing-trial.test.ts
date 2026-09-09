/**
 * 無料期間14日は **Checkout セッション側**で付ける（2026-09-09 決定・検収者）。
 *
 * **本番 Stripe の price には触らない。** price 側に付けると、その価格を使う全員に効き、
 * 変えるには本番の価格オブジェクトを書き換えることになる。
 *
 * ここは Stripe を**偽物に差し替えて**、渡した引数そのものを見る。
 * **試験から Stripe を叩かない**（本番にも試験にも購読を作らない。
 * `billing-checkout-guard.test.ts` と同じ作法）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { SENTIO_TRIAL_DAYS } from "@/lib/pricing";
import { hasStripeSubscription } from "@/lib/billing/subscription-state";

/** Stripe へ渡した引数をここに溜める。**送信はしない** */
const created: Record<string, unknown>[] = [];

const session = { subscriptionStatus: null as string | null };

vi.mock("stripe", () => ({
  default: class FakeStripe {
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          created.push(params);
          return { url: "https://example.invalid/checkout" };
        },
      },
    };
  },
}));

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
  created.length = 0;
  // 鍵の形をした文字列を置かない（gitleaks と秘密の作法）。route は真偽しか見ない
  vi.stubEnv("STRIPE_SECRET_KEY", "stub-not-a-key");
  vi.stubEnv("STRIPE_PRICE_STANDARD", "stub-price");
  vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://example.invalid");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("無料期間をセッションに付ける", () => {
  it("trial_period_days が定数の値で渡る", async () => {
    const res = await post(null);

    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0].subscription_data).toEqual({ trial_period_days: SENTIO_TRIAL_DAYS });
  });

  it("**陰性**: 新しい price を作らない（既存の price の id を渡すだけ）", async () => {
    await post(null);

    const items = created[0].line_items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe("stub-price");
    // `price_data` を渡すと**その場で価格が作られる**。本番の商品構成が増える
    expect(items[0]).not.toHaveProperty("price_data");
  });

  it("trial_settings を渡さない（無料期間の終わり方を既定から変えない）", async () => {
    await post(null);

    expect(created[0]).not.toHaveProperty("trial_settings");
  });

  it("**陰性**: 500 になる2つ（絶対規則）を渡していない", async () => {
    await post(null);

    expect(created[0]).not.toHaveProperty("billing_address_collection");
    expect(created[0]).not.toHaveProperty("customer_creation");
  });
});

describe("409ガードを壊していない（否定リストのまま）", () => {
  it("trialing は「購読が存在する」側である", () => {
    expect(hasStripeSubscription("trialing")).toBe(true);
  });

  it("trialing で叩いても 409 で止まり、**セッションを作らない**", async () => {
    const res = await post("trialing");

    expect(res.status).toBe(409);
    // ここが本体。門を通っていたら Stripe に2本目のセッションが残る
    expect(created).toHaveLength(0);
  });

  it("購読が無い2つだけが通る（canceled / incomplete_expired）", async () => {
    for (const status of ["canceled", "incomplete_expired"]) {
      created.length = 0;
      const res = await post(status);

      expect(res.status, status).toBe(200);
      expect(created, status).toHaveLength(1);
    }
  });

  it("**陰性**: 知らない状態は通さない（Stripe が将来足す状態）", async () => {
    const res = await post("grace_period");

    expect(res.status).toBe(409);
    expect(created).toHaveLength(0);
  });
});
