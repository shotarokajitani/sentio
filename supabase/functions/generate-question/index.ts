import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";
import { sanitizePII } from "../_shared/sanitize.ts";

initSentry("generate-question");

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

const MAX_RETRY = 3;
const TRIAL_QUESTION_LIMIT = 10;

// プラン別 月次問い生成上限
// scale は Infinity（無制限）
const PLAN_MONTHLY_LIMITS: Record<string, number> = {
  trial: 10,
  starter: 10,
  growth: 50,
  scale: Number.POSITIVE_INFINITY,
};

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const PROHIBITED = [
  "検討してください",
  "必要があります",
  "すべきです",
  "してください",
  "重要です",
  "ことをお勧め",
  "べきでしょう",
];

const FALLBACK_QUESTION =
  "今、誰かに話したいけど話せていないことが、何かありますか。";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getServiceClient();

  try {
    const { company_id, signal_id } = await req.json();

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

    // プラン情報取得
    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("company_id", company_id)
      .single();

    // プラン名の解決：trialing は plan='trial' 扱い、未加入も trial 扱い
    const plan =
      subscription?.status === "trialing"
        ? "trial"
        : (subscription?.plan ?? "trial");
    const monthlyLimit = PLAN_MONTHLY_LIMITS[plan] ?? 10;
    const month = currentMonth();

    // 月次上限チェック（scale プランは Infinity のためスキップ）
    if (Number.isFinite(monthlyLimit)) {
      const { count, error: countErr } = await supabase
        .from("usage_logs")
        .select("*", { count: "exact", head: true })
        .eq("company_id", company_id)
        .eq("action_type", "generate_question")
        .eq("month", month);

      if (countErr) {
        console.error("[generate-question] usage_logs count failed:", countErr);
      }

      if ((count || 0) >= monthlyLimit) {
        // トライアル上限はユーザーへメール通知（アップグレード促進）
        if (plan === "trial") {
          try {
            await sendTrialLimitEmail(company, supabase);
          } catch (e) {
            captureError(e as Error, { company_id });
          }
        }
        return jsonResp(
          {
            error: "月次の問い生成上限に達しました",
            plan,
            limit: monthlyLimit,
          },
          429,
        );
      }
    }

    // シグナル情報を取得
    let signal: any = null;
    if (signal_id) {
      const { data } = await supabase
        .from("signals")
        .select("*")
        .eq("id", signal_id)
        .single();
      signal = data;
    }

    // 直近の会話を取得
    const { data: conversations } = await supabase
      .from("conversations")
      .select("*")
      .eq("company_id", company_id)
      .order("created_at", { ascending: false })
      .limit(10);

    // 過去の問いを取得（重複回避）
    const { data: pastQuestions } = await supabase
      .from("questions")
      .select("question_text")
      .eq("company_id", company_id)
      .order("created_at", { ascending: false })
      .limit(10);

    let generatedQuestion: any = null;

    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content:
              sanitizePII(`あなたはSentioの問い生成エンジンです。経営者に届ける「問い」を一つ生成してください。

【会社情報】
会社名: ${company.company_name}
業種: ${company.industry || "不明"}
関心事: ${company.initial_concern || "不明"}

${
  signal
    ? `【検出されたシグナル】
パターン: ${signal.pattern_id}
強度: ${signal.strength}
方向: ${signal.direction}
説明: ${signal.description}
根拠: ${JSON.stringify(signal.evidence)}`
    : "【シグナル情報なし】"
}

【直近の会話】
${JSON.stringify(conversations?.map((c) => ({ role: c.role, content: c.content?.slice(0, 200) })) || [])}

【過去の問い（重複回避）】
${pastQuestions?.map((q) => q.question_text).join("\n") || "なし"}

【禁止フレーズ（絶対に使わないこと）】
${PROHIBITED.join("、")}

【出力フォーマット（JSON）】
{
  "question_text": "150文字以内の問い。命令や助言ではなく、純粋な問いかけ",
  "question_type": "normal" | "sensitive" | "opportunity",
  "question_rationale": "内部記録用の生成理由",
  "evidence_summary": "一行の根拠要約",
  "opening_line": "50文字以内の導入文",
  "skip_message": "sensitiveの場合のみ。スキップ時のメッセージ",
  "answer_hints": ["ヒント1", "ヒント2", "ヒント3"]
}

JSON以外は出力しないでください。`),
          },
        ],
      });

      const text =
        message.content[0].type === "text" ? message.content[0].text : "";

      try {
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found");
          parsed = JSON.parse(jsonMatch[0]);
        }

        // 禁止フレーズチェック
        const hasProhibited = PROHIBITED.some((p) =>
          parsed.question_text?.includes(p),
        );
        if (hasProhibited) {
          if (attempt < MAX_RETRY - 1) continue;
          // 3回失敗 → フォールバック
          break;
        }

        generatedQuestion = parsed;
        break;
      } catch {
        if (attempt === MAX_RETRY - 1) break;
      }
    }

    // フォールバック問い
    if (!generatedQuestion) {
      generatedQuestion = {
        question_text: FALLBACK_QUESTION,
        question_type: "sensitive",
        question_rationale: "フォールバック：生成が3回失敗",
        evidence_summary: "",
        opening_line: "",
        skip_message: "この問いは、今はスキップしても大丈夫です。",
        answer_hints: [
          "思い浮かんだことをそのまま",
          "一言でも構いません",
          "答えなくても次の問いは届きます",
        ],
      };
    }

    // questionsテーブルに保存
    const { data: question, error } = await supabase
      .from("questions")
      .insert({
        company_id,
        signal_id: signal_id || null,
        question_text: generatedQuestion.question_text,
        question_type: generatedQuestion.question_type,
        question_rationale: generatedQuestion.question_rationale,
        evidence_summary: generatedQuestion.evidence_summary,
        opening_line: generatedQuestion.opening_line,
        skip_message: generatedQuestion.skip_message,
        answer_hints: generatedQuestion.answer_hints,
        status: "pending",
      })
      .select()
      .single();

    if (error) throw new Error(`Question insert failed: ${error.message}`);

    // 月次利用量を記録（レート制限用カウンタ）
    try {
      const { error: usageErr } = await supabase.from("usage_logs").insert({
        company_id,
        action_type: "generate_question",
        month,
      });
      if (usageErr) {
        console.error(
          "[generate-question] usage_logs insert failed:",
          usageErr,
        );
      }
    } catch (e) {
      captureError(e as Error, {
        company_id,
        extra: { stage: "usage_logs_insert" },
      });
    }

    // deliver-questionをトリガー
    try {
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/deliver-question`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ question_id: question.id, company_id }),
        },
      );
    } catch (e) {
      captureError(e as Error, {
        company_id,
        extra: { trigger: "deliver-question" },
      });
    }

    return new Response(JSON.stringify({ success: true, question }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error);
    return new Response(JSON.stringify({ error: "問い生成に失敗しました" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function sendTrialLimitEmail(company: any, supabase: any) {
  const { data: user } = await supabase.auth.admin.getUserById(company.user_id);
  if (!user?.user?.email) return;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
    },
    body: JSON.stringify({
      from: "Sentio <hello@sentio-ai.jp>",
      to: user.user.email,
      subject: "Sentioの問いが上限に達しました",
      html: `<p>${company.company_name}様</p>
<p>トライアル期間中の問い配信（${TRIAL_QUESTION_LIMIT}回）が上限に達しました。</p>
<p>引き続きSentioをご利用いただくには、プランをお選びください。</p>
<p><a href="https://www.sentio-ai.jp/app.html#plan">プランを選ぶ</a></p>
<p>Sentio</p>`,
    }),
  });
}
