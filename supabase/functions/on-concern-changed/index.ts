import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("on-concern-changed");

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getServiceClient();

  try {
    // Database Webhookからのペイロード
    const payload = await req.json();
    const record = payload.record || payload;
    const oldRecord = payload.old_record;

    // initial_concernが変更されたかチェック
    if (oldRecord && record.initial_concern === oldRecord.initial_concern) {
      return new Response(
        JSON.stringify({ success: true, message: "No concern change" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const company_id = record.id;

    // ① pending状態のquestionsを全て削除
    const { error: deleteError } = await supabase
      .from("questions")
      .delete()
      .eq("company_id", company_id)
      .eq("status", "pending");

    if (deleteError) {
      captureError(
        new Error(`Failed to delete pending questions: ${deleteError.message}`),
        { company_id },
      );
    }

    // ② detect-signalsを再実行
    try {
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/detect-signals`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ company_id }),
        },
      );
    } catch (e) {
      captureError(e as Error, {
        company_id,
        extra: { trigger: "detect-signals" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error);
    return new Response(
      JSON.stringify({ error: "関心事変更処理に失敗しました" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
