/**
 * 課金の webhook（2026-09-02）。
 *
 * **陰性コントロールが主役である。** この経路の認証は署名検証だけで、
 * 通してしまえば「**誰でも他社を有料プランにできる**」エンドポイントになる。
 *
 * 署名検証そのものの試験は `tests/unit/webhook-signature.test.ts` にある。
 * ここが見るのは「**検証を通らなかったときに、本文を解釈していないか**」である。
 *
 * 秘密の実値に似た文字列は置かない（hooks の `check-secrets-patterns` が拒否する）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";
import { planFromMetadata } from "@/lib/billing/plan";
import { STANDARD_PLAN, TRIAL_PLAN, DEFAULT_PLAN } from "@edge/_shared/budget";

const SECRET = "unit-test-webhook-secret";
const COMPANY = "11111111-1111-4111-8111-111111111111";

function sign(payload: string, secret = SECRET, timestamp = "1756800000"): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

function post(body: string, signature: string): NextRequest {
  return new NextRequest("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": signature },
    body,
  });
}

/** updateUserById を呼んだかどうかを見るためのスパイ */
const updateUserById = vi.fn(async () => ({ data: {}, error: null }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { admin: { updateUserById } } }),
}));

type UpdateCall = [string, { user_metadata: { subscription: Record<string, string> } }];

const PAYLOAD = JSON.stringify({
  type: "checkout.session.completed",
  data: {
    object: {
      client_reference_id: COMPANY,
      customer: "customer-ref",
      subscription: "subscription-ref",
      status: "active",
    },
  },
});

function stubEnv() {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "unit-test-placeholder");
}

describe("署名検証（陰性コントロール）", () => {
  beforeEach(() => {
    updateUserById.mockClear();
    stubEnv();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("**署名が無ければ 401。購読を1件も書かない**", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(PAYLOAD, ""));

    expect(res.status).toBe(401);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("**署名が違えば 401。購読を1件も書かない**", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(PAYLOAD, sign(PAYLOAD, "another-secret")));

    expect(res.status).toBe(401);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("本文を1バイト変えただけでも 401（生の本文で検証している）", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const signature = sign(PAYLOAD);
    const tampered = PAYLOAD.replace(COMPANY, "22222222-2222-4222-8222-222222222222");

    expect((await POST(post(tampered, signature))).status).toBe(401);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("401 の本文に理由を出さない（総当たりの手掛かりを与えない）", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const body = await (await POST(post(PAYLOAD, "t=1,v1=abcdef"))).json();

    expect(body).toEqual({ error: "invalid signature" });
  });

  it("設定が欠けていれば 500。購読を書かない", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const { POST } = await import("@/app/api/billing/webhook/route");

    expect((await POST(post(PAYLOAD, sign(PAYLOAD)))).status).toBe(500);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe("署名が通ったとき", () => {
  beforeEach(() => {
    updateUserById.mockClear();
    stubEnv();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("会社を client_reference_id から引き、購読を書く", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(PAYLOAD, sign(PAYLOAD)));

    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledTimes(1);
    const [id, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(id).toBe(COMPANY);
    expect(payload.user_metadata.subscription).toMatchObject({
      plan_id: STANDARD_PLAN.id,
      status: "active",
    });
  });

  it("**カード情報も金額も保存しない**（識別子と status だけ）", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(PAYLOAD, sign(PAYLOAD)));

    const [, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(Object.keys(payload.user_metadata.subscription).sort()).toEqual([
      "plan_id",
      "status",
      "stripe_customer_id",
      "stripe_subscription_id",
    ]);
  });

  it("解約は購読を消さず status に残す（いつ止まったかを失わない）", async () => {
    const canceled = JSON.stringify({
      type: "customer.subscription.deleted",
      data: { object: { client_reference_id: COMPANY, customer: "customer-ref", status: "active" } },
    });
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(canceled, sign(canceled)));

    const [, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(payload.user_metadata.subscription.status).toBe("canceled");
  });

  it("会社を引けない通知は 200 で受け取り、何も書かない（再送を滞留させない）", async () => {
    const noCompany = JSON.stringify({ type: "invoice.paid", data: { object: {} } });
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(noCompany, sign(noCompany)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason: "no_company" });
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe("planFromMetadata — 購読から枠を引く", () => {
  it("有効な購読なら、そのプランの枠になる", () => {
    expect(planFromMetadata({ subscription: { plan_id: "standard", status: "active" } })).toBe(
      STANDARD_PLAN,
    );
    expect(planFromMetadata({ subscription: { plan_id: "trial", status: "trialing" } })).toBe(
      TRIAL_PLAN,
    );
  });

  it("**支払いが滞っている購読では枠を与えない**。ただし 0 にはしない", () => {
    for (const status of ["past_due", "canceled", "incomplete", "unpaid"]) {
      expect(planFromMetadata({ subscription: { plan_id: "standard", status } }), status).toBe(
        DEFAULT_PLAN,
      );
    }
  });

  it("購読が無ければ既定（＝いまは標準）。**既存の会社の枠を減らさない**", () => {
    expect(planFromMetadata(null)).toBe(DEFAULT_PLAN);
    expect(planFromMetadata({})).toBe(DEFAULT_PLAN);
    expect(planFromMetadata({ subscription: null })).toBe(DEFAULT_PLAN);
  });

  it("知らない plan_id は既定に落とす", () => {
    expect(planFromMetadata({ subscription: { plan_id: "gold", status: "active" } })).toBe(
      DEFAULT_PLAN,
    );
  });
});
