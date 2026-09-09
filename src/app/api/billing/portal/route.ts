import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getAuthedContext, unauthorized } from "@/lib/auth/company";

/**
 * Stripe のカスタマーポータルを開く（④-b・2026-09-08 決定）。
 *
 * **BU-D4「このスライスでは作らない」を改めた。** 実装はリンク1本で、
 * 解約・支払い方法の変更・請求書の取得が**すべて Stripe 側で完結する**。
 * #96 / #97 で決めた「Stripe を正とする」設計と矛盾しない。
 *
 * **自前で作らない理由。** 自前だと解約の状態を自分で持つことになり、
 * `canceled` が終端状態で順序保証が無いという 2026-09-07 の問題をもう一度背負う。
 *
 * ## 会社は**セッションからしか取らない**
 *
 * `customer` をボディで受け取ると、他社のポータルを開けてしまう。
 * 会社の識別は `getAuthedContext()` だけを使い、
 * Stripe の customer id は**購読を書いた時点の値**（`user_metadata.subscription`）を読む。
 * **ここで Stripe に検索をかけない**（メールで引くと、Stripe 側で変えられる値が鍵になる）。
 */
export async function POST() {
  const ctx = await getAuthedContext();
  if (!ctx) return unauthorized();

  const secret = process.env.STRIPE_SECRET_KEY;
  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN;

  if (!secret || !origin) {
    // 設定の欠落は Sentio 側の不備である。入力のせいにしない
    return NextResponse.json(
      { error: "STRIPE_SECRET_KEY / NEXT_PUBLIC_SITE_ORIGIN not set" },
      { status: 500 },
    );
  }

  const customerId = ctx.stripeCustomerId;
  if (!customerId) {
    // **購読が無い会社にポータルは開けない。** 画面側も購読中のときしか出さないが、
    // 直接叩かれたときにここで止める（fail-closed）
    return NextResponse.json({ error: "no_subscription" }, { status: 404 });
  }

  const stripe = new Stripe(secret);

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      // 戻り先は自分の画面。**Stripe 側の設定に頼らず、毎回こちらから渡す**
      return_url: `${origin.replace(/\/$/, "")}/connect`,
    });

    if (!session.url) {
      return NextResponse.json({ error: "portal url missing" }, { status: 500 });
    }
    return NextResponse.json({ url: session.url });
  } catch (e) {
    // 秘密を含みうるので例外そのものは返さない（checkout と同じ作法）
    console.error("billing portal failed:", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "portal failed" }, { status: 502 });
  }
}
