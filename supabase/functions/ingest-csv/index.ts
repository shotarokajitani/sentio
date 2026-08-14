// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { generateEventId } from "../_shared/event-id.ts";

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { csv_text, company_id, file_fingerprint } = await req.json();

    if (!csv_text || !company_id || !file_fingerprint) {
      return new Response(
        JSON.stringify({ error: "csv_text, company_id, file_fingerprint required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const lines = (csv_text as string).trim().split("\n");
    if (lines.length < 2) {
      return new Response(JSON.stringify({ count: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const headers = lines[0].split(",");
    const dateIdx = headers.indexOf("date");
    const descIdx = headers.indexOf("description");
    const amountIdx = headers.indexOf("amount");
    const taxIdx = headers.indexOf("tax");

    const now = new Date().toISOString();
    const rows: any[] = [];

    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const rowContent = cols.join(",");
      const eventId = await generateEventId(file_fingerprint, rowContent);

      rows.push({
        event_id: eventId,
        company_id,
        occurred_at: `${cols[dateIdx]}T00:00:00.000Z`,
        ingested_at: now,
        source: "csv:accounting",
        event_type: "transaction",
        entity_refs: [],
        metrics: {
          amount: Number(cols[amountIdx]),
          tax: Number(cols[taxIdx]),
          description: cols[descIdx],
        },
        sensitivity: "S1",
      });
    }

    // UPSERT: ON CONFLICT update metrics (B2 idempotency, B3 diff detection)
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("events").upsert(rows, { onConflict: "event_id" });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ count: rows.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
