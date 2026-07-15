// Immediate alert delivery Edge Function
// Facts + link only, no interpretation (E3)
// Respects quiet hours 23:00-06:00 JST (E5)

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { event } = await req.json();

    // TODO: Check quiet hours via shouldDeliverNow()
    // If deferred, store in delivery_log for morning batch
    // Otherwise, renderAlert(event) and send via Resend

    return new Response(
      JSON.stringify({ status: "ok" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
