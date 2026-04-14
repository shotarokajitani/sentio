import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";
import { sanitizePII } from "../_shared/sanitize.ts";

initSentry("suggest-competitors");

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

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: sanitizePII(`以下の会社の競合候補を3〜5社提案してください。

会社名: ${company.company_name}
URL: ${company.url || "不明"}
業種: ${company.industry || "不明"}

JSON形式で出力してください:
{
  "competitors": [
    { "name": "会社名", "url": "https://...", "reason": "競合と判断した理由" }
  ]
}

条件:
- 実在する日本の企業のみ
- URLは実際にアクセス可能なもの
- 同業種・同規模・同市場の企業
- JSON以外は出力しない`),
        },
      ],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";
    let parsed: {
      competitors: Array<{ name: string; url: string; reason: string }>;
    };

    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch)
        throw new Error("Failed to parse Claude response as JSON");
      parsed = JSON.parse(jsonMatch[0]);
    }

    const validCompetitors: Array<{
      name: string;
      url: string;
      reason: string;
    }> = [];

    // URLの実在確認（HEAD request）
    for (const comp of parsed.competitors) {
      try {
        const headRes = await fetch(comp.url, {
          method: "HEAD",
          redirect: "follow",
        });
        if (headRes.ok || headRes.status === 405 || headRes.status === 403) {
          validCompetitors.push(comp);
        }
      } catch {
        // URLが無効な場合はスキップ
      }
    }

    // competitorsテーブルに保存（confirmed=false）
    for (const comp of validCompetitors) {
      await supabase.from("competitors").upsert(
        {
          company_id,
          name: comp.name,
          url: comp.url,
          reason: comp.reason,
          confirmed: false,
        },
        { onConflict: "company_id,url" },
      );
    }

    return new Response(
      JSON.stringify({ success: true, competitors: validCompetitors }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    captureError(error as Error);
    return new Response(JSON.stringify({ error: "競合提案に失敗しました" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
