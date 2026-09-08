import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getAuthedContext, unauthorized } from "@/lib/auth/company";
import { hasStripeSubscription } from "@/lib/billing/subscription-state";

/**
 * 標準プランの購読を始める（Stripe Checkout のセッションを作る）。
 *
 * **company_id はセッション由来。** ボディで受け取ると他社の購読を作れてしまう。
 *
 * ## 絶対規則（CLAUDE.md）
 *
 * `billing_address_collection` と `customer_creation` を**渡さない**。
 * サブスクリプションでこの2つを渡すと 500 になることが既知である。
 *
 * ## 何も勝手に登録しない
 *
 * ここが作るのは**支払い画面へのリンクだけ**である。購読が成立するのは
 * 利用者が Stripe の画面で確定したときで、その結果は webhook で受け取る。
 */
export async function POST() {
  const ctx = await getAuthedContext();
  if (!ctx) return unauthorized();

  // **二重課金の入口をここで塞ぐ。**
  // `checkout.sessions.create` に `customer` を渡していないため、
  // 既に購読がある会社が押すと**新しい Customer と2本目の購読ができる**。
  // さらに webhook が `user_metadata.subscription` をまるごと上書きするので、
  // **古い購読はこちらから辿れなくなる**（2026-09-08 に判明）。
  //
  // **判定は否定リストである**（`lib/billing/subscription-state.ts`）。
  // 状態を列挙すると、列挙漏れと**Stripe が足した新しい状態**がそのまま素通りする。
  // `status = 'active'` の行だけを読んでいた 09-03 の沈黙と同じ構造なので、繰り返さない。
  if (hasStripeSubscription(ctx.subscriptionStatus)) {
    return NextResponse.json(
      {
        error: "already_subscribed",
        status: ctx.subscriptionStatus,
        // 行き先を返す。**画面側でも出さないが、ここが最後の関門である**
        portal: "/api/billing/portal",
      },
      { status: 409 },
    );
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_STANDARD;
  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN;

  if (!secret || !priceId || !origin) {
    // 設定の欠落は Sentio 側の不備である。入力のせいにしない
    return NextResponse.json(
      { error: "STRIPE_SECRET_KEY / STRIPE_PRICE_STANDARD / NEXT_PUBLIC_SITE_ORIGIN not set" },
      { status: 500 },
    );
  }

  const stripe = new Stripe(secret);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      // 購読を会社に結び付ける唯一の鍵。webhook 側はこれで会社を引く
      client_reference_id: ctx.companyId,
      ...(ctx.email ? { customer_email: ctx.email } : {}),
      success_url: `${origin}/connect?billing=done`,
      cancel_url: `${origin}/connect?billing=canceled`,
      // **billing_address_collection / customer_creation は渡さない**（CLAUDE.md の絶対規則）
    });

    if (!session.url) {
      return NextResponse.json({ error: "checkout url missing" }, { status: 500 });
    }
    return NextResponse.json({ url: session.url });
  } catch (e) {
    // 秘密を含みうるので例外そのものは返さない
    console.error("checkout session failed:", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "checkout failed" }, { status: 502 });
  }
}
