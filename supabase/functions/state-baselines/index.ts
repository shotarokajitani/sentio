// State-baselines Edge Function — reads events, calculates baselines, upserts
// LLM-free, deterministic recalculation (nightly via pg_cron)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

const MIN_OBS = 5;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id } = await req.json();
    const supabase = getSupabaseAdmin();

    // Fetch transaction events for this company
    const { data: events, error } = await supabase
      .from("events")
      .select("event_id, occurred_at, event_type, metrics")
      .eq("company_id", company_id)
      .eq("event_type", "transaction")
      .order("occurred_at", { ascending: true });

    if (error) throw error;

    // Extract revenue values
    const revenues = (events || [])
      .map((e) => (e.metrics as Record<string, unknown>)?.revenue as number)
      .filter((v): v is number => typeof v === "number");

    const isEstablished = revenues.length >= MIN_OBS;
    const sorted = [...revenues].sort((a, b) => a - b);
    const median = isEstablished
      ? sorted.length % 2 === 1
        ? sorted[Math.floor(sorted.length / 2)]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : null;

    const p25 = isEstablished ? percentile(sorted, 25) : null;
    const p75 = isEstablished ? percentile(sorted, 75) : null;

    const now = new Date().toISOString();

    // Upsert baseline
    const { error: upsertError } = await supabase.from("baselines").upsert(
      {
        company_id,
        metric_key: "revenue",
        is_established: isEstablished,
        median,
        iqr: p25 !== null && p75 !== null ? p75 - p25 : null,
        p25,
        p75,
        observation_count: revenues.length,
        updated_at: now,
      },
      { onConflict: "company_id,metric_key" },
    );

    if (upsertError) throw upsertError;

    return new Response(
      JSON.stringify({
        status: "ok",
        company_id,
        is_established: isEstablished,
        observation_count: revenues.length,
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
