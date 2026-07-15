// State-baselines Edge Function stub
// Reads events from DB, groups by metric, and calls calculateBaseline
// Full implementation will query events table and upsert baselines table

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id } = await req.json();

    // TODO: Query events for company, group by metric, calculate baselines
    // const baselines = calculateBaseline(observations, { minObs: 5 });
    // Upsert into baselines table

    return new Response(
      JSON.stringify({ status: "ok", company_id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
