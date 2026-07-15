// Weekly email delivery Edge Function
// Renders weekly report sections and sends via Resend
// Section order: digest → finding (0-2) → followup → stable_coverage → nudge (E1)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

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

    const established = (baselines || []).filter((b: { is_established: boolean }) => b.is_established);
    const totalBaselines = (baselines || []).length;

    // Build sections (E1: fixed order)
    const topFindings = (findings || []).slice(0, 2);
    const findingCount = topFindings.length;

    const sections = [
      {
        type: "digest",
        content: findingCount > 0
          ? `今週は${findingCount}件のFindingがあります。${established.length}指標を追跡中です。`
          : `全${established.length}指標が安定しています。`,
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
        // E2: zero-finding week shows stable + coverage count
        content: `${established.length}指標が平常。カバレッジ: ${totalBaselines}指標中${established.length}指標が確立済み。`,
      },
      {
        type: "nudge",
        content: established.length < totalBaselines
          ? "データソースを追加接続すると、より多くの指標を監視できます。"
          : "",
      },
    ];

    // Store in delivery_log
    await supabase.from("delivery_log").insert({
      id: crypto.randomUUID(),
      company_id,
      channel: "email",
      delivery_type: "weekly",
      content: { sections },
      status: "sent",
      created_at: new Date().toISOString(),
    });

    // Send via Resend
    if (resendKey && email) {
      const html = sections
        .filter((s) => s.content)
        .map((s) => `<div><strong>${s.type}</strong><p>${s.content.replace(/\n/g, "<br>")}</p></div>`)
        .join("<hr>");

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Sentio <noreply@sentio.app>",
          to: [email],
          subject: "[Sentio] 今週の会社",
          html: `<h1>今週の会社</h1>${html}`,
        }),
      });
    }

    return new Response(
      JSON.stringify({ status: "ok", company_id, sections }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
