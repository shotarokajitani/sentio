// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { generateEventId } from "../_shared/event-id.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { mustOk, errorResponse } from "../_shared/db.ts";

/**
 * ingest-calendar: カレンダーフィクスチャ注入
 *
 * Body: { company_id, events: [{ title, start, end, attendees? }] }
 * Each fixture event becomes a "schedule" EventEnvelope.
 */
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const { company_id: bodyCompanyId, events } = await req.json();

    const scope = resolveCompanyId(caller.caller, bodyCompanyId);
    if (!scope.ok) return scope.response;
    const company_id = scope.companyId;

    if (!company_id || !Array.isArray(events)) {
      return new Response(JSON.stringify({ error: "company_id and events[] required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date().toISOString();
    const rows: any[] = [];

    for (const evt of events) {
      const fingerprint = `calendar:${company_id}`;
      const rowContent = `${evt.title}:${evt.start}:${evt.end}`;
      const eventId = await generateEventId(fingerprint, rowContent);

      rows.push({
        event_id: eventId,
        company_id,
        occurred_at: evt.start,
        period_start: evt.start,
        period_end: evt.end,
        ingested_at: now,
        source: "calendar:fixture",
        event_type: "schedule",
        entity_refs: [],
        metrics: {
          title: evt.title,
          attendees: evt.attendees ?? [],
        },
        sensitivity: "S1",
      });
    }

    const supabase = getSupabaseAdmin();
    await mustOk(
      supabase.from("events").upsert(rows, { onConflict: "event_id" }),
      "ingest-calendar: events upsert",
    );

    return new Response(JSON.stringify({ count: rows.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return errorResponse(err, corsHeaders);
  }
});
