// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { generateEventId } from "../_shared/event-id.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { mustOk, errorResponse } from "../_shared/db.ts";

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const { csv_text, company_id: bodyCompanyId, file_fingerprint } = await req.json();

    const scope = resolveCompanyId(caller.caller, bodyCompanyId);
    if (!scope.ok) return scope.response;
    const company_id = scope.companyId;

    if (!csv_text || !file_fingerprint) {
      return new Response(JSON.stringify({ error: "csv_text, file_fingerprint required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
    await mustOk(
      supabase.from("events").upsert(rows, { onConflict: "event_id" }),
      "ingest-csv: events upsert",
    );

    return new Response(JSON.stringify({ count: rows.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return errorResponse(err, corsHeaders);
  }
});
