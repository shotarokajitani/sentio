// State-narratives Edge Function stub
// Handles narrative upsert with confidence decay

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id, key, content, source_event_id } = await req.json();

    // TODO: Read existing narrative by key
    // const narrative = upsertNarrative(existing, key, content, source_event_id);
    // Upsert into narratives table

    return new Response(
      JSON.stringify({ status: "ok", company_id, key }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
