// State-summary Edge Function stub
// Regenerates company_summary from current state (nightly job)

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id } = await req.json();

    // TODO: Gather company data (events, baselines, narratives, entities)
    // const summary = generateSummary(companyData);
    // Upsert into company_summary table

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
