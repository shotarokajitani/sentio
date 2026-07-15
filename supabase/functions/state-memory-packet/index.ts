// State-memory-packet Edge Function stub
// Assembles memory packet for a company within token budget

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id, token_budget = 4000 } = await req.json();

    // TODO: Gather sections from summary, baselines, events, findings, narratives
    // const packet = assemblePacket(sections, { companyId: company_id, tokenBudget: token_budget });

    return new Response(
      JSON.stringify({ status: "ok", company_id, token_budget }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
