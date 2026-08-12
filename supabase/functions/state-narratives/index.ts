// State-narratives Edge Function — handles narrative upsert with confidence decay
// 3 state-update paths only: (a) baselines recalc, (b) narratives upsert, (c) summary regen

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

const HALF_LIFE_DAYS = 30;
const DECAY_LAMBDA = Math.LN2 / HALF_LIFE_DAYS;

function decayConfidence(updatedAt: string, now: Date): number {
  const daysDiff = (now.getTime() - new Date(updatedAt).getTime()) / (24 * 60 * 60 * 1000);
  if (daysDiff <= 0) return 1.0;
  return Math.exp(-DECAY_LAMBDA * daysDiff);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id, key, content, source_event_id, is_correction } = await req.json();
    const supabase = getSupabaseAdmin();
    const now = new Date();
    const nowIso = now.toISOString();

    // Check for existing narrative
    const { data: existing } = await supabase
      .from("narratives")
      .select("*")
      .eq("company_id", company_id)
      .eq("key", key)
      .single();

    if (is_correction && existing) {
      // Correction: immediate confidence reduction
      const { error } = await supabase.from("narratives").update({
        content,
        confidence: 0.0,
        source_event_id,
        updated_at: nowIso,
      }).eq("company_id", company_id).eq("key", key);

      if (error) throw error;

      return new Response(
        JSON.stringify({ status: "ok", action: "corrected", key }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (existing) {
      // Update existing — refresh confidence to 1.0
      const { error } = await supabase.from("narratives").update({
        content,
        confidence: 1.0,
        source_event_id,
        updated_at: nowIso,
      }).eq("company_id", company_id).eq("key", key);

      if (error) throw error;

      return new Response(
        JSON.stringify({ status: "ok", action: "updated", key }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Create new
    const { error } = await supabase.from("narratives").insert({
      company_id,
      key,
      content,
      confidence: 1.0,
      source_event_id,
      updated_at: nowIso,
    });

    if (error) throw error;

    return new Response(
      JSON.stringify({ status: "ok", action: "created", key }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
