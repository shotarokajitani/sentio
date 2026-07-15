// Scanner Edge Function — runs 5 scans against events + baselines
// LLM-free, rule-based detection (daily via pg_cron)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

interface ScanCandidate {
  scanType: string;
  source: string;
  suggestedUrgency: string;
  evidence_event_ids: string[];
  description: string;
  score: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id } = await req.json();
    const supabase = getSupabaseAdmin();

    // Fetch recent events (last 90 days)
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: events } = await supabase
      .from("events")
      .select("event_id, occurred_at, event_type, source, metrics, sensitivity, company_id")
      .or(`company_id.eq.${company_id},company_id.is.null`)
      .gte("occurred_at", cutoff)
      .order("occurred_at", { ascending: false });

    // Fetch baselines
    const { data: baselines } = await supabase
      .from("baselines")
      .select("*")
      .eq("company_id", company_id);

    // Fetch known explanations for suppression
    const { data: knownExplanations } = await supabase
      .from("known_explanations")
      .select("pattern, explanation")
      .eq("company_id", company_id);

    const candidates: ScanCandidate[] = [];
    const established = (baselines || []).filter((b: { is_established: boolean }) => b.is_established);

    // 1. Deviation scan
    for (const event of events || []) {
      if (event.event_type !== "transaction") continue;
      const revenue = (event.metrics as Record<string, unknown>)?.revenue as number | undefined;
      if (revenue === undefined) continue;

      for (const bl of established) {
        if (bl.metric_key !== "revenue") continue;
        const lowerBound = bl.p25 - 1.5 * bl.iqr;
        const upperBound = bl.p75 + 1.5 * bl.iqr;
        if (revenue < lowerBound || revenue > upperBound) {
          candidates.push({
            scanType: "deviation",
            source: "transaction",
            suggestedUrgency: "weekly",
            evidence_event_ids: [event.event_id],
            description: `Revenue ${revenue} outside [${lowerBound}, ${upperBound}]`,
            score: Math.abs(revenue - bl.median) / bl.iqr,
          });
        }
      }
    }

    // 2. Deadline scan
    for (const event of events || []) {
      if ((event.metrics as Record<string, unknown>)?.is_overdue === true) {
        candidates.push({
          scanType: "deadline",
          source: "deadline",
          suggestedUrgency: "immediate",
          evidence_event_ids: [event.event_id],
          description: `Overdue: ${(event.metrics as Record<string, unknown>)?.expected_date || "unknown"}`,
          score: 1,
        });
      }
    }

    // 3. External scan (S0)
    for (const event of events || []) {
      if (event.event_type === "external" && event.sensitivity === "S0") {
        candidates.push({
          scanType: "external",
          source: "external",
          suggestedUrgency: "monthly",
          evidence_event_ids: [event.event_id],
          description: `External: ${(event.metrics as Record<string, unknown>)?.relevance || event.source}`,
          score: 0.5,
        });
      }
    }

    // 4. Monitor scan (site down → immediate)
    for (const event of events || []) {
      if (event.event_type === "monitor") {
        const status = (event.metrics as Record<string, unknown>)?.status;
        if (status === "down") {
          candidates.push({
            scanType: "deviation",
            source: "monitor",
            suggestedUrgency: "immediate",
            evidence_event_ids: [event.event_id],
            description: `Site down: ${(event.metrics as Record<string, unknown>)?.url || "unknown"}`,
            score: 10,
          });
        }
      }
    }

    // Store high-score candidates for Investigator pickup
    // Immediate candidates bypass Investigator (fact alert fast path)
    const immediates = candidates.filter((c) => c.suggestedUrgency === "immediate");
    const forInvestigation = candidates
      .filter((c) => c.suggestedUrgency !== "immediate")
      .sort((a, b) => b.score - a.score);

    return new Response(
      JSON.stringify({
        status: "ok",
        company_id,
        total_candidates: candidates.length,
        immediate_count: immediates.length,
        investigation_count: forInvestigation.length,
        immediates,
        candidates: forInvestigation,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
