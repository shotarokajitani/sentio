import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
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
 * ## 会社の引き当て（2026-09-07・④-a で修正）
 *
 * 以前は `client_reference_id` **だけ**で引いていた。**これは Checkout Session にしか無い。**
 * 実物の `customer.subscription.*` の `data.object` は Subscription で、そこには無い。
 * その結果、**解約の通知は 200 で捨てられ、利用者が解約しても画面は「購読中」のまま残った。**
 *
 * 引き当ては2段構えにする。
 *
 * 1. `client_reference_id`（Checkout Session。checkout で入れた company_id そのもの）
 * 2. `customer` から `company_id_by_stripe_customer`（`00029` の SECURITY DEFINER RPC）で逆引き
 *
 * **メールアドレスでは引かない。** Stripe 側で変えられる値が会社の鍵になってしまう。
 * 逆引きは 0件でも 2件以上でも NULL を返す。**当てずっぽうで1社に書かない。**
 *
 * ## 引けなかった通知を黙って捨てない（受入 5-3）
 *
 * **捨てた事実は `billing_webhook_unresolved` に残す**（イベントIDで冪等）。
 * 応答は理由で分ける（2026-09-07 追加）。**再送で直る芽があるものだけ 503 を返す**
 * （`retrieve_failed` / `lookup_failed`。ただし `customer.subscription.*` に限る）。
 * `not_found` / `ambiguous` は再送しても直らないので 200 で受ける
 * ——**4xx/5xx を返し続けると再送が滞留するだけで、誰の役にも立たない。**
 * 再送で直ったときは、残した行を `resolved_at` で閉じる（`markResolved`）。
 * `delivery_log` は company_id が必須なので、会社を引けなかった行は入れられない。
 * 行が入ったことに気づく経路は `dispatch-daily`（毎日の集計＋運用宛メール）に置いてある。
 *
 * ## 状態の正本は Stripe から取り直した Subscription（2026-09-07・BS-D4 を撤回）
 *
 * BS-D4 は「Stripe API を呼ばない。webhook の本文だけで決める」だったが、④-a で撤回した。
 * ペイロードの `status` は**イベントごとに意味が違う**（`checkout.session.completed` の
 * `status` は `open` / `complete` / `expired` で購読の状態ではない）。実際に本番で
 * `status: "complete"` が書かれ、画面も枠も通らない状態が残った（2026-09-02 実測）。
 * **こちらで解釈した状態を持たず、Stripe から Subscription を取り直してその status を書く**
 * （受入 5-5）。BU-D2（**画面から** Stripe API を叩かない）はそのまま有効である。
 * ここは画面ではなく、通知の受け口である。
 */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret || !stripeKey || !supabaseUrl || !serviceKey) {
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

  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const object = event.data?.object ?? {};
  const eventType = typeof event.type === "string" ? event.type : "unknown";

  // **扱う種別を先に絞る。** 逆引きが入ったことで `invoice.paid` などからも会社が
  // 引けるようになった。種別を絞らないと、Invoice の status（`paid`）を購読の status として
  // 書いてしまう。**知らない種別は何もせずに 200 で受ける**（記録もしない。異常ではない）
  if (!HANDLED_TYPES.has(eventType)) {
    return NextResponse.json({ status: "ignored", reason: "unhandled_type" });
  }

  // 決済が済んでいないセッション。**払っていない人を購読中にしない**（BS-D2）。
  // 会社を引く前に落とす。異常ではないので記録もしない
  if (eventType === "checkout.session.completed" && object.payment_status !== "paid") {
    return NextResponse.json({ status: "ignored", reason: "unpaid" });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const customerId = typeof object.customer === "string" ? object.customer : null;

  const lookup = await resolveCompanyFromStripe(admin, object, customerId);
  if (lookup.reason !== undefined) {
    const recorded = await recordUnresolved(admin, event, eventType, customerId, lookup.reason);
    // **記録すらできなければ 200 で流さない。** 再送が来れば次の機会がある
    if (!recorded) return NextResponse.json({ error: "record failed" }, { status: 500 });
    return unresolvedResponse(eventType, lookup.reason, "no_company");
  }
  const companyId = lookup.companyId;

  const stripe = new Stripe(stripeKey);
  const resolved = await resolveSubscription(stripe, eventType, object);

  if (!resolved) {
    const recorded = await recordUnresolved(admin, event, eventType, customerId, "retrieve_failed");
    if (!recorded) return NextResponse.json({ error: "record failed" }, { status: 500 });
    // **推測で status を書かない。** 書かなかった事実は上の表に残っている
    return unresolvedResponse(eventType, "retrieve_failed", "stripe_unavailable");
  }

  const { error } = await admin.auth.admin.updateUserById(companyId, {
    user_metadata: {
      subscription: {
        plan_id: STANDARD_PLAN.id,
        stripe_customer_id: resolved.customerId,
        stripe_subscription_id: resolved.subscriptionId,
        status: resolved.status,
      },
    },
  });

  if (error) {
    console.error("subscription update failed:", error.message);
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }

  // **再送で直ったら、残した行を解決済みにする。**
  // ここが無いと、再送で直っても行が残り続け、毎朝のメールが鳴りっぱなしになる。
  // **鳴りっぱなしの警報は、その日から無視される対象になる。**
  await markResolved(admin, event, eventType, customerId);

  return NextResponse.json({ status: "ok", type: eventType });
}

/**
 * 適用する種別。**ここに無い種別は触らない。**
 *
 * `customer.subscription.created` を入れてあるのは、Checkout を経ずに Stripe 側で
 * 購読が作られた場合に取りこぼさないため。`invoice.*` は入れない
 * （Invoice の `status` は購読の状態ではない）。
 */
const HANDLED_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/**
 * 会社を引く。**引けなければ NULL。** 呼び出し側が記録して 200 で返す。
 *
 * 名前に `FromStripe` を付けているのは、`_shared/caller.ts` の `resolveCompanyId`
 * （呼び出し元スコープの解決）と**別物**だからである。同名にすると
 * `check:dual-impl` が二重実装として拾い、宣言台帳に嘘の1件が載る。
 *
 * `client_reference_id` を優先するのは、それが checkout で**こちらが入れた値**だからである。
 * 逆引きは Stripe 側の状態（metadata に customer id が入っていること）に依存する。
 */
async function resolveCompanyFromStripe(
  admin: SupabaseClient,
  object: Record<string, unknown>,
  customerId: string | null,
): Promise<CompanyLookup> {
  if (typeof object.client_reference_id === "string" && object.client_reference_id) {
    return { companyId: object.client_reference_id };
  }
  if (!customerId) return { reason: "not_found" };

  const { data, error } = await admin.rpc("company_id_by_stripe_customer", {
    p_customer_id: customerId,
  });

  if (error) {
    // **「引けなかった」と「引く経路が壊れた」を混ぜない。** 対処が違う
    console.error("company_id_by_stripe_customer failed:", error.message);
    return { reason: "lookup_failed" };
  }

  const result = (data ?? {}) as { company_id?: unknown; matches?: unknown };
  if (typeof result.company_id === "string" && result.company_id) {
    return { companyId: result.company_id };
  }

  // **0件と2件以上を同じ行に見せない。** 前者は「checkout を経ずに作られた購読」を疑う話、
  // 後者は「同じ customer id が2社に付いている」というデータの壊れである
  const matches = typeof result.matches === "number" ? result.matches : 0;
  return { reason: matches > 1 ? "ambiguous" : "not_found" };
}

/**
 * `billing_webhook_unresolved.reason` の取りうる値。
 * **`00029` の CHECK 制約と同じ集合である。片方を変えたらもう片方も変える**
 * （`DELIVERY_STATUSES` と `00024` の関係と同じ作法）。
 */
type UnresolvedReason = "not_found" | "ambiguous" | "lookup_failed" | "retrieve_failed";

/** 会社を引いた結果。**引けなかったときは「なぜ」を必ず持って返る** */
type CompanyLookup =
  | { companyId: string; reason?: undefined }
  | { companyId?: undefined; reason: Exclude<UnresolvedReason, "retrieve_failed"> };

interface ResolvedSubscription {
  status: string;
  customerId: string;
  subscriptionId: string;
}

/**
 * Stripe から Subscription を取り直し、その `status` を正本にする（受入 5-5 / 4-6）。
 *
 * **取り直せなかったときは NULL を返し、呼び出し側が「書かない」に倒す。**
 * 唯一の例外が `customer.subscription.deleted` である。この種別は
 * **イベントの型そのものが「消えた」という事実**なので、取り直せなくても `canceled` を書く。
 * ペイロードの `status` を信じているのではない。**種別を信じている。**
 * ここで書かないほうに倒すと、解約した利用者が期末を越えて「購読中」のまま残る。
 */
async function resolveSubscription(
  stripe: Stripe,
  eventType: string,
  object: Record<string, unknown>,
): Promise<ResolvedSubscription | null> {
  const subscriptionId =
    eventType === "checkout.session.completed"
      ? typeof object.subscription === "string"
        ? object.subscription
        : null
      : typeof object.id === "string"
        ? object.id
        : null;

  const fallbackCustomer = typeof object.customer === "string" ? object.customer : "";

  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      return {
        status: sub.status,
        customerId: typeof sub.customer === "string" ? sub.customer : fallbackCustomer,
        subscriptionId: sub.id,
      };
    } catch (e) {
      // 秘密を含みうるので例外そのものは載せない
      console.error("subscription retrieve failed:", e instanceof Error ? e.message : "unknown");
    }
  }

  if (eventType === "customer.subscription.deleted") {
    return {
      status: "canceled",
      customerId: fallbackCustomer,
      subscriptionId: subscriptionId ?? "",
    };
  }

  return null;
}

