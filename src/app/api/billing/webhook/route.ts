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
 *
 * ## `data.object` の型はイベントごとに違う（2026-09-03 修正）
 *
 * **同じ `status` という名前でも、意味が違う。**
 * `checkout.session.completed` の `data.object` は **Checkout Session** で、
 * その `status` は `open` / `complete` / `expired` の3値——**購読の状態ではない。**
 * `customer.subscription.*` の `data.object` は **Subscription** で、
 * こちらの `status` が購読の状態そのものである。
 *
 * 当初は `object.status` をそのまま書いていたため、本番で購読を1回通したとき
 * `status: "complete"` が書かれた（2026-09-02 19:05 UTC 実測）。
 * `"complete"` は画面の判定（`connect-client.tsx`）も枠の判定（`lib/billing/plan.ts`）も
 * 通らないので、**払っても購読ボタンが消えず、枠も増えない。待っても直らなかった。**
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
  const companyId =
    typeof object.client_reference_id === "string" ? object.client_reference_id : null;

  // 会社を引けない通知は**何もせずに 200 で受け取る。**
  // 4xx を返すと Stripe が再送を続け、通知が滞留する
  if (!companyId) {
    return NextResponse.json({ status: "ignored", reason: "no_company" });
  }

  const resolved = resolveStatus(event.type, object);

  // 決済が済んでいないセッション。**払っていない人を購読中にしない**（BS-D2）。
  // `no_company` と同じく 200 で受ける。4xx を返すと Stripe が再送を続ける
  if (resolved.ignore) {
    return NextResponse.json({ status: "ignored", reason: resolved.ignore });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  const { error } = await admin.auth.admin.updateUserById(companyId, {
    user_metadata: {
      subscription: {
        plan_id: STANDARD_PLAN.id,
        stripe_customer_id: typeof object.customer === "string" ? object.customer : "",
        stripe_subscription_id: typeof object.subscription === "string" ? object.subscription : "",
        status: resolved.status,
      },
    },
  });

  if (error) {
    console.error("subscription update failed:", error.message);
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }

  return NextResponse.json({ status: "ok", type: event.type ?? "unknown" });
}

/**
 * 保存する購読の状態を決める。**`object.status` を無条件に信用しない**（BS-D1）。
 *
 * 判定の材料は webhook の本文だけである。**Stripe API は呼ばない**（BS-D4 / BU-D2）。
 * 呼べば正確になるが、通知の処理が Stripe の応答時間と可用性に依存する。
 *
 * `ignore` が返るのは「受け取ったが書かない」場合で、呼び出し側は 200 で返す。
 */
function resolveStatus(
  type: string | undefined,
  object: Record<string, unknown>,
): { status: string; ignore?: undefined } | { ignore: string; status?: undefined } {
  // 解約は購読を消すのではなく status に残す。**いつ止まったかが分からなくなる**
  if (type === "customer.subscription.deleted") return { status: "canceled" };

  if (type === "checkout.session.completed") {
    // **Checkout Session の `status` は使わない。** `complete` は決済画面が閉じたことを
    // 表すだけで、購読の状態ではない。ここで書くべき値は `active` の1つに定まる
    //
    // `no_payment_required`（0円）も書かない。Stripe 側の trial を使い始めたら
    // ここを見直すことになるが、**その判断自体が未確定**である
    // （`docs/spec/07_open_items.md`「`trialing` を購読中と見なすか」）
    if (object.payment_status !== "paid") return { ignore: "unpaid" };
    return { status: "active" };
  }

  // `customer.subscription.*` の `data.object` は Subscription で、
  // その `status` は購読の状態そのものである。**そのまま使う**（BS-D3）。
  // ただし Subscription は `client_reference_id` を持たないため、
  // 現状ここに到達する通知は無い（会社を引けず、手前で 200 のまま返る）
  return { status: typeof object.status === "string" ? object.status : "active" };
}
