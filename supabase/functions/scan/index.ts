// Scanner Edge Function — runs 5 scans (deviation/trend/silence/deadline/external)
// LLM-free, rule-based detection

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id } = await req.json();

    // TODO: Fetch timeline events and baselines for company
    // const candidates = runScan(events, baselines);
    // Store candidates for Investigator pickup

    return new Response(
      JSON.stringify({ status: "ok", company_id, candidates: [] }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
