// Daily pulse Edge Function — 3 lines, 10 seconds
// Line 1-2: yesterday's facts. Line 3: state (normal/watching). Line 4: anomaly day only

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { renderPulseHtml, renderPulseText } from "../_shared/email-html.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id, email } = await req.json();
    const supabase = getSupabaseAdmin();
    const resendKey = Deno.env.get("RESEND_API_KEY");

    // Yesterday's events
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dayBefore = new Date(yesterday.getTime() - 24 * 60 * 60 * 1000);

    const { data: events } = await supabase
      .from("events")
      .select("event_type, source, metrics")
      .eq("company_id", company_id)
      .gte("occurred_at", dayBefore.toISOString())
      .lte("occurred_at", yesterday.toISOString());

    // Open findings for state line
    const { data: findings } = await supabase
      .from("findings")
      .select("what, status")
      .eq("company_id", company_id)
      .in("status", ["open", "watching"]);

    const watchingCount = (findings || []).filter(
      (f: { status: string }) => f.status === "watching",
    ).length;

    // Build pulse lines
    const eventCount = (events || []).length;
    const lines = [
      `昨日: ${eventCount}件のイベントを記録`,
      eventCount > 0
        ? `主な種別: ${[...new Set((events || []).map((e: { event_type: string }) => e.event_type))].join(", ")}`
        : "特記事項なし",
      watchingCount > 0 ? `状態: ${watchingCount}件を経過観察中` : "状態: 平常",
    ];

    // Line 4: anomaly day only
    const hasAnomaly = (findings || []).some((f: { status: string }) => f.status === "open");
    if (hasAnomaly) {
      lines.push(
        `注意: ${(findings || []).filter((f: { status: string }) => f.status === "open").length}件のFindingが未対応`,
      );
    }

    const pulseText = lines.join("\n");

    // Send via Resend — fail-closed: missing config is an error, not a silent skip
    if (!resendKey) {
      return new Response(
        JSON.stringify({
          status: "error",
          reason: "RESEND_API_KEY not configured",
          company_id,
          pulse: lines,
        }),
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
          delivery_type: "pulse",
          content: { lines },
          status: "failed",
          created_at: new Date().toISOString(),
        });
        return new Response(
          JSON.stringify({
            status: "error",
            reason: "RESEND_FROM未設定。サンドボックス送信を防止しました。",
          }),
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
          subject: "[Sentio] デイリーパルス",
          html: renderPulseHtml(lines),
          text: renderPulseText(lines),
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
      delivery_type: "pulse",
      content: { lines, email_id: emailId },
      status: emailStatus,
      created_at: new Date().toISOString(),
    });

    if (logErr) {
      return new Response(
        JSON.stringify({ error: `delivery_log insert failed: ${logErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (emailStatus === "failed") {
      return new Response(
        JSON.stringify({ status: "error", reason: sendError, company_id, pulse: lines }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ status: "ok", email_id: emailId, company_id, pulse: lines }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
