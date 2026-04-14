import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";
import { startCronLog, finishCronLog } from "../_shared/cron-logger.ts";

initSentry("send-onboarding");

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const APP_BASE = "https://www.sentio-ai.jp";

interface OnboardingStep {
  day: number;
  subject: string;
  renderBody: (ctx: RenderContext) => string;
}

interface RenderContext {
  companyName: string;
  competitors: Array<{ name: string; url?: string }>;
  questionsCount: number;
  answeredCount: number;
  signalsCount: number;
}

const STEPS: OnboardingStep[] = [
  {
    day: 2,
    subject: "Sentioが御社のことを調べています",
    renderBody: (ctx) => `<p>${ctx.companyName} 様</p>
<p>Sentioは今、御社の置かれた状況を静かに読み解いています。</p>
<p>公開情報や業界統計から、御社に近い立ち位置の会社をいくつか候補として挙げました。</p>
${
  ctx.competitors.length > 0
    ? `<ul>${ctx.competitors
        .slice(0, 5)
        .map(
          (c) =>
            `<li>${c.name}${c.url ? ` <a href="${c.url}">${c.url}</a>` : ""}</li>`,
        )
        .join("")}</ul>`
    : "<p><em>競合候補の分析は引き続き進行中です。</em></p>"
}
<p>数日のうちに、最初の問いをお届けします。</p>
<p>— Sentio</p>`,
  },
  {
    day: 7,
    subject: "最初の1週間、ありがとうございます",
    renderBody: (ctx) => `<p>${ctx.companyName} 様</p>
<p>Sentioをお使いいただき、1週間が経ちました。</p>
<p>この1週間でお届けした問いは <strong>${ctx.questionsCount}</strong> 件、
そのうち ${ctx.answeredCount} 件にお答えいただきました。</p>
<p>答えることより、問いに触れていただいたこと自体が意味を持ちます。</p>
<p>引き続き、週に一度のペースで問いをお届けします。</p>
<p>— Sentio</p>`,
  },
  {
    day: 14,
    subject: "2週間が経ちました",
    renderBody: (ctx) => `<p>${ctx.companyName} 様</p>
<p>Sentioが動き始めて2週間。これまでに ${ctx.signalsCount} 件のシグナルを検出しました。</p>
<p>次のステップとして、まだ連携していないデータソース
（会計・カレンダー・コミュニケーションツール）を繋いでいただくと、
問いの解像度が一段上がります。</p>
<p><a href="${APP_BASE}/app.html#integrations">データ連携の設定を見る</a></p>
<p>— Sentio</p>`,
  },
  {
    day: 27,
    subject: "トライアル終了まであと3日",
    renderBody: (ctx) => `<p>${ctx.companyName} 様</p>
<p>14日間のトライアルが、あと3日で終了します。</p>
<p>これまでに ${ctx.questionsCount} 件の問いと ${ctx.signalsCount} 件のシグナルをお届けしました。</p>
<p>引き続きSentioをご利用いただく場合は、プランをお選びください。</p>
<p><a href="${APP_BASE}/app.html#plan"
  style="display:inline-block;padding:14px 36px;background:#fff;color:#0e5070;border:1px solid #0e5070;border-radius:4px;text-decoration:none;">プランを選ぶ</a></p>
<p>— Sentio</p>`,
  },
  {
    day: 30,
    subject: "トライアルが終了しました",
    renderBody: (ctx) => `<p>${ctx.companyName} 様</p>
<p>14日間のトライアルが終了しました。</p>
<p>この期間にお届けした問いの数：${ctx.questionsCount} 件<br />
検出されたシグナル：${ctx.signalsCount} 件</p>
<p>Sentioは、続きをご一緒できたらと考えています。</p>
<p><a href="${APP_BASE}/app.html#plan"
  style="display:inline-block;padding:14px 36px;background:#fff;color:#0e5070;border:1px solid #0e5070;border-radius:4px;text-decoration:none;">プランを選ぶ</a></p>
<p>— Sentio</p>`,
  },
];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getServiceClient();
  const cronLog = await startCronLog(supabase, "send-onboarding");

  let processed = 0;
  const errors: string[] = [];

  try {
    // 過去31日以内に登録された会社を取得（30日送信まで対応）
    const since = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const { data: companies, error: compErr } = await supabase
      .from("companies")
      .select("id, company_name, user_id, created_at")
      .gte("created_at", since);

    if (compErr) throw compErr;
    if (!companies) {
      await finishCronLog(supabase, cronLog, {
        status: "success",
        recordsProcessed: 0,
      });
      return ok({ success: true, processed: 0 });
    }

    for (const company of companies) {
      try {
        const createdAt = new Date(company.created_at).getTime();
        const daysSince = Math.floor(
          (Date.now() - createdAt) / (24 * 60 * 60 * 1000),
        );

        const step = STEPS.find((s) => s.day === daysSince);
        if (!step) continue;

        // 冪等性：同じ (company_id, day) への重複送信を防止
        const { data: already } = await supabase
          .from("notification_logs")
          .select("id")
          .eq("company_id", company.id)
          .eq("day", step.day)
          .maybeSingle();
        if (already) continue;

        // ユーザーのメールアドレス取得
        const { data: userData } = await supabase.auth.admin.getUserById(
          company.user_id,
        );
        const email = userData?.user?.email;
        if (!email) continue;

        // 件数集計
        const [{ count: qCount }, { count: aCount }, { count: sCount }] =
          await Promise.all([
            supabase
              .from("questions")
              .select("*", { count: "exact", head: true })
              .eq("company_id", company.id),
            supabase
              .from("questions")
              .select("*", { count: "exact", head: true })
              .eq("company_id", company.id)
              .eq("status", "answered"),
            supabase
              .from("signals")
              .select("*", { count: "exact", head: true })
              .eq("company_id", company.id),
          ]);

        const { data: competitors } = await supabase
          .from("competitors")
          .select("name, url")
          .eq("company_id", company.id);

        const ctx: RenderContext = {
          companyName: company.company_name ?? "",
          competitors: competitors ?? [],
          questionsCount: qCount ?? 0,
          answeredCount: aCount ?? 0,
          signalsCount: sCount ?? 0,
        };

        if (!RESEND_API_KEY) {
          console.error("[send-onboarding] RESEND_API_KEY未設定");
          break;
        }

        const mailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: "Sentio <hello@sentio-ai.jp>",
            to: email,
            subject: step.subject,
            html: step.renderBody(ctx),
          }),
        });

        if (!mailRes.ok) {
          const body = await mailRes.text();
          throw new Error(`Resend ${mailRes.status}: ${body.slice(0, 200)}`);
        }

        // 記録（重複防止）
        await supabase.from("notification_logs").insert({
          company_id: company.id,
          day: step.day,
        });
        processed++;
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(`${company.id}: ${msg}`);
        captureError(e as Error, {
          company_id: company.id,
          extra: { stage: "send-onboarding-per-company" },
        });
      }
    }

    await finishCronLog(supabase, cronLog, {
      status: errors.length > 0 ? "error" : "success",
      errorMessage: errors.length > 0 ? errors.slice(0, 5).join(" | ") : null,
      recordsProcessed: processed,
    });

    return ok({ success: true, processed, errors });
  } catch (error) {
    captureError(error as Error);
    console.error("[send-onboarding] top-level error:", error);
    await finishCronLog(supabase, cronLog, {
      status: "error",
      errorMessage: (error as Error).message,
      recordsProcessed: processed,
    });
    return new Response(
      JSON.stringify({
        error: "send-onboardingに失敗しました",
        detail: (error as Error).message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
