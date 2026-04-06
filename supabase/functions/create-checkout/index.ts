import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@13.10.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { initSentry, captureError } from "../_shared/sentry.ts";

initSentry("create-checkout");

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const PRICE_IDS: Record<string, Record<string, string>> = {
  starter: {
    monthly: Deno.env.get("STRIPE_PRICE_STARTER_MONTHLY")!,
    yearly: Deno.env.get("STRIPE_PRICE_STARTER_YEARLY")!,
  },
  growth: {
    monthly: Deno.env.get("STRIPE_PRICE_GROWTH_MONTHLY")!,
    yearly: Deno.env.get("STRIPE_PRICE_GROWTH_YEARLY")!,
  },
  scale: {
    monthly: Deno.env.get("STRIPE_PRICE_SCALE_MONTHLY")!,
    yearly: Deno.env.get("STRIPE_PRICE_SCALE_YEARLY")!,
  },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization")! },
        },
      },
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "認証が必要です" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { plan, billing } = await req.json();

    if (!plan || !PRICE_IDS[plan]) {
      return new Response(JSON.stringify({ error: "無効なプランです" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const billingCycle = billing === "yearly" ? "yearly" : "monthly";
    const priceId = PRICE_IDS[plan][billingCycle];

    const origin = req.headers.get("origin") || "https://www.sentio-ai.jp";

    // ⚠️ billing_address_collection: 絶対に追加しない（500エラーの原因）
    // ⚠️ customer_creation: 絶対に追加しない（サブスクモードで競合発生）
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/app.html?checkout=success`,
      cancel_url: `${origin}/app.html?checkout=cancel`,
      metadata: { userId: user.id, plan },
      locale: "ja",
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error, { extra: { function: "create-checkout" } });
    return new Response(
      JSON.stringify({ error: "チェックアウトの作成に失敗しました" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
