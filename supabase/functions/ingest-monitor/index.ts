// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { generateEventId } from "../_shared/event-id.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { mustOk, errorResponse } from "../_shared/db.ts";

/**
 * ingest-monitor: 稼働監視データ取込（E3の前提）
 *
 * Body: { company_id, checks: [{ url, status, response_time_ms, ssl_days_remaining?, checked_at }] }
 * Each check becomes a "monitor" EventEnvelope.
 */
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const { company_id: bodyCompanyId, checks } = await req.json();

    const scope = resolveCompanyId(caller.caller, bodyCompanyId);
    if (!scope.ok) return scope.response;
    const company_id = scope.companyId;

    if (!company_id || !Array.isArray(checks)) {
      return new Response(JSON.stringify({ error: "company_id and checks[] required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date().toISOString();
    const rows: any[] = [];

    for (const check of checks) {
      const fingerprint = `monitor:${company_id}:${check.url}`;
      const rowContent = `${check.checked_at}:${check.status}:${check.response_time_ms}`;
      const eventId = await generateEventId(fingerprint, rowContent);

      rows.push({
        event_id: eventId,
        company_id,
        occurred_at: check.checked_at,
        ingested_at: now,
        source: "monitor:health",
        event_type: "monitor",
        entity_refs: [],
        metrics: {
          url: check.url,
          status: check.status,
          response_time_ms: check.response_time_ms,
          ssl_days_remaining: check.ssl_days_remaining ?? null,
        },
        sensitivity: "S1",
      });
    }

    const supabase = getSupabaseAdmin();
    await mustOk(
      supabase.from("events").upsert(rows, { onConflict: "event_id" }),
      "ingest-monitor: events upsert",
    );

    return new Response(JSON.stringify({ count: rows.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return errorResponse(err, corsHeaders);
  }
});
