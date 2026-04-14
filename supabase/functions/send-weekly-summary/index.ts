import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("send-weekly-summary");

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const BASE_URL = "https://www.sentio-ai.jp";

function weekOfMonth(d: Date): number {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return Math.floor((d.getDate() + first.getDay() - 1) / 7) + 1;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getServiceClient();

  try {
    const now = new Date();
    const weekAgo = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const month = now.getMonth() + 1;
    const week = weekOfMonth(now);
    const subject = `今週のSentio（${month}月第${week}週）`;

    // アクティブな会社（trialing or active）
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("company_id, status")
      .in("status", ["trialing", "active"]);

    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ success: true, sent: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    const results: { company_id: string; ok: boolean }[] = [];

    for (const sub of subs) {
      try {
        const { data: company } = await supabase
          .from("companies")
          .select("id, company_name, user_id")
          .eq("id", sub.company_id)
          .single();
        if (!company) continue;

        const { data: signals } = await supabase
          .from("signals")
          .select("description, strength")
          .eq("company_id", company.id)
          .gte("created_at", weekAgo)
          .order("created_at", { ascending: false });

        const { count: answeredCount } = await supabase
          .from("questions")
          .select("id", { count: "exact", head: true })
          .eq("company_id", company.id)
          .eq("status", "answered")
          .gte("answered_at", weekAgo);

        const signalCount = signals?.length || 0;

        // シグナルも回答もゼロなら送らない
        if (signalCount === 0 && (answeredCount || 0) === 0) continue;

        const { data: userData } = await supabase.auth.admin.getUserById(
          company.user_id,
        );
        const email = userData?.user?.email;
        if (!email) continue;

        const signalListHtml =
          signalCount > 0
            ? `<ul style="font-size:14px;color:#1a1a1a;line-height:1.8;padding-left:20px;margin-bottom:24px;">
                ${signals!
                  .map(
                    (s) =>
                      `<li style="margin-bottom:8px;">${s.description}</li>`,
                  )
                  .join("")}
              </ul>`
            : `<p style="font-size:14px;color:#6b6560;line-height:1.8;margin-bottom:24px;">今週は新しいシグナルはありませんでした。</p>`;

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
      ${company.company_name}様 — 今週のサマリー
    </div>

    <p style="font-family:Georgia,serif;font-size:18px;line-height:1.8;color:#1a1a1a;margin-bottom:24px;">
      今週、御社について${signalCount}件のシグナルがありました。
    </p>

    ${signalListHtml}

    <p style="font-size:13px;color:#6b6560;line-height:1.8;margin-bottom:24px;">
      今週、${answeredCount || 0}件の問いにお答えいただきました。<br />
      来週も引き続き観察します。
    </p>

    <div style="margin-bottom:8px;">
      <a href="${BASE_URL}/app.html" style="display:inline-block;padding:12px 28px;background:#0e5070;color:#ffffff;text-decoration:none;font-size:13px;border-radius:4px;">Sentioを開く</a>
    </div>
  </div>
</body>
</html>`;

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

        if (emailRes.ok) {
          sent++;
          results.push({ company_id: company.id, ok: true });
        } else {
          results.push({ company_id: company.id, ok: false });
        }
      } catch (e) {
        captureError(e as Error, { company_id: sub.company_id });
        results.push({ company_id: sub.company_id, ok: false });
      }
    }

    return new Response(
      JSON.stringify({ success: true, sent, total: subs.length, results }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    captureError(error as Error);
    return new Response(
      JSON.stringify({ error: "週次サマリー送信に失敗しました" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
