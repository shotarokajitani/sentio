import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("on-integration-connected");

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

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

    // statusが変わっていないなら何もしない
    if (oldRecord && record.status === oldRecord.status) {
      return new Response(
        JSON.stringify({ success: true, message: "No status change" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // connected状態でなければスキップ
    if (record.status !== "connected") {
      return new Response(
        JSON.stringify({ success: true, message: "Not connected" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const company_id = record.company_id;
    const integrationType = record.integration_type;

    // onboarding_stageを更新
    const stageMap: Record<string, string> = {
      accounting: "stage2", // 会計ソフト連携完了
      calendar: "stage3", // カレンダー連携完了
    };

    const newStage = stageMap[integrationType];
    if (newStage) {
      await supabase
        .from("companies")
        .update({
          onboarding_stage: newStage,
          updated_at: new Date().toISOString(),
        })
        .eq("id", company_id);
    }

    // detect-signalsを再実行
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

    // 連携完了通知メールを送信
    try {
      const { data: company } = await supabase
        .from("companies")
        .select("*")
        .eq("id", company_id)
        .single();

      if (company) {
        const { data: userData } = await supabase.auth.admin.getUserById(
          company.user_id,
        );
        const email = userData?.user?.email;

        if (email) {
          const integrationNames: Record<string, string> = {
            accounting: "会計ソフト",
            calendar: "Google カレンダー",
            freee: "freee",
            moneyforward: "マネーフォワード",
          };
          const integrationName =
            integrationNames[integrationType] || integrationType;

          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: "Sentio <hello@sentio-ai.jp>",
              to: email,
              subject: `${integrationName}の連携が完了しました`,
              html: `<p>${company.company_name}様</p>
<p>${integrationName}の連携が完了しました。</p>
<p>Sentioはこのデータを活用して、より深い洞察をお届けします。</p>
<p><a href="https://www.sentio-ai.jp/app.html">ダッシュボードを見る</a></p>
<p>Sentio</p>`,
            }),
          });
        }
      }
    } catch (e) {
      captureError(e as Error, {
        company_id,
        extra: { step: "send_notification" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error);
    return new Response(JSON.stringify({ error: "連携処理に失敗しました" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
