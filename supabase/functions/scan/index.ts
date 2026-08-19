// Scanner Edge Function — runs 5 scans against events + baselines
// LLM-free, rule-based detection (daily via pg_cron)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { mustData, errorResponse } from "../_shared/db.ts";

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

    // Fetch baselines。列を明示する。`select("*")` のままだと、実在しない列
    // （median / iqr / p25 / p75）が undefined になり、比較が NaN になって
    // 静かに0件になる。この不具合が隠れていた場所そのもの
    const baselines = await mustData(
      supabase
        .from("baselines")
        .select("metric_key, is_established, median, iqr, p25, p75")
        .eq("company_id", company_id),
      "scan: baselines",
    );

    // Fetch known explanations for suppression
    const knownExplanations = await mustData(
      supabase
        .from("known_explanations")
        .select("pattern, explanation")
        .eq("company_id", company_id),
      "scan: known_explanations",
    );

    const candidates: ScanCandidate[] = [];
    const established = (baselines || []).filter(
      (b: { is_established: boolean }) => b.is_established,
    );

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

    // 5. Metric change scan — detect monotonic worsening across event types
    // Groups events by (event_type, metric_key) and detects 3+ consecutive worsening values
    const metricExtractors: Array<{
      eventType: string;
      metricKey: string;
      extract: (m: Record<string, unknown>) => number | undefined;
      direction: "increasing_is_bad" | "decreasing_is_bad";
      label: string;
    }> = [
      {
        eventType: "communication",
        metricKey: "reply_time_hours",
        extract: (m) => m.reply_time_hours as number | undefined,
        direction: "increasing_is_bad",
        label: "Reply time worsening",
      },
      {
        eventType: "web",
        metricKey: "inquiry_count",
        extract: (m) => m.inquiry_count as number | undefined,
        direction: "decreasing_is_bad",
        label: "Inquiry count declining",
      },
      {
        eventType: "attendance",
        metricKey: "late_hours",
        extract: (m) => m.late_hours as number | undefined,
        direction: "increasing_is_bad",
        label: "Overtime hours increasing",
      },
    ];

    for (const extractor of metricExtractors) {
      const relevantEvents = (events || [])
        .filter((e) => e.event_type === extractor.eventType)
        .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());

      const dataPoints = relevantEvents
        .map((e) => ({
          event_id: e.event_id,
          value: extractor.extract(e.metrics as Record<string, unknown>),
        }))
        .filter((d): d is { event_id: string; value: number } => d.value !== undefined);

      if (dataPoints.length < 3) continue;

      // Check last 3+ points for monotonic worsening
      const recent = dataPoints.slice(-Math.min(dataPoints.length, 5));
      let isWorsening = true;
      for (let i = 1; i < recent.length; i++) {
        if (extractor.direction === "increasing_is_bad") {
          if (recent[i].value <= recent[i - 1].value) {
            isWorsening = false;
            break;
          }
        } else {
          if (recent[i].value >= recent[i - 1].value) {
            isWorsening = false;
            break;
          }
        }
      }

      if (isWorsening && recent.length >= 3) {
        const first = recent[0].value;
        const last = recent[recent.length - 1].value;
        candidates.push({
          scanType: "deviation",
          source: extractor.eventType,
          suggestedUrgency: "weekly",
          evidence_event_ids: recent.map((d) => d.event_id),
          description: `${extractor.label}: ${first} → ${last} (${recent.length} consecutive points)`,
          score: Math.abs(last - first) / (Math.abs(first) || 1),
        });
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
    return errorResponse(error, corsHeaders);
  }
});
