// Weekly email delivery Edge Function
// Renders weekly report sections and sends via Resend
// Section order: digest → finding (0-2) → followup → stable_coverage → nudge (E1)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { renderWeeklyHtml, renderWeeklyText } from "../_shared/email-html.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id, email } = await req.json();
    const supabase = getSupabaseAdmin();
    const resendKey = Deno.env.get("RESEND_API_KEY");

    // Fetch open/watching findings
    const { data: findings } = await supabase
      .from("findings")
      .select("id, what, urgency, next_actions, status, updated_at")
      .eq("company_id", company_id)
      .in("status", ["open", "watching"])
      .order("updated_at", { ascending: false });

    // Fetch baseline coverage count
    const { data: baselines } = await supabase
      .from("baselines")
      .select("metric_key, is_established")
      .eq("company_id", company_id);

    // Fetch data source info for coverage display
    const { data: connections } = await supabase
      .from("connections")
      .select("provider, status")
      .eq("company_id", company_id);

    const { count: csvCount } = await supabase
      .from("events")
      .select("*", { count: "exact", head: true })
      .eq("company_id", company_id)
      .eq("source", "csv:accounting");

    const { count: calCount } = await supabase
      .from("events")
      .select("*", { count: "exact", head: true })
      .eq("company_id", company_id)
      .eq("source", "google_calendar");

    const established = (baselines || []).filter((b: { is_established: boolean }) => b.is_established);
    const totalBaselines = (baselines || []).length;
    const activeProviders = (connections || [])
      .filter((c: { status: string }) => c.status === "active")
      .map((c: { provider: string }) => c.provider);

    // Build sections (E1: fixed order)
    const topFindings = (findings || []).slice(0, 2);
    const findingCount = topFindings.length;

    // Build data source summary for digest
    const sources: string[] = [];
    if (activeProviders.includes("google_calendar")) sources.push(`カレンダー(${calCount ?? 0}件)`);
    if ((csvCount ?? 0) > 0) sources.push(`会計CSV(暫定集計・${csvCount}件)`);
    if (activeProviders.includes("freee")) sources.push("freee会計");
    const sourceSummary = sources.length > 0
      ? `データソース: ${sources.join("、")}。`
      : "データソース: まだ接続されていません。";

    const sections = [
      {
        type: "digest",
        content: findingCount > 0
          ? `今週は${findingCount}件のFindingがあります。${established.length}指標を追跡中です。${sourceSummary}`
          : `${sourceSummary}${totalBaselines > 0 ? `全${established.length}指標が安定しています。` : "基準値はデータ蓄積後に確立されます。"}`,
      },
      {
        type: "finding",
        content: topFindings.length > 0
          ? topFindings.map((f: { what: string }) => `- ${f.what}`).join("\n")
          : "",
      },
      {
        type: "followup",
        content: (findings || [])
          .filter((f: { status: string }) => f.status === "watching")
          .map((f: { what: string }) => `- 経過観察中: ${f.what}`)
          .join("\n") || "",
      },
      {
        type: "stable_coverage",
        content: totalBaselines > 0
          ? `${established.length}指標が平常。カバレッジ: ${totalBaselines}指標中${established.length}指標が確立済み。`
          : `カバレッジ: ${sources.length}データソース接続済み。基準値はデータ蓄積後に確立されます。`,
      },
      {
        type: "nudge",
        content: !activeProviders.includes("google_calendar") || (csvCount ?? 0) === 0
          ? "データソースを追加接続すると、より多くの指標を監視できます。"
          : (established.length < totalBaselines
            ? "データソースを追加接続すると、より多くの指標を監視できます。"
            : ""),
      },
    ];

    // Send via Resend — fail-closed: missing config is an error, not a silent skip
    if (!resendKey) {
      return new Response(
        JSON.stringify({ status: "error", reason: "RESEND_API_KEY not configured", company_id, sections }),
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
          delivery_type: "weekly",
          content: { sections },
          status: "failed",
          created_at: new Date().toISOString(),
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
          subject: "[Sentio] 今週の会社",
          html: renderWeeklyHtml(sections),
          text: renderWeeklyText(sections),
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
      delivery_type: "weekly",
      content: { sections, email_id: emailId },
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
        JSON.stringify({ status: "error", reason: sendError, company_id, sections }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ status: "ok", email_id: emailId, company_id, sections }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
