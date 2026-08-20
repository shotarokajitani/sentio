// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { generateEventId } from "../_shared/event-id.ts";
import { resolveCaller } from "../_shared/caller.ts";
import { mustOk, errorResponse } from "../_shared/db.ts";

/**
 * ingest-s0: 外部公開データ取込（S0）
 *
 * S0データは company_id = null。1回のみ取込（UPSERT冪等）。
 * Body: { events: [{ source, occurred_at, metrics }] }
 */
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const { events } = await req.json();

    if (!Array.isArray(events)) {
      return new Response(JSON.stringify({ error: "events[] required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date().toISOString();
    const rows: any[] = [];

    for (const evt of events) {
      const fingerprint = `s0:${evt.source}`;
      const rowContent = JSON.stringify(evt.metrics);
      const eventId = await generateEventId(fingerprint, rowContent);

      rows.push({
        event_id: eventId,
        company_id: null, // S0 is always null
        occurred_at: evt.occurred_at,
        ingested_at: now,
        source: evt.source,
        event_type: "external",
        entity_refs: [],
        metrics: evt.metrics ?? {},
        sensitivity: "S0",
      });
    }

    const supabase = getSupabaseAdmin();
    await mustOk(
      supabase.from("events").upsert(rows, { onConflict: "event_id" }),
      "ingest-s0: events upsert",
    );

    return new Response(JSON.stringify({ count: rows.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return errorResponse(err, corsHeaders);
  }
});