/**
 * 引けなかった通知への応答を決める。**再送で直る芽があるものだけ 5xx を返す。**
 *
 * | reason | 応答 | なぜ |
 * | --- | --- | --- |
 * | `retrieve_failed` / `lookup_failed` | **503** | 一時的な失敗。**Stripe の再送で直りうる** |
 * | `not_found` / `ambiguous` | 200 | 再送しても直らない。**人が対処するまで変わらない** |
 *
 * **`invoice.*` では、どの理由でも 5xx を返さない**（下の `shouldRetry`）。
 * Stripe の文献に「`invoice.created` へ成功応答が返らないと、自動収納の請求ファイナライズが
 * 最大72時間遅れる」とある。**別イベントの 5xx が invoice 系に波及するかは未確認**だが、
 * 対象を絞れば危険そのものが消える（`docs/spec/07_open_items.md` に未確認として登録）。
 *
 * 5xx を返すことには副次的な利点がある。**失敗が続けば Stripe から
 * 「webhook が失敗している」という通知が届く。気づく経路がもう1つ増える。**
 */
function unresolvedResponse(
  eventType: string,
  reason: UnresolvedReason,
  bodyReason: string,
): NextResponse {
  if (shouldRetry(eventType, reason)) {
    // 本文は Stripe に読まれない。**状態コードだけが再送の合図である**
    return NextResponse.json({ status: "retry", reason: bodyReason }, { status: 503 });
  }
  return NextResponse.json({ status: "ignored", reason: bodyReason });
}

