// One-tap calendar Edge Function
// Creates calendar draft (never sends automatically)
// Confirmation via separate endpoint

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { finding_id, recipient_id, action } = await req.json();

    // TODO: action = "create" -> createCalendarDraft()
    //       action = "confirm" -> confirmDraft()
    // Store in delivery_log

    return new Response(
      JSON.stringify({ status: "ok", finding_id, action }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
