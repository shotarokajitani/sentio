// State-memory-packet Edge Function — assembles memory packet within token budget
// Unified recall mechanism for Investigator, "Ask Sentio", and weekly generation

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id, token_budget = 4000 } = await req.json();
    const supabase = getSupabaseAdmin();

    // Gather sections from DB
    const [summaryRes, baselinesRes, eventsRes, findingsRes, narrativesRes] = await Promise.all([
      supabase.from("company_summary").select("content").eq("company_id", company_id).single(),
      supabase
        .from("baselines")
        .select("metric_key, is_established, median, iqr")
        .eq("company_id", company_id)
        .eq("is_established", true),
      supabase
        .from("events")
        .select("event_id, event_type, source, metrics, occurred_at")
        .eq("company_id", company_id)
        .order("occurred_at", { ascending: false })
        .limit(20),
      supabase
        .from("findings")
        .select("what, urgency, status, evidence_event_ids")
        .eq("company_id", company_id)
        .in("status", ["open", "watching"]),
      supabase
        .from("narratives")
        .select("content, confidence")
        .eq("company_id", company_id)
        .order("updated_at", { ascending: false })
        .limit(10),
    ]);

    // Build section candidates with priorities (lower = higher priority)
    const rawSections = [
      { type: "summary", priority: 1, content: summaryRes.data?.content || "(no summary)" },
      {
        type: "baselines",
        priority: 2,
        content:
          (baselinesRes.data || [])
            .map(
              (b: { metric_key: string; median: number; iqr: number }) =>
                `${b.metric_key}: median=${b.median}, iqr=${b.iqr}`,
            )
            .join("\n") || "(no baselines)",
      },
      {
        type: "recent_events",
        priority: 3,
        content:
          (eventsRes.data || [])
            .map(
              (e: { event_type: string; source: string; occurred_at: string }) =>
                `[${e.event_type}] ${e.source} @ ${e.occurred_at}`,
            )
            .join("\n") || "(no recent events)",
      },
      {
        type: "findings",
        priority: 4,
        content:
          (findingsRes.data || [])
            .map((f: { what: string; urgency: string }) => `[${f.urgency}] ${f.what}`)
            .join("\n") || "(no open findings)",
      },
      {
        type: "narratives",
        priority: 5,
        content:
          (narrativesRes.data || [])
            .map(
              (n: { content: string; confidence: number }) =>
                `(conf=${n.confidence.toFixed(2)}) ${n.content}`,
            )
            .join("\n") || "(no narratives)",
      },
    ];

    // Assemble within budget
    const assembled = [];
    let totalTokens = 0;

    for (const section of rawSections) {
      const sectionTokens = estimateTokens(section.content);

      // Summary is always included
      if (section.type === "summary") {
        assembled.push({ ...section, tokens: sectionTokens });
        totalTokens += sectionTokens;
        continue;
      }

      const remaining = token_budget - totalTokens;
      if (remaining <= 0) break;

      if (sectionTokens <= remaining) {
        assembled.push({ ...section, tokens: sectionTokens });
        totalTokens += sectionTokens;
      } else {
        const truncated = section.content.slice(0, remaining * 4);
        const truncTokens = estimateTokens(truncated);
        assembled.push({ ...section, content: truncated, tokens: truncTokens });
        totalTokens += truncTokens;
        break;
      }
    }

    const packet = {
      company_id,
      sections: assembled,
      totalTokens,
      budgetTokens: token_budget,
      assembled_at: new Date().toISOString(),
    };

    return new Response(JSON.stringify({ status: "ok", packet }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
