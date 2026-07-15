// Daily pulse delivery Edge Function
// 3 lines: 2 lines of yesterday's facts + 1 line state (normal/watching)
// Anomaly days add a 4th line

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id } = await req.json();

    // TODO: Gather yesterday's events, current state
    // Render 3-line pulse
    // Send via configured channel (LINE/Chatwork/Slack)

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
