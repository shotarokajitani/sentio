// Immediate alert delivery Edge Function
// Facts + link only, no interpretation (E3)
// Respects quiet hours 23:00-06:00 JST with site_down exception (E5)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { renderAlertHtml, renderAlertText } from "../_shared/email-html.ts";

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
      const { error: deferErr } = await supabase.from("delivery_log").insert({
        id: crypto.randomUUID(),
        company_id,
        channel: "email",
        delivery_type: "alert_deferred",
        content: { event, category },
        status: "deferred",
        created_at: now.toISOString(),
      });

      if (deferErr) {
        return new Response(
          JSON.stringify({ error: `delivery_log insert failed: ${deferErr.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

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

    // Send via Resend — fail-closed: missing config is an error, not a silent skip
    if (!resendKey) {
      return new Response(
        JSON.stringify({ status: "error", reason: "RESEND_API_KEY not configured", alert: alertContent }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let emailStatus = "skipped";
    let emailId: string | undefined;
    let sendError: string | undefined;

    if (email) {
      const resendFrom = Deno.env.get("RESEND_FROM");
      if (!resendFrom) {
        await supabase.from("delivery_log").insert({
          id: crypto.randomUUID(),
          company_id,
          channel: "email",
          delivery_type: "alert",
          content: alertContent,
          status: "failed",
          created_at: now.toISOString(),
        });
        return new Response(
          JSON.stringify({ status: "error", reason: "RESEND_FROM未設定。サンドボックス送信を防止しました。" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: resendFrom,
          to: [email],
          subject: alertContent.subject,
          html: renderAlertHtml(alertContent.subject, alertContent.body),
          text: renderAlertText(alertContent.subject, alertContent.body),
        }),
      });

      const resendBody = await resendRes.json().catch(() => ({}));

      if (resendRes.ok) {
        emailId = resendBody.id;
        emailStatus = "sent";
        console.log(`Resend OK: email_id=${emailId}`);
      } else {
        emailStatus = "failed";
        sendError = `Resend ${resendRes.status}: ${resendBody.message || JSON.stringify(resendBody)}`;
        console.error(`Resend failed: ${sendError}`);
      }
    }

    // Store in delivery_log (actual send status)
    const { error: logErr } = await supabase.from("delivery_log").insert({
      id: crypto.randomUUID(),
      company_id,
      channel: "email",
      delivery_type: "alert",
      content: { ...alertContent, email_id: emailId },
      status: emailStatus,
      created_at: now.toISOString(),
    });

    if (logErr) {
      return new Response(
        JSON.stringify({ error: `delivery_log insert failed: ${logErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (emailStatus === "failed") {
      return new Response(
        JSON.stringify({ status: "error", reason: sendError, alert: alertContent }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ status: "ok", email_id: emailId, alert: alertContent }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
