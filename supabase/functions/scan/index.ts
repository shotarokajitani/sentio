// Scanner Edge Function — runs 5 scans against events + baselines
// LLM-free, rule-based detection (daily via pg_cron)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { mustData, errorResponse } from "../_shared/db.ts";
import { toFlatBaselines } from "../_shared/baseline-stats.ts";
// 検知の実体は `_shared` にある。ここに戻すと import できなくなり、また測れなくなる
import { runScan, type ScanCandidate } from "../_shared/scan.ts";

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

    // Fetch recent events (last 90 days)
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const events = await mustData(
      supabase
        .from("events")
        .select("event_id, occurred_at, event_type, source, metrics, sensitivity, company_id")
        .or(`company_id.eq.${company_id},company_id.is.null`)
        .gte("occurred_at", cutoff)
        .order("occurred_at", { ascending: false }),
      "scan: events",
    );

    // Fetch baselines。**統計は `stats` JSONB にある**（`median` 等の列は実在しない）。
    // 修復前はここが実在しない列を選び、undefined → 比較が NaN → 静かに0件になっていた。
    // フラット形への変換は `toFlatBaselines` 1本だけを通す（契約 S-1-2）
    const baselineRows = await mustData(
      supabase
        .from("baselines")
        .select("metric_key, is_established, stats")
        .eq("company_id", company_id),
      "scan: baselines",
    );
    const baselines = toFlatBaselines(baselineRows);

    const candidates: ScanCandidate[] = runScan(events || [], baselines);

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
    return errorResponse(error, corsHeaders);
  }
});
