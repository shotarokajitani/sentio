// Day0 batch Edge Function
// Runs within 10 minutes of registration (A1)
// Generates 8-block report using S0 data + URL analysis
// Uses Anthropic API for initial_hypothesis block (model from ANTHROPIC_MODEL env)
// Reads prompts from prompts/ directory at runtime

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id, company_name, url, industry, concern } = await req.json();
    const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-20250514";

    // TODO: Full pipeline
    // 1. Gather S0 data (gBizINFO, jGrants, e-Stat)
    // 2. Run site health check (SSL, speed)
    // 3. Generate 8-block report via generateDay0Report()
    // 4. For initial_hypothesis block with concern, use Anthropic API
    // 5. Send via Resend
    // 6. Store in delivery_log

    return new Response(
      JSON.stringify({ status: "ok", company_id, model }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