/**
 * 再送させるか。**`customer.subscription.*` 以外は必ず false。**
 *
 * `customer.subscription.deleted` がここに来ることは無い
 * （取り直せなくても `canceled` を書いて解決するため）。したがって
 * **解約通知に 5xx を返す経路は構造的に存在しない。**
 */
function shouldRetry(eventType: string, reason: UnresolvedReason): boolean {
  if (!eventType.startsWith("customer.subscription.")) return false;
  return reason === "retrieve_failed" || reason === "lookup_failed";
}

/**
 * 冪等キー。**`recordUnresolved` と `markResolved` が同じ鍵を使う**ことが要件である。
 * 片方だけ変えると、残した行を解決済みにできなくなる。
 */
function unresolvedKey(event: { id?: string }, eventType: string, customerId: string | null) {
  return typeof event.id === "string" && event.id
    ? event.id
    : `no-event-id:${eventType}:${customerId ?? "unknown"}`;
}

/**
 * 再送で直ったイベントの行を解決済みにする。
 *
 * **同じイベントIDの行だけを閉じる。** 同じ会社の別イベントで残った行は閉じない
 * ——直った証拠があるのはこのイベントについてだけだからである
 * （残った行は手順書 `docs/runbooks/2026-09-07_billing-webhook-unresolved.md` で人が閉じる）。
 *
 * **失敗しても書き込み済みの購読は巻き戻さない。** ここで 5xx を返すと、
 * 既に反映が済んでいるのに Stripe が再送し続けることになる。失敗はログに残す。
 */
async function markResolved(
  admin: SupabaseClient,
  event: { id?: string },
  eventType: string,
  customerId: string | null,
): Promise<void> {
  const { error } = await admin
    .from("billing_webhook_unresolved")
    .update({ resolved_at: new Date().toISOString() })
    .eq("stripe_event_id", unresolvedKey(event, eventType, customerId))
    .is("resolved_at", null);

  if (error) {
    console.error("billing_webhook_unresolved resolve failed:", error.message);
  }
}

/**
 * 引けなかった／取り直せなかったイベントを残す（受入 5-3・5-4）。
 *
 * **冪等キーは Stripe のイベントID。** `customer.subscription.updated` は繰り返し届くので、
 * 同じ入力で2回処理しても行は増えない（`ignoreDuplicates`）。
 * イベントIDが無い本文は Stripe からは来ないが、来たときに黙って落とさないよう、
 * 種別と customer から**決定的な**代替キーを組む（それでも二重には入らない）。
 *
 * **ペイロード全体は保存しない。** 追跡に要るのは種別・イベントID・受信時刻・生の識別子だけである。
 */
async function recordUnresolved(
  admin: SupabaseClient,
  event: { id?: string },
  eventType: string,
  customerId: string | null,
  reason: UnresolvedReason,
): Promise<boolean> {
  const { error } = await admin.from("billing_webhook_unresolved").upsert(
    {
      stripe_event_id: unresolvedKey(event, eventType, customerId),
      event_type: eventType,
      reason,
      stripe_customer_id: customerId,
    },
    { onConflict: "stripe_event_id", ignoreDuplicates: true },
  );

  if (error) {
    console.error("billing_webhook_unresolved insert failed:", error.message);
    return false;
  }

  // ログにも残す（受入 5-3 の「ログとレコードの両方」。表は気づく経路、ログは追跡用）
  console.error(`billing webhook unresolved: type=${eventType} reason=${reason}`);
  return true;
}
