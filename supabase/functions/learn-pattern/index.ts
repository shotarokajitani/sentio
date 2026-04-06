import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("learn-pattern");

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getServiceClient();

  try {
    const { company_id, question_id } = await req.json();

    const { data: question } = await supabase
      .from("questions")
      .select("*, signals(*)")
      .eq("id", question_id)
      .single();

    if (!question) {
      return new Response(JSON.stringify({ error: "Question not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: company } = await supabase
      .from("companies")
      .select("*")
      .eq("id", company_id)
      .single();

    if (!company) {
      return new Response(JSON.stringify({ error: "Company not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // patternsテーブルに記録
    await supabase.from("patterns").insert({
      company_id,
      question_id,
      signal_id: question.signal_id || null,
      pattern_id: question.signals?.pattern_id || null,
      action: question.status,
      answer_text: question.answer_text || null,
      recorded_at: new Date().toISOString(),
    });

    // allow_industry_analysis=true のときのみ industry_patterns にも匿名記録
    if (company.allow_industry_analysis && company.industry) {
      await supabase.from("industry_patterns").insert({
        industry: company.industry,
        pattern_id: question.signals?.pattern_id || null,
        action: question.status,
        strength: question.signals?.strength || null,
        direction: question.signals?.direction || null,
        recorded_at: new Date().toISOString(),
        // 個社特定情報は含めない
      });
    }

    // MVPでは記録のみ（50社以上になってから学習ロジックを起動）
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error);
    return new Response(
      JSON.stringify({ error: "パターン学習に失敗しました" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
