// State-summary Edge Function — regenerates company_summary (nightly)
// Gathers events/baselines/narratives, builds fixed 5-chapter summary

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

const MAX_SUMMARY_TOKENS = 4000;
const CHAPTER_KEYS = ["overview", "financial", "operations", "people", "external"] as const;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id } = await req.json();
    const supabase = getSupabaseAdmin();

    // Gather data from multiple tables
    const [eventsRes, baselinesRes, narrativesRes, entitiesRes] = await Promise.all([
      supabase.from("events").select("event_type, metrics, occurred_at")
        .eq("company_id", company_id)
        .order("occurred_at", { ascending: false }).limit(100),
      supabase.from("baselines").select("*").eq("company_id", company_id),
      supabase.from("narratives").select("*").eq("company_id", company_id),
      supabase.from("entities").select("*").eq("company_id", company_id),
    ]);

    const events = eventsRes.data || [];
    const baselines = baselinesRes.data || [];
    const narratives = narrativesRes.data || [];
    const entities = entitiesRes.data || [];

    // Build chapters
    const txnEvents = events.filter((e) => e.event_type === "transaction");
    const schedEvents = events.filter((e) => e.event_type === "schedule");
    const commEvents = events.filter((e) => e.event_type === "communication");

    const chapters = [
      { key: "overview", title: "Overview", content: `${entities.length} entities tracked. ${baselines.length} baselines configured.` },
      { key: "financial", title: "Financial", content: txnEvents.length > 0
        ? `${txnEvents.length} transactions in recent period.`
        : "(no financial data)" },
      { key: "operations", title: "Operations", content: schedEvents.length > 0
        ? `${schedEvents.length} schedule events tracked.`
        : "(no operations data)" },
      { key: "people", title: "People", content: commEvents.length > 0
        ? `${commEvents.length} communication events.`
        : "(no people data)" },
      { key: "external", title: "External", content: narratives.length > 0
        ? narratives.map((n: { content: string }) => n.content).join("; ")
        : "(no external narratives)" },
    ];

    // Token limit enforcement
    let totalTokens = chapters.reduce((sum, ch) => sum + estimateTokens(ch.content), 0);
    if (totalTokens > MAX_SUMMARY_TOKENS) {
      for (let i = chapters.length - 1; i >= 0 && totalTokens > MAX_SUMMARY_TOKENS; i--) {
        const chTokens = estimateTokens(chapters[i].content);
        const excess = totalTokens - MAX_SUMMARY_TOKENS;
        if (chTokens > excess) {
          chapters[i].content = chapters[i].content.slice(0, (chTokens - excess) * 4);
          totalTokens = MAX_SUMMARY_TOKENS;
        } else {
          chapters[i].content = "(truncated)";
          totalTokens -= chTokens - estimateTokens("(truncated)");
        }
      }
      totalTokens = chapters.reduce((sum, ch) => sum + estimateTokens(ch.content), 0);
    }

    const content = chapters.map((ch) => `## ${ch.title}\n${ch.content}`).join("\n\n");
    const now = new Date().toISOString();

    // Upsert company_summary
    const { error } = await supabase.from("company_summary").upsert({
      company_id,
      content,
      token_count: totalTokens,
      chapters,
      generated_at: now,
    }, { onConflict: "company_id" });

    if (error) throw error;

    return new Response(
      JSON.stringify({ status: "ok", company_id, token_count: totalTokens }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
