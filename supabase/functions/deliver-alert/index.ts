// Immediate alert delivery Edge Function
// Facts + link only, no interpretation (E3)
// Respects quiet hours 23:00-06:00 JST with site_down exception (E5)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

const QUIET_HOUR_EXCEPTIONS = new Set(["site_down"]);
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function isQuietHour(date: Date): boolean {
  const jstTime = new Date(date.getTime() + JST_OFFSET_MS);
  const hour = jstTime.getUTCHours();
  return hour >= 23 || hour < 6;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id, event, email, category } = await req.json();
    const supabase = getSupabaseAdmin();
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const now = new Date();

    // E5: Quiet hours check
    if (isQuietHour(now) && !QUIET_HOUR_EXCEPTIONS.has(category)) {
      // Defer to next morning — store for batch delivery
      await supabase.from("delivery_log").insert({
        id: crypto.randomUUID(),
        company_id,
        channel: "email",
        delivery_type: "alert_deferred",
        content: { event, category },
        status: "deferred",
        created_at: now.toISOString(),
      });

      return new Response(
        JSON.stringify({ status: "deferred", reason: "quiet_hours" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // E3: Render factual alert — no interpretation
    const metrics = event.metrics || {};
    const subject = metrics.status === "down"
      ? `[Alert] サイトダウン: ${metrics.url || "unknown"}`
      : `[Alert] ${category}: ${metrics.expected_date || event.occurred_at}`;

    const body = Object.entries(metrics)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    const alertContent = {
      subject,
      body: `${body}\n検出時刻: ${event.occurred_at}`,
    };

    // Store in delivery_log
    await supabase.from("delivery_log").insert({
      id: crypto.randomUUID(),
      company_id,
      channel: "email",
      delivery_type: "alert",
      content: alertContent,
      status: "sent",
      created_at: now.toISOString(),
    });

    // Send via Resend
    if (resendKey && email) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Sentio <noreply@sentio.app>",
          to: [email],
          subject: alertContent.subject,
          html: `<pre>${alertContent.body}</pre>`,
        }),
      });
    }

    return new Response(
      JSON.stringify({ status: "ok", alert: alertContent }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
