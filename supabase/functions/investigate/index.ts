// Investigator Edge Function — Planner -> Generator -> Evaluator pipeline
// Uses Anthropic API (model from ANTHROPIC_MODEL env var)
// Reads evaluator criteria from prompts/evaluator_criteria.md at runtime
// Reads finding template from prompts/finding_template.md at runtime

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id, candidates } = await req.json();
    const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-20250514";

    // TODO: Full pipeline implementation
    // 1. Planner: cluster candidates, build investigation plan
    // 2. Generator: generate 3+ hypotheses, collect evidence, draft Finding
    // 3. Evaluator: judge against 5 criteria (loaded from prompts/evaluator_criteria.md)
    //    - Independence: only finding + evidence passed (no generator reasoning)
    //    - Max 2 revisions before reject

    return new Response(
      JSON.stringify({ status: "ok", company_id, model, findings: [] }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
