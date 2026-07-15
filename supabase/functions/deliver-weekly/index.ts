// Weekly email delivery Edge Function
// Renders weekly report and sends via Resend

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id } = await req.json();

    // TODO: Gather findings, company state
    // const sections = renderWeekly(findings, state);
    // Send via Resend API

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
