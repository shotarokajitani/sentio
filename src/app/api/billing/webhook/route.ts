import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyStripeSignature } from "@/security/webhook-verify";
import { STANDARD_PLAN } from "@edge/_shared/budget.ts";

/**
 * Stripe からの通知を受け取り、購読をユーザーのメタデータに反映する。
 *
 * ## 署名検証は必須（CLAUDE.md の絶対規則）
 *
 * **検証を通らなければ本文を1バイトも解釈しない。** 認証はここだけであり、
 * 通してしまえば「誰でも他社を有料プランにできる」エンドポイントになる。
 * 検証器は既存の `verifyStripeSignature`（`src/security/webhook-verify.ts`）を使う。
 * **生の本文で検証する**ので、`req.json()` より先に `req.text()` を読む。
 *
 * ## 会社の引き当て
 *
 * `client_reference_id` に checkout で入れた `company_id` が入っている。
 * **ここ以外から会社を決めない。** メールアドレスで引くと、
 * Stripe 側で変えられる値が会社の鍵になってしまう。
 *
 * ## 何を保存するか
 *
 * `auth.users.user_metadata.subscription` に Stripe の識別子と status だけ。
 * **カード情報も金額も保存しない。** 必要なら Stripe 側が正本である。
 */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret || !supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "billing webhook not configured" }, { status: 500 });
  }

  // **生の本文で検証する。** パースしてから直すと署名と一致しない
  const raw = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";

  const verified = verifyStripeSignature(raw, signature, secret);
  if (!verified.valid) {
    // 理由は返さない。総当たりの手掛かりを与えない
    console.error("stripe webhook signature rejected:", verified.error);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const object = event.data?.object ?? {};
  const companyId = typeof object.client_reference_id === "string" ? object.client_reference_id : null;

  // 会社を引けない通知は**何もせずに 200 で受け取る。**
  // 4xx を返すと Stripe が再送を続け、通知が滞留する
  if (!companyId) {
    return NextResponse.json({ status: "ignored", reason: "no_company" });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // 解約は購読を消すのではなく status を残す。**いつ止まったかが分からなくなる**
  const status =
    event.type === "customer.subscription.deleted"
      ? "canceled"
      : typeof object.status === "string"
        ? object.status
        : "active";

  const { error } = await admin.auth.admin.updateUserById(companyId, {
    user_metadata: {
      subscription: {
        plan_id: STANDARD_PLAN.id,
        stripe_customer_id: typeof object.customer === "string" ? object.customer : "",
        stripe_subscription_id: typeof object.subscription === "string" ? object.subscription : "",
        status,
      },
    },
  });

  if (error) {
    console.error("subscription update failed:", error.message);
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }

  return NextResponse.json({ status: "ok", type: event.type ?? "unknown" });
}
