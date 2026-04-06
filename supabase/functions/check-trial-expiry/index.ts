import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("check-trial-expiry");

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getServiceClient();

  try {
    const now = new Date();
    const results = { reminded_3d: 0, reminded_1d: 0, expired: 0, canceled: 0 };

    // 全トライアルサブスクリプションを取得
    const { data: trials } = await supabase
      .from("subscriptions")
      .select("*, companies(*)")
      .in("status", ["trialing", "trial_expired"]);

    if (!trials || trials.length === 0) {
      return new Response(JSON.stringify({ success: true, results }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    for (const sub of trials) {
      const end = new Date(sub.current_period_end);
      const daysLeft = Math.ceil(
        (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      const daysSinceEnd = Math.ceil(
        (now.getTime() - end.getTime()) / (1000 * 60 * 60 * 24),
      );
      const company = sub.companies;

      if (!company) continue;

      // ユーザーのメールアドレスを取得
      let email: string | null = null;
      try {
        const { data: userData } = await supabase.auth.admin.getUserById(
          company.user_id,
        );
        email = userData?.user?.email || null;
      } catch {
        continue;
      }
      if (!email) continue;

      // ① Trial終了3日前リマインドメール
      if (sub.status === "trialing" && daysLeft === 3) {
        await sendEmail(
          email,
          "Sentioのトライアルが3日後に終了します",
          `
<p>${company.company_name}様</p>
<p>Sentioのトライアル期間が<strong>3日後</strong>に終了します。</p>
<p>引き続きSentioをご利用いただくには、プランをお選びください。</p>
<p><a href="https://www.sentio-ai.jp/app.html#plan">プランを選ぶ</a></p>
<p>Sentio</p>`,
        );
        results.reminded_3d++;
      }

      // ② Trial終了1日前リマインドメール
      if (sub.status === "trialing" && daysLeft === 1) {
        await sendEmail(
          email,
          "Sentioのトライアルが明日終了します",
          `
<p>${company.company_name}様</p>
<p>Sentioのトライアル期間が<strong>明日</strong>終了します。</p>
<p>プランを選択いただかない場合、問いの配信が停止されます。</p>
<p><a href="https://www.sentio-ai.jp/app.html#plan">プランを選ぶ</a></p>
<p>Sentio</p>`,
        );
        results.reminded_1d++;
      }

      // ③ Trial終了 → status='trial_expired' / pending questionsをexpiredに
      if (sub.status === "trialing" && daysLeft <= 0) {
        await supabase
          .from("subscriptions")
          .update({
            status: "trial_expired",
            updated_at: new Date().toISOString(),
          })
          .eq("id", sub.id);

        await supabase
          .from("questions")
          .update({
            status: "expired",
          })
          .eq("company_id", company.id)
          .eq("status", "pending");

        await sendEmail(
          email,
          "Sentioのトライアルが終了しました",
          `
<p>${company.company_name}様</p>
<p>Sentioのトライアル期間が終了しました。</p>
<p>プランを選択いただくと、すぐに問いの配信を再開します。</p>
<p><a href="https://www.sentio-ai.jp/app.html#plan">プランを選ぶ</a></p>
<p>これまでの会話とシグナルのデータは保持されています。</p>
<p>Sentio</p>`,
        );
        results.expired++;
      }

      // ④ Trial終了から7日後 → status='canceled' / scheduled_deletion_at=now()+180days
      if (sub.status === "trial_expired" && daysSinceEnd >= 7) {
        await supabase
          .from("subscriptions")
          .update({
            status: "canceled",
            scheduled_deletion_at: new Date(
              Date.now() + 180 * 24 * 60 * 60 * 1000,
            ).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", sub.id);
        results.canceled++;
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error);
    return new Response(
      JSON.stringify({ error: "トライアル期限チェックに失敗しました" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

async function sendEmail(to: string, subject: string, html: string) {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "Sentio <hello@sentio-ai.jp>",
      to,
      subject,
      html,
    }),
  });
}
