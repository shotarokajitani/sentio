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

/**
 * `checkout.session.completed` の本文。**実物の形に合わせてある**（2026-09-02 実測）。
 *
 * ここが `status: "active"` になっていたことが、本番で `"complete"` が書かれたのに
 * テストが緑だった理由である。**Checkout Session に `"active"` は入らない。**
 * `status` は `open` / `complete` / `expired` の3値で、**購読の状態ではない。**
 * フィクスチャを実装に合わせて書くと、テストは実装の写しになって嘘をつく。
 */
const PAYLOAD = JSON.stringify({
  type: "checkout.session.completed",
  data: {
    object: {
      client_reference_id: COMPANY,
      customer: "customer-ref",
      subscription: "subscription-ref",
      // 決済が完了すれば必ずこれが入る。**購読が active という意味ではない**
      status: "complete",
      payment_status: "paid",
    },
  },
});

/** Checkout Session の本文を、payment_status だけ差し替えて作る */
function checkoutSession(paymentStatus: string | null): string {
  const object: Record<string, unknown> = {
    client_reference_id: COMPANY,
    customer: "customer-ref",
    subscription: "subscription-ref",
    status: "complete",
  };
  if (paymentStatus !== null) object.payment_status = paymentStatus;
  return JSON.stringify({ type: "checkout.session.completed", data: { object } });
}

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
    // **実物の Subscription には `client_reference_id` が無い。**
    // 以前はここに載せた作り物で通していたが、それは本番で起きないことを
    // 「正しい」と固定していた（:239 のコメントが「本番では到達しない」と自認していた）。
    const canceled = JSON.stringify({
      type: "customer.subscription.deleted",
      data: {
        object: { id: "sub_ref", customer: "customer-ref", status: "canceled" },
      },
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

/**
 * BS-1 系（`docs/instructions/2026-09-03_cc_billing-status-fix.md`）。
 *
 * **経路が通ったことと、正しい値が書かれたことは別である。** 本番では webhook が
 * 200 を返し、書き込みも成功したうえで `status: "complete"` が入っていた。
 * `"complete"` は `connect-client.tsx` の判定も `plan.ts` の `ENTITLED_STATUSES` も
 * 通らないので、**払っても購読ボタンが消えず、枠も増えない。待っても直らない。**
 */
describe("BS-1 何を status として書くか", () => {
  beforeEach(() => {
    updateUserById.mockClear();
    stubEnv();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("BS-1-1 決済が済んだ Checkout Session では active を書く", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(PAYLOAD, sign(PAYLOAD)));

    expect(res.status).toBe(200);
    const [, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(payload.user_metadata.subscription.status).toBe("active");
  });

  it("BS-1-2 **object.status が complete でも、書かれる値は active である**", async () => {
    // 本番で実際に書かれてしまった値。フィクスチャの status は "complete" である
    expect(JSON.parse(PAYLOAD).data.object.status).toBe("complete");

    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(PAYLOAD, sign(PAYLOAD)));

    const [, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(payload.user_metadata.subscription.status).not.toBe("complete");
    expect(payload.user_metadata.subscription.status).toBe("active");
  });

  it.each(["unpaid", "no_payment_required", "processing", null])(
    "BS-1-3 陰性コントロール: payment_status=%s では**何も書かない**（払っていない人を購読中にしない）",
    async (paymentStatus) => {
      const body = checkoutSession(paymentStatus);
      const { POST } = await import("@/app/api/billing/webhook/route");
      const res = await POST(post(body, sign(body)));

      // 再送を滞留させないので 200 で受ける。ただし**書かない**
      expect(res.status).toBe(200);
      expect(updateUserById).not.toHaveBeenCalled();
    },
  );

  it("BS-1-4 陰性コントロール: Subscription の past_due を active に潰さない", async () => {
    // **実物の Subscription の形**（`client_reference_id` は無い）。
    // 以前は作り物で通していたが、それは本番で起きない形だった
    const updated = JSON.stringify({
      type: "customer.subscription.updated",
      data: {
        object: { id: "sub_ref", customer: "customer-ref", status: "past_due" },
      },
    });
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(updated, sign(updated)));

    const [, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(payload.user_metadata.subscription.status).toBe("past_due");
  });

  it("実物の Subscription からも会社を引けること（customer id で引く）", async () => {
    // **これは「無視されるのが正しい」を固定していた試験の置き換えである。**
    // 旧 BS-2-3 は `{status:"ignored", reason:"no_company"}` を期待していたが、
    // それは**解約が本番に反映されない事故そのもの**を「正しい」と書いていた。
    const updated = JSON.stringify({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_ref", customer: "customer-ref", status: "active" } },
    });
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(updated, sign(updated)));

    expect(updateUserById).toHaveBeenCalled();
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
