// State-narratives Edge Function — handles narrative upsert with confidence decay
// 3 state-update paths only: (a) baselines recalc, (b) narratives upsert, (c) summary regen

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { errorResponse, mustData, mustMaybe, mustOk } from "../_shared/db.ts";

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

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const {
      company_id: bodyCompanyId,
      key,
      content,
      source_event_id,
      is_correction,
    } = await req.json();

    const scope = resolveCompanyId(caller.caller, bodyCompanyId);
    if (!scope.ok) return scope.response;
    const company_id = scope.companyId;

    const supabase = getSupabaseAdmin();
    const now = new Date();
    const nowIso = now.toISOString();

    // Check for existing narrative
    const existing = await mustMaybe(
      supabase
        .from("narratives")
        .select("id, content, confidence, last_confirmed_at")
        .eq("company_id", company_id)
        .eq("key", key)
        .maybeSingle(),
      "state-narratives: existing",
    );

    if (is_correction && existing) {
      // Correction: immediate confidence reduction
      await mustOk(
        supabase
          .from("narratives")
          .update({
            content,
            confidence: 0.0,
            source_event_id,
            updated_at: nowIso,
          })
          .eq("company_id", company_id)
          .eq("key", key),
        "state-narratives: correction update",
      );

      return new Response(JSON.stringify({ status: "ok", action: "corrected", key }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (existing) {
      // Update existing — refresh confidence to 1.0
      await mustOk(
        supabase
          .from("narratives")
          .update({
            content,
            confidence: 1.0,
            source_event_id,
            updated_at: nowIso,
          })
          .eq("company_id", company_id)
          .eq("key", key),
        "state-narratives: update",
      );

      return new Response(JSON.stringify({ status: "ok", action: "updated", key }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create new
    await mustOk(
      supabase.from("narratives").insert({
        company_id,
        key,
        content,
        confidence: 1.0,
        source_event_id,
        updated_at: nowIso,
      }),
      "state-narratives: insert",
    );

    return new Response(JSON.stringify({ status: "ok", action: "created", key }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});
