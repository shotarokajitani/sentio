// State-baselines Edge Function — reads events, calculates baselines, upserts
// LLM-free, deterministic recalculation (nightly via pg_cron)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { mustData, mustOk, errorResponse } from "../_shared/db.ts";
import {
  BASELINE_NATURAL_KEY,
  REVENUE_BASELINE,
  buildBaselineStats,
} from "../_shared/baseline-stats.ts";

const MIN_OBS = 5;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const { company_id: bodyCompanyId } = await req.json();

    const scope = resolveCompanyId(caller.caller, bodyCompanyId);
    if (!scope.ok) return scope.response;
    const company_id = scope.companyId;

    const supabase = getSupabaseAdmin();

    // Fetch transaction events for this company
    const events = await mustData(
      supabase
        .from("events")
        .select("event_id, occurred_at, event_type, metrics")
        .eq("company_id", company_id)
        .eq("event_type", "transaction")
        .order("occurred_at", { ascending: true }),
      "state-baselines: events",
    );

    // Extract revenue values
    const revenues = (events || [])
      .map((e) => (e.metrics as Record<string, unknown>)?.revenue as number)
      .filter((v): v is number => typeof v === "number");

    // 統計は `stats` JSONB に入れる。**修復前はここが median / iqr / p25 / p75 /
    // observation_count を「列として」書いており、実スキーマに存在しないため
    // PGRST204 になっていた**（P-1）。計算はアダプタ1本に寄せてある（S-1-2）
    const stats = buildBaselineStats(revenues, MIN_OBS);
    const isEstablished = stats !== null;

    await mustOk(
      supabase.from("baselines").upsert(
        {
          company_id,
          metric_key: REVENUE_BASELINE.metricKey,
          // 自然キーの一部なので明示する。省略するとキーの意味が変わる
          entity_id: REVENUE_BASELINE.entityId,
          granularity: REVENUE_BASELINE.granularity,
          // 確立していないときは stats を空にする。数字を 0 で埋めない
          // （読み側の parseBaselineStats が null にして落とす）
          stats: stats ?? {},
          min_obs: MIN_OBS,
          is_established: isEstablished,
          updated_at: new Date().toISOString(),
        },
        { onConflict: BASELINE_NATURAL_KEY },
      ),
      "state-baselines: baselines upsert",
    );

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
    return errorResponse(error, corsHeaders);
  }
});
