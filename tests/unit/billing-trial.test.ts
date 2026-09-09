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
import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { SENTIO_TRIAL_DAYS } from "@/lib/pricing";
import { hasStripeSubscription } from "@/lib/billing/subscription-state";

/** Stripe へ渡した引数をここに溜める。**送信はしない** */
const created: Record<string, unknown>[] = [];

const session = { subscriptionStatus: null as string | null };

/** webhook 側が取り直す Subscription。**status の正本はこちら**（BS-1-2） */
const retrieve = vi.fn(async () => ({
  id: "sub_trial",
  status: "trialing",
  customer: "cus_trial",
  trial_end: 1789000000,
}));

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
    subscriptions = { retrieve };
  },
}));

/** webhook は service_role のクライアントを自分で作る。**台帳も更新も偽物で受ける** */
const updateUserById = vi.fn(async (_id: string, _attrs: unknown) => ({ error: null }));
const ledgerInsert = vi.fn(async () => ({ error: null }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { admin: { updateUserById, getUserById: async () => ({ data: null, error: null }) } },
    rpc: async () => ({ data: null, error: null }),
    from: () => ({
      insert: ledgerInsert,
      // 台帳の存在確認（`00034`）。**既定は「初めて」** を返す
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }),
    }),
  }),
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
    expect(created[0].subscription_data).toEqual({
      trial_period_days: SENTIO_TRIAL_DAYS,
      // **会社を Subscription 自身にも持たせる**（A-3）。
      // `customer.subscription.*` の webhook は `client_reference_id` を持たない
      metadata: { company_id: "00000000-0000-0000-0000-000000000000" },
    });
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

describe("無料期間つきの申し込みが記録される（A-2）", () => {
  // 実在しない値。**鍵の形をした文字列を置かない**（gitleaks と秘密の作法）
  const SIGNING = "stub-signing-value";

  function sign(payload: string): string {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", SIGNING).update(`${timestamp}.${payload}`).digest("hex");
    return `t=${timestamp},v1=${sig}`;
  }

  beforeEach(() => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING);
    vi.stubEnv("STRIPE_SECRET_KEY", "stub-not-a-key");
    vi.stubEnv("SUPABASE_URL", "https://example.invalid");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "stub-not-a-key");
    updateUserById.mockClear();
  });

  it("**trial 付きセッションの completed で status が trialing になる**", async () => {
    // 無料期間つきは合計0円なので `payment_status` は `no_payment_required` になる。
    // ここを弾くと、招待や無料期間からの申し込みが**1件も記録されない**
    const body = JSON.stringify({
      id: "evt_trial_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_trial",
          object: "checkout.session",
          payment_status: "no_payment_required",
          status: "complete",
          client_reference_id: "00000000-0000-0000-0000-000000000000",
          customer: "cus_trial",
          subscription: "sub_trial",
        },
      },
    });

    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(
      new Request("https://example.invalid/api/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": sign(body) },
        body,
      }) as never,
    );

    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledTimes(1);
    const payload = (updateUserById.mock.calls[0] as unknown[])[1] as {
      user_metadata: { subscription: { status: string } };
    };
    expect(payload.user_metadata.subscription.status).toBe("trialing");
  });
});
