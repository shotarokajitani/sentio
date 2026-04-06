import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@13.10.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { initSentry, captureError } from "../_shared/sentry.ts";

initSentry("stripe-webhook");

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("署名がありません", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const body = await req.text();
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      WEBHOOK_SECRET,
    );
  } catch (err) {
    captureError(err as Error, {
      extra: { reason: "webhook_signature_verification_failed" },
    });
    return new Response("署名検証に失敗しました", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(
          event.data.object as Stripe.Checkout.Session,
        );
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
        );
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(
          event.data.object as Stripe.Subscription,
        );
        break;
      default:
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error, { extra: { event_type: event.type } });
    return new Response(
      JSON.stringify({ error: "Webhook処理に失敗しました" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId;
  const plan = session.metadata?.plan;
  if (!userId || !plan) return;

  const { data: company } = await supabase
    .from("companies")
    .select("id")
    .eq("user_id", userId)
    .single();

  if (!company) return;

  const subscriptionId = session.subscription as string;
  const customerId = session.customer as string;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const { error } = await supabase.from("subscriptions").upsert(
    {
      company_id: company.id,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      plan,
      status: "active",
      current_period_end: new Date(
        subscription.current_period_end * 1000,
      ).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id" },
  );

  if (error) {
    throw new Error(`subscriptions upsert failed: ${error.message}`);
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const { error } = await supabase
    .from("subscriptions")
    .update({
      status: "canceled",
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    throw new Error(`subscription delete update failed: ${error.message}`);
  }
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const priceId = subscription.items.data[0]?.price.id;
  const plan = resolvePlanFromPriceId(priceId);

  const { error } = await supabase
    .from("subscriptions")
    .update({
      plan: plan ?? undefined,
      status: subscription.status === "active" ? "active" : subscription.status,
      current_period_end: new Date(
        subscription.current_period_end * 1000,
      ).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    throw new Error(`subscription update failed: ${error.message}`);
  }
}

function resolvePlanFromPriceId(priceId: string): string | null {
  const priceMap: Record<string, string> = {
    [Deno.env.get("STRIPE_PRICE_STARTER_MONTHLY")!]: "starter",
    [Deno.env.get("STRIPE_PRICE_STARTER_YEARLY")!]: "starter",
    [Deno.env.get("STRIPE_PRICE_GROWTH_MONTHLY")!]: "growth",
    [Deno.env.get("STRIPE_PRICE_GROWTH_YEARLY")!]: "growth",
    [Deno.env.get("STRIPE_PRICE_SCALE_MONTHLY")!]: "scale",
    [Deno.env.get("STRIPE_PRICE_SCALE_YEARLY")!]: "scale",
  };
  return priceMap[priceId] ?? null;
}
