// One-tap calendar Edge Function (E4)
// Creates calendar draft (never sends automatically)
// Confirmation via separate action — Sentio never auto-sends/registers

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { company_id, finding_id, recipient_id, action } = await req.json();
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    if (action === "create") {
      // Create draft — nothing is sent or registered yet
      const draftId = crypto.randomUUID();
      const { error } = await supabase.from("delivery_log").insert({
        id: draftId,
        company_id,
        channel: "calendar",
        delivery_type: "onetap_calendar",
        content: {
          finding_id,
          recipient_id,
          status: "draft",
          sent_at: null,
          registered_at: null,
        },
        status: "draft",
        created_at: now,
      });

      if (error) throw error;

      return new Response(
        JSON.stringify({ status: "ok", draft_id: draftId, action: "created" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "confirm") {
      const { draft_id } = await req.json();

      // Confirm draft — update status
      const { data: existing, error: fetchError } = await supabase
        .from("delivery_log")
        .select("content, status")
        .eq("id", draft_id)
        .single();

      if (fetchError || !existing) {
        return new Response(
          JSON.stringify({ error: "Draft not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (existing.status === "confirmed") {
        return new Response(
          JSON.stringify({ error: "Already confirmed" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { error: updateError } = await supabase
        .from("delivery_log")
        .update({
          status: "confirmed",
          content: {
            ...existing.content,
            status: "confirmed",
            registered_at: now,
          },
        })
        .eq("id", draft_id);

      if (updateError) throw updateError;

      return new Response(
        JSON.stringify({ status: "ok", draft_id, action: "confirmed" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ error: "action must be 'create' or 'confirm'" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
