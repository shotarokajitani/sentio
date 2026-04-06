import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("deliver-question");

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const SUBJECT_TEMPLATES: Record<string, string> = {
  high: "今週、確認していただきたいことがあります。",
  medium: "気になることがあります。",
  low: "少し聞いてもいいですか。",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getServiceClient();

  try {
    const { question_id, company_id } = await req.json();

    const { data: question } = await supabase
      .from("questions")
      .select("*")
      .eq("id", question_id)
      .single();

    if (!question) {
      return new Response(JSON.stringify({ error: "Question not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // delivery_attempts >= 3 → 配信停止
    if ((question.delivery_attempts || 0) >= 3) {
      await supabase
        .from("questions")
        .update({ status: "expired" })
        .eq("id", question_id);
      return new Response(
        JSON.stringify({ success: false, reason: "max_attempts_reached" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
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

    // ユーザーのメールアドレスを取得
    const { data: userData } = await supabase.auth.admin.getUserById(
      company.user_id,
    );
    const email = userData?.user?.email;
    if (!email) {
      return new Response(JSON.stringify({ error: "User email not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // クリックトークン生成
    const answerToken = crypto.randomUUID();
    const skipToken = crypto.randomUUID();

    await supabase.from("click_tokens").insert([
      { token: answerToken, question_id, action: "answer", company_id },
      { token: skipToken, question_id, action: "skip", company_id },
    ]);

    // シグナルの強度を取得
    let strength = "medium";
    if (question.signal_id) {
      const { data: signal } = await supabase
        .from("signals")
        .select("strength")
        .eq("id", question.signal_id)
        .single();
      if (signal) strength = signal.strength;
    }

    const subject = SUBJECT_TEMPLATES[strength] || SUBJECT_TEMPLATES.medium;
    const baseUrl = "https://www.sentio-ai.jp";

    const answerUrl = `${baseUrl}/app.html?action=answer&token=${answerToken}`;
    const skipUrl = `${baseUrl}/app.html?action=skip&token=${skipToken}`;

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;background:#f7f5f2;padding:40px 20px;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e0da;border-radius:8px;padding:40px;">
    <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:0.1em;color:#1a1a1a;margin-bottom:4px;">
      S<span style="color:#0e5070">e</span>ntio
    </div>
    <div style="font-size:11px;color:#6b6560;margin-bottom:32px;">
      ${company.company_name}様への問い
    </div>

    ${question.opening_line ? `<p style="font-size:14px;color:#6b6560;line-height:1.8;margin-bottom:24px;">${question.opening_line}</p>` : ""}

    ${question.evidence_summary ? `<p style="font-size:13px;color:#6b6560;line-height:1.8;margin-bottom:16px;padding:16px;background:#f7f5f2;border-radius:4px;">${question.evidence_summary}</p>` : ""}

    <p style="font-family:Georgia,serif;font-size:18px;line-height:1.8;color:#1a1a1a;margin-bottom:32px;">
      ${question.question_text}
    </p>

    <div style="margin-bottom:32px;">
      <a href="${answerUrl}" style="display:inline-block;padding:12px 28px;background:#0e5070;color:#ffffff;text-decoration:none;font-size:13px;border-radius:4px;margin-right:8px;">答える</a>
      <a href="${skipUrl}" style="display:inline-block;padding:12px 28px;background:#f7f5f2;color:#6b6560;text-decoration:none;font-size:13px;border-radius:4px;border:1px solid #e5e0da;">スキップ</a>
    </div>

    ${question.skip_message ? `<p style="font-size:12px;color:#c8c3bc;margin-bottom:0;">${question.skip_message}</p>` : ""}
  </div>
</body>
</html>`;

    // Resend送信
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Sentio <hello@sentio-ai.jp>",
        to: email,
        subject,
        html: htmlBody,
      }),
    });

    const emailResult = await emailRes.json();

    // delivery_attemptsをインクリメント・statusを更新
    await supabase
      .from("questions")
      .update({
        delivery_attempts: (question.delivery_attempts || 0) + 1,
        status: "delivered",
        delivered_at: new Date().toISOString(),
      })
      .eq("id", question_id);

    return new Response(
      JSON.stringify({ success: true, email_id: emailResult.id }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    captureError(error as Error);
    return new Response(JSON.stringify({ error: "問い配信に失敗しました" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
