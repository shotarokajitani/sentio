import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";
import { sanitizePII } from "../_shared/sanitize.ts";

initSentry("detect-signals");

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getServiceClient();

  try {
    const { company_id } = await req.json();

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

    // 最新のexternal_data
    const { data: externalData } = await supabase
      .from("external_data")
      .select("*")
      .eq("company_id", company_id)
      .order("created_at", { ascending: false })
      .limit(20);

    // 直近20件のconversations
    const { data: conversations } = await supabase
      .from("conversations")
      .select("*")
      .eq("company_id", company_id)
      .order("created_at", { ascending: false })
      .limit(20);

    // 14日以内に配信済みのパターンをチェック
    const fourteenDaysAgo = new Date(
      Date.now() - 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data: recentSignals } = await supabase
      .from("signals")
      .select("pattern_id")
      .eq("company_id", company_id)
      .gte("created_at", fourteenDaysAgo);

    const recentPatternIds = (recentSignals || []).map((s) => s.pattern_id);

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content:
            sanitizePII(`あなたはSentioのシグナル検出エンジンです。以下のデータを分析し、経営上の矛盾やチャンスを検出してください。

【会社情報】
会社名: ${company.company_name}
業種: ${company.industry || "不明"}
関心事: ${company.initial_concern || "不明"}

【外部データ】
${JSON.stringify(externalData?.map((d) => ({ source: d.source, content: d.content })) || [], null, 2)}

【直近の会話】
${JSON.stringify(conversations?.map((c) => ({ role: c.role, content: c.content })) || [], null, 2)}

【検出パターン（パターン6は除外すること）】
1: 表と裏の矛盾（URLの言葉 vs 実態）
2: 成長と実態の矛盾（売上 vs 利益・キャッシュ）
3: 戦略と行動の矛盾（採用・投資 vs コスト構造）
4: 過去と現在の矛盾（3年前 vs 現在）
5: 集中と分散の矛盾（取引先依存度）
7: 内部と外部の交差（競合・市場 vs 自社）
8: 沈黙のシグナル（来るべきものが来ていない）
9: 広告費と売上の矛盾（Meta/GA4/Shopifyの数字の食い違い）

⚠️ パターン6（言葉と感情の矛盾）は絶対に検出しないでください。

【14日以内に配信済みのパターン（スキップすること）】
${JSON.stringify(recentPatternIds)}

JSON配列で出力（0〜3件）:
[
  {
    "pattern_id": 1〜9の整数（6を除く）,
    "strength": "high" | "medium" | "low",
    "direction": "risk" | "opportunity" | "silence",
    "description": "一行の説明",
    "evidence": { "data_points": ["根拠1", "根拠2"], "overlap_count": 2 },
    "expires_at_days": 14 | 28 | 56
  }
]

データが不十分な場合は空配列[]を返してください。JSON以外は出力しないでください。`),
        },
      ],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "[]";
    let signals: Array<any>;

    try {
      signals = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) signals = [];
      else signals = JSON.parse(jsonMatch[0]);
    }

    if (!Array.isArray(signals)) signals = [];

    // パターン6の二重チェック
    signals = signals.filter((s) => s.pattern_id !== 6);

    const inserted: any[] = [];

    for (const signal of signals) {
      const expiresAt = new Date(
        Date.now() + (signal.expires_at_days || 14) * 24 * 60 * 60 * 1000,
      ).toISOString();

      const { data, error } = await supabase
        .from("signals")
        .insert({
          company_id,
          pattern_id: signal.pattern_id,
          strength: signal.strength,
          direction: signal.direction,
          source: "system",
          description: signal.description,
          evidence: signal.evidence,
          status: "active",
          expires_at: expiresAt,
        })
        .select()
        .single();

      if (!error && data) {
        inserted.push(data);

        // highシグナル → 即時generate-questionをトリガー
        if (signal.strength === "high") {
          try {
            await fetch(
              `${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-question`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                },
                body: JSON.stringify({ company_id, signal_id: data.id }),
              },
            );
          } catch (e) {
            captureError(e as Error, {
              company_id,
              extra: { trigger: "generate-question" },
            });
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true, signals: inserted }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error);
    return new Response(
      JSON.stringify({ error: "シグナル検出に失敗しました" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
