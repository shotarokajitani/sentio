/**
 * 課金の webhook（2026-09-02 / 2026-09-07 に ④-a で拡張）。
 *
 * **陰性コントロールが主役である。** この経路の認証は署名検証だけで、
 * 通してしまえば「**誰でも他社を有料プランにできる**」エンドポイントになる。
 *
 * 署名検証そのものの試験は `tests/unit/webhook-signature.test.ts` にある。
 * ここが見るのは「**検証を通らなかったときに、本文を解釈していないか**」である。
 *
 * **フィクスチャは Stripe の実物の形に合わせる。実装に合わせない**（受入 5-6）。
 * 実装に合わせて書けば、実装が間違っていてもテストは同じ間違いをする。
 * 実際、`checkout.session.completed` に `status: "active"` を入れたフィクスチャが
 * 本番の `status: "complete"` バグを緑のまま通していた（2026-09-02）。
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
const updateUserById = vi.fn();
/** 会社の逆引き（`00029` の SECURITY DEFINER RPC）。**新しいテーブルは作らない** */
const rpc = vi.fn();
/** 引けなかったイベントを残す表への書き込み */
const upsert = vi.fn();
const from = vi.fn(() => ({ upsert }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { admin: { updateUserById } }, rpc, from }),
}));

/**
 * Stripe から Subscription を取り直す経路（受入 5-5 / 4-6）。
 * **ペイロードの status を信じず、ここが返す値を正本にする。**
 */
const retrieve = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    subscriptions = { retrieve };
  },
}));

type UpdateCall = [string, { user_metadata: { subscription: Record<string, string> } }];
type UpsertCall = [
  Record<string, string | null>,
  { onConflict: string; ignoreDuplicates: boolean },
];

/**
 * `checkout.session.completed` の本文。**実物の形に合わせてある**（2026-09-02 実測）。
 *
 * ここが `status: "active"` になっていたことが、本番で `"complete"` が書かれたのに
 * テストが緑だった理由である。**Checkout Session に `"active"` は入らない。**
 * `status` は `open` / `complete` / `expired` の3値で、**購読の状態ではない。**
 */
const PAYLOAD = JSON.stringify({
  id: "evt_checkout",
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
  return JSON.stringify({
    id: "evt_checkout",
    type: "checkout.session.completed",
    data: { object },
  });
}

/**
 * `customer.subscription.*` の本文。**実物には `client_reference_id` が無い。**
 * 以前はここに載せた作り物で通していたが、それは本番で起きない形だった。
 */
function subscriptionEvent(type: string, status: string, id = "evt_sub"): string {
  return JSON.stringify({
    id,
    type,
    data: { object: { id: "sub_ref", customer: "customer-ref", status } },
  });
}

function stubEnv() {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("STRIPE_SECRET_KEY", "unit-test-stripe-placeholder");
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "unit-test-placeholder");
}

/** 既定は「会社が引けて、Stripe から取り直せる」状態。各試験が必要な分だけ壊す */
function resetMocks() {
  updateUserById.mockReset().mockResolvedValue({ data: {}, error: null });
  rpc.mockReset().mockResolvedValue({ data: { company_id: COMPANY, matches: 1 }, error: null });
  upsert.mockReset().mockResolvedValue({ error: null });
  from.mockClear();
  retrieve
    .mockReset()
    .mockResolvedValue({ id: "sub_ref", customer: "customer-ref", status: "active" });
}

