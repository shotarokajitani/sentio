import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";
import { initSentry, captureError } from "../_shared/sentry.ts";
import {
  getServiceClient,
  getUserClient,
  corsHeaders,
} from "../_shared/supabase.ts";

initSentry("process-answer");

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // JWT必須
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "認証が必要です" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userClient = getUserClient(authHeader);
  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "認証が必要です" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = getServiceClient();

  try {
    const { question_id, company_id, action, answer_text } =
      (await req.json()) as {
        question_id: string;
        company_id: string;
        action: "answer" | "skip" | "defer";
        answer_text?: string;
      };

    // 会社の所有権チェック
    const { data: company } = await supabase
      .from("companies")
      .select("*")
      .eq("id", company_id)
      .eq("user_id", user.id)
      .single();

    if (!company) {
      return new Response(JSON.stringify({ error: "権限がありません" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    // 冪等性チェック: answered_at / skipped_at / deferred_at のnullチェック
    if (question.answered_at || question.skipped_at || question.deferred_at) {
      return new Response(
        JSON.stringify({ success: true, message: "既に処理済みです" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (action === "skip") {
      await supabase
        .from("questions")
        .update({
          status: "skipped",
          skipped_at: new Date().toISOString(),
        })
        .eq("id", question_id);

      // signal.status='resolved', resolution_type='user_reported'
      if (question.signal_id) {
        await supabase
          .from("signals")
          .update({
            status: "resolved",
            resolution_type: "user_reported",
          })
          .eq("id", question.signal_id);
      }

      return new Response(
        JSON.stringify({ success: true, action: "skipped" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (action === "defer") {
      await supabase
        .from("questions")
        .update({
          status: "deferred",
          deferred_at: new Date().toISOString(),
        })
        .eq("id", question_id);

      return new Response(
        JSON.stringify({ success: true, action: "deferred" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // action === 'answer'
    await supabase
      .from("questions")
      .update({
        status: "answered",
        answered_at: new Date().toISOString(),
        answer_text,
      })
      .eq("id", question_id);

    // 会話に記録
    await supabase.from("conversations").insert([
      {
        company_id,
        role: "sentio",
        content: question.question_text,
        question_id,
      },
      {
        company_id,
        role: "executive",
        content: answer_text,
        question_id,
      },
    ]);

    // Claude APIで回答を解釈 → パターン6のシグナル検出
    let newSignals: any[] = [];
    if (answer_text) {
      try {
        const message = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: `経営者の回答を分析し、「言葉と感情の矛盾」（パターン6）がないか検出してください。

【問い】
${question.question_text}

【回答】
${answer_text}

【会社情報】
会社名: ${company.company_name}
業種: ${company.industry || "不明"}

パターン6（言葉と感情の矛盾）の例:
- 「大丈夫です」と言いながら不安が滲む表現
- ポジティブな言葉の中に含まれる違和感
- 答えを避けている、核心に触れない回答

JSON配列で出力（検出なしの場合は空配列[]）:
[
  {
    "pattern_id": 6,
    "strength": "high" | "medium" | "low",
    "direction": "risk" | "opportunity" | "silence",
    "description": "一行の説明",
    "evidence": { "data_points": ["回答からの根拠"], "overlap_count": 1 }
  }
]

JSON以外は出力しないでください。`,
            },
          ],
        });

        const text =
          message.content[0].type === "text" ? message.content[0].text : "[]";
        try {
          newSignals = JSON.parse(text);
        } catch {
          const match = text.match(/\[[\s\S]*\]/);
          if (match) newSignals = JSON.parse(match[0]);
        }
        if (!Array.isArray(newSignals)) newSignals = [];
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { step: "interpret_answer" },
        });
      }
    }

    // パターン6のシグナルをsignalsテーブルに挿入（source='executive'）
    for (const sig of newSignals) {
      if (sig.pattern_id !== 6) continue;
      await supabase.from("signals").insert({
        company_id,
        pattern_id: 6,
        strength: sig.strength,
        direction: sig.direction,
        source: "executive",
        description: sig.description,
        evidence: sig.evidence,
        status: "active",
        expires_at: new Date(
          Date.now() + 14 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      });
    }

    // learn-patternをトリガー
    try {
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/learn-pattern`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ company_id, question_id }),
        },
      );
    } catch (e) {
      captureError(e as Error, {
        company_id,
        extra: { trigger: "learn-pattern" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        action: "answered",
        new_signals: newSignals.length,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    captureError(error as Error);
    return new Response(JSON.stringify({ error: "回答処理に失敗しました" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