describe("署名検証（陰性コントロール）", () => {
  beforeEach(() => {
    resetMocks();
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

  it("**STRIPE_SECRET_KEY が無ければ 500**（取り直せないまま推測で書かない）", async () => {
    // ④-a で状態の正本を Stripe に移したので、この鍵が無いと status を決められない
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { POST } = await import("@/app/api/billing/webhook/route");

    expect((await POST(post(PAYLOAD, sign(PAYLOAD)))).status).toBe(500);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe("署名が通ったとき", () => {
  beforeEach(() => {
    resetMocks();
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
    // client_reference_id で引けたなら**逆引きは呼ばない**（こちらが入れた値のほうが強い）
    expect(rpc).not.toHaveBeenCalled();
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
    retrieve.mockResolvedValue({ id: "sub_ref", customer: "customer-ref", status: "canceled" });
    const canceled = subscriptionEvent("customer.subscription.deleted", "canceled");
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(canceled, sign(canceled)));

    const [, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(payload.user_metadata.subscription.status).toBe("canceled");
  });

  it("会社を引けない通知は 200 で受け取り、購読を書かない（再送を滞留させない）", async () => {
    rpc.mockResolvedValue({ data: { company_id: null, matches: 0 }, error: null });
    const body = subscriptionEvent("customer.subscription.updated", "active");
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(body, sign(body)));

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
    resetMocks();
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
      // 異常ではないので、引けなかった表にも入れない
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  it("BS-1-4 陰性コントロール: Subscription の past_due を active に潰さない", async () => {
    // **実物の Subscription の形**（`client_reference_id` は無い）
    retrieve.mockResolvedValue({ id: "sub_ref", customer: "customer-ref", status: "past_due" });
    const updated = subscriptionEvent("customer.subscription.updated", "past_due");
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(updated, sign(updated)));

    const [, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(payload.user_metadata.subscription.status).toBe("past_due");
  });

  it("実物の Subscription からも会社を引けること（customer id で引く）", async () => {
    // **これは「無視されるのが正しい」を固定していた試験の置き換えである。**
    // 旧 BS-2-3 は `{status:"ignored", reason:"no_company"}` を期待していたが、
    // それは**解約が本番に反映されない事故そのもの**を「正しい」と書いていた。
    const updated = subscriptionEvent("customer.subscription.updated", "active");
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(updated, sign(updated)));

    expect(rpc).toHaveBeenCalledWith("company_id_by_stripe_customer", {
      p_customer_id: "customer-ref",
    });
    expect(updateUserById).toHaveBeenCalled();
    const [id] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(id).toBe(COMPANY);
  });
});

/**
 * ④-a（受入 5-1 / 5-3 / 5-4 / 5-5 / 5-7）。
 *
 * **逆引きを足した副作用が主題である。** customer id で引けるようになったということは、
 * `invoice.*` のような別の種別からも会社が引けるようになったということでもある。
 * 種別を絞らなければ、Invoice の `status`（`paid`）を購読の status として書いてしまう。
 */
describe("④-a 逆引きと、引けなかったイベントの扱い", () => {
  beforeEach(() => {
    resetMocks();
    stubEnv();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("5-5 ペイロードの status と Stripe の status が食い違ったら、**Stripe を正とする**", async () => {
    // ペイロードは past_due だが、取り直した Subscription は active
    retrieve.mockResolvedValue({ id: "sub_ref", customer: "customer-ref", status: "active" });
    const updated = subscriptionEvent("customer.subscription.updated", "past_due");
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(updated, sign(updated)));

    expect(retrieve).toHaveBeenCalledWith("sub_ref");
    const [, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(payload.user_metadata.subscription.status).toBe("active");
  });

  it("5-1 識別子は**取り直した Subscription の値**を書く", async () => {
    retrieve.mockResolvedValue({ id: "sub_true", customer: "cus_true", status: "active" });
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(PAYLOAD, sign(PAYLOAD)));

    const [, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(payload.user_metadata.subscription).toMatchObject({
      stripe_customer_id: "cus_true",
      stripe_subscription_id: "sub_true",
    });
  });

  it("5-7 陰性コントロール: **扱わない種別では会社が引けても何も書かない**", async () => {
    // invoice.paid の `status` は購読の状態ではない。逆引きが効く以上、
    // 種別を絞らないと `paid` が購読の status として書かれる
    const invoice = JSON.stringify({
      id: "evt_invoice",
      type: "invoice.paid",
      data: { object: { id: "in_ref", customer: "customer-ref", status: "paid" } },
    });
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(invoice, sign(invoice)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason: "unhandled_type" });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    // 異常ではないので、引けなかった表にも入れない（溜めるべきでないものを溜めない）
    expect(upsert).not.toHaveBeenCalled();
  });

  it("5-3 会社を引けなかったら、**捨てずに残す**（種別・イベントID・生の識別子）", async () => {
    rpc.mockResolvedValue({ data: { company_id: null, matches: 0 }, error: null });
    const body = subscriptionEvent("customer.subscription.deleted", "canceled", "evt_lost");
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(body, sign(body)));

    expect(res.status).toBe(200);
    expect(from).toHaveBeenCalledWith("billing_webhook_unresolved");
    const [row] = upsert.mock.calls[0] as unknown as UpsertCall;
    expect(row).toEqual({
      stripe_event_id: "evt_lost",
      event_type: "customer.subscription.deleted",
      reason: "not_found",
      stripe_customer_id: "customer-ref",
    });
  });

  it("5-3 **2社が同じ customer id を持つときは ambiguous として残す**（not_found と混ぜない）", async () => {
    // 逆引きは会社を返さないが、**一致数は返す。** 0件と2件以上は原因も対処も違う
    rpc.mockResolvedValue({ data: { company_id: null, matches: 2 }, error: null });
    const body = subscriptionEvent("customer.subscription.updated", "active", "evt_ambiguous");
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(body, sign(body)));

    expect(updateUserById).not.toHaveBeenCalled();
    const [row] = upsert.mock.calls[0] as unknown as UpsertCall;
    expect(row).toMatchObject({ reason: "ambiguous", stripe_event_id: "evt_ambiguous" });
  });

  it("5-3 陰性コントロール: **ペイロード全体は保存しない**", async () => {
    rpc.mockResolvedValue({ data: { company_id: null, matches: 0 }, error: null });
    const body = subscriptionEvent("customer.subscription.updated", "active");
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(body, sign(body)));

    const [row] = upsert.mock.calls[0] as unknown as UpsertCall;
    expect(Object.keys(row).sort()).toEqual([
      "event_type",
      "reason",
      "stripe_customer_id",
      "stripe_event_id",
    ]);
  });

  it("5-4 冪等: 同じイベントIDで2回入らない（イベントIDで衝突させる）", async () => {
    rpc.mockResolvedValue({ data: { company_id: null, matches: 0 }, error: null });
    const body = subscriptionEvent("customer.subscription.updated", "active", "evt_same");
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(body, sign(body)));
    await POST(post(body, sign(body)));

    const [, options] = upsert.mock.calls[0] as unknown as UpsertCall;
    expect(options).toEqual({ onConflict: "stripe_event_id", ignoreDuplicates: true });
    // 2回とも同じ行を書きに行く（**行が増えないことはDB側の PRIMARY KEY が担保する**）
    const [second] = upsert.mock.calls[1] as unknown as UpsertCall;
    expect(second.stripe_event_id).toBe("evt_same");
  });

  it("5-4 冪等: 会社が引けるなら、同じ通知を2回処理しても書かれる値は変わらない", async () => {
    const updated = subscriptionEvent("customer.subscription.updated", "active");
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(post(updated, sign(updated)));
    await POST(post(updated, sign(updated)));

    const [, first] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    const [, second] = updateUserById.mock.calls[1] as unknown as UpdateCall;
    expect(second).toEqual(first);
  });

  it("Stripe から取り直せなければ**書かない**。事実は残す", async () => {
    retrieve.mockRejectedValue(new Error("stripe unavailable"));
    const updated = subscriptionEvent("customer.subscription.updated", "active", "evt_fetchfail");
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(updated, sign(updated)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason: "stripe_unavailable" });
    expect(updateUserById).not.toHaveBeenCalled();
    const [row] = upsert.mock.calls[0] as unknown as UpsertCall;
    expect(row).toMatchObject({ reason: "retrieve_failed", stripe_event_id: "evt_fetchfail" });
  });

  it("**解約だけは例外**: 取り直せなくても canceled を書く（種別そのものが事実である）", async () => {
    retrieve.mockRejectedValue(new Error("stripe unavailable"));
    const canceled = subscriptionEvent("customer.subscription.deleted", "canceled");
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(canceled, sign(canceled)));

    expect(res.status).toBe(200);
    const [, payload] = updateUserById.mock.calls[0] as unknown as UpdateCall;
    expect(payload.user_metadata.subscription.status).toBe("canceled");
    // 書けているので、引けなかった表には入れない
    expect(upsert).not.toHaveBeenCalled();
  });

  it("陰性コントロール: **記録すらできなければ 200 で流さない**（再送に賭ける）", async () => {
    rpc.mockResolvedValue({ data: { company_id: null, matches: 0 }, error: null });
    upsert.mockResolvedValue({ error: { message: "insert failed" } });
    const body = subscriptionEvent("customer.subscription.updated", "active");
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(body, sign(body)));

    expect(res.status).toBe(500);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("陰性コントロール: 逆引きが**エラーで落ちたとき**に、会社を推測しない", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    const body = subscriptionEvent("customer.subscription.updated", "active");
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(post(body, sign(body)));

    expect(await res.json()).toEqual({ status: "ignored", reason: "no_company" });
    expect(updateUserById).not.toHaveBeenCalled();
    const [row] = upsert.mock.calls[0] as unknown as UpsertCall;
    expect(row).toMatchObject({ reason: "lookup_failed" });
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
