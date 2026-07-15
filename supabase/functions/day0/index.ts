// Day0 batch Edge Function — runs within 10 minutes of registration (A1)
// Generates 8-block report, sends via Resend
// Uses Anthropic API for initial_hypothesis block (model from ANTHROPIC_MODEL env)
// Reads prompts from filesystem at runtime (code embedding prohibited)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";

const DAY0_BLOCK_KEYS = [
  "external_view", "reputation", "site_health", "public_records",
  "opportunities", "industry_position", "initial_hypothesis", "coverage_map",
] as const;

const BLOCK_TITLES: Record<string, string> = {
  external_view: "外から見た自社",
  reputation: "評判の座標",
  site_health: "サイト健全性",
  public_records: "公的記録の非対称",
  opportunities: "今使える機会",
  industry_position: "業界・地域の中の位置",
  initial_hypothesis: "初期懸念への初期仮説",
  coverage_map: "見えるようになる地図",
};

interface Day0Input {
  company_id: string;
  company_name: string;
  url: string;
  industry: string;
  concern: string | null;
  email: string;
}

async function loadPrompt(filename: string): Promise<string> {
  const path = new URL(`../../../prompts/${filename}`, import.meta.url).pathname;
  return await Deno.readTextFile(path);
}

// Fetch S0 data from events table (company_id=null, sensitivity=S0)
async function fetchS0Data(supabase: ReturnType<typeof getSupabaseAdmin>) {
  const { data } = await supabase
    .from("events")
    .select("*")
    .is("company_id", null)
    .eq("sensitivity", "S0")
    .order("occurred_at", { ascending: false })
    .limit(50);
  return data || [];
}

// Fetch monitor data for the company's URL
async function fetchSiteHealth(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  companyId: string,
) {
  const { data } = await supabase
    .from("events")
    .select("metrics, occurred_at")
    .eq("company_id", companyId)
    .eq("event_type", "monitor")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .single();
  return data;
}

// Generate initial_hypothesis block via LLM when concern is provided
async function generateHypothesis(
  client: Anthropic,
  model: string,
  concern: string,
  s0Context: string,
): Promise<string> {
  const evaluatorCriteria = await loadPrompt("evaluator_criteria.md");
  // Day0 variant: criteria 2 = "source attribution", assertive expressions forbidden
  const day0Note = evaluatorCriteria
    .split("\n")
    .filter((l) => l.includes("Day0"))
    .join("\n");

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `あなたはSentioのDay0レポート生成器です。経営者の懸念に対して、外部データのみに基づく暫定的な推察を生成してください。

## 経営者の懸念
${concern}

## 利用可能な外部データ
${s0Context}

## Day0変形ルール
${day0Note}
- 全ての記述に出所を明示すること
- 「外部データのみに基づく暫定推察」であることを明示すること
- 断定表現は不合格（「である」「に違いない」「確実に」「必ず」は使用禁止）

暫定推察を日本語で3-5文で生成してください。`,
      },
    ],
  });

  return response.content[0].type === "text"
    ? response.content[0].text
    : "暫定推察の生成に失敗しました";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const start = Date.now();

  try {
    const input: Day0Input = await req.json();
    const { company_id, company_name, url, industry, concern, email } = input;

    const model = Deno.env.get("ANTHROPIC_MODEL");
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");

    if (!model || !apiKey) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_MODEL and ANTHROPIC_API_KEY must be set" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const client = new Anthropic({ apiKey });
    const supabase = getSupabaseAdmin();

    // Gather data
    const [s0Events, siteHealth] = await Promise.all([
      fetchS0Data(supabase),
      fetchSiteHealth(supabase, company_id),
    ]);

    // Categorize S0 data
    const publicRecords = s0Events.filter((e) => e.source?.includes("gbizinfo"));
    const opportunities = s0Events.filter((e) => e.source?.includes("jgrants"));
    const industryData = s0Events.filter((e) =>
      e.source?.includes("estat") || e.source?.includes("boj")
    );

    // Build 8 blocks
    const blocks = await Promise.all(
      DAY0_BLOCK_KEYS.map(async (key) => {
        switch (key) {
          case "external_view":
            return {
              key, title: BLOCK_TITLES[key],
              content: `${company_name}(${url})の外部からの観察です。業種: ${industry}`,
              hasData: true,
              sources: ["URL analysis"],
            };

          case "reputation":
            return {
              key, title: BLOCK_TITLES[key],
              content: "評判データは接続後に利用可能になる見込みです",
              hasData: false, sources: [],
            };

          case "site_health":
            if (siteHealth?.metrics) {
              const m = siteHealth.metrics as Record<string, unknown>;
              return {
                key, title: BLOCK_TITLES[key],
                content: `SSL残存: ${m.ssl_days_remaining ?? "不明"}日、応答時間: ${m.response_time_ms ?? "不明"}msと観測されました (${siteHealth.occurred_at}時点)`,
                hasData: true,
                sources: ["monitor:health", "monitor:ssl"],
              };
            }
            return {
              key, title: BLOCK_TITLES[key],
              content: "サイト健全性データは取得できませんでした",
              hasData: false, sources: [],
            };

          case "public_records":
            if (publicRecords.length > 0) {
              return {
                key, title: BLOCK_TITLES[key],
                content: publicRecords
                  .map((r) => `${JSON.stringify(r.metrics)} (${r.source}より)`)
                  .join("\n"),
                hasData: true,
                sources: publicRecords.map((r) => r.source),
              };
            }
            return {
              key, title: BLOCK_TITLES[key],
              content: "該当する公的記録は確認されませんでした",
              hasData: false, sources: [],
            };

          case "opportunities":
            if (opportunities.length > 0) {
              return {
                key, title: BLOCK_TITLES[key],
                content: opportunities
                  .map((o) => `${JSON.stringify(o.metrics)} (${o.source}より)`)
                  .join("\n"),
                hasData: true,
                sources: opportunities.map((o) => o.source),
              };
            }
            return {
              key, title: BLOCK_TITLES[key],
              content: "利用可能な機会情報はありません",
              hasData: false, sources: [],
            };

          case "industry_position":
            if (industryData.length > 0) {
              return {
                key, title: BLOCK_TITLES[key],
                content: industryData
                  .map((d) => `${JSON.stringify(d.metrics)} (${d.source}より)`)
                  .join("\n"),
                hasData: true,
                sources: industryData.map((d) => d.source),
              };
            }
            return {
              key, title: BLOCK_TITLES[key],
              content: "業界データは収集中です",
              hasData: false, sources: [],
            };

          case "initial_hypothesis":
            if (concern) {
              const s0Context = s0Events
                .slice(0, 10)
                .map((e) => `${e.source}: ${JSON.stringify(e.metrics)}`)
                .join("\n");
              const hypothesis = await generateHypothesis(
                client, model, concern, s0Context,
              );
              return {
                key, title: BLOCK_TITLES[key],
                content: hypothesis,
                hasData: true,
                sources: ["registration:concern", ...s0Events.slice(0, 5).map((e) => e.source)],
              };
            }
            return {
              key, title: BLOCK_TITLES[key],
              content: "懸念は登録されていません。データ接続後に検知を開始します",
              hasData: false, sources: [],
            };

          case "coverage_map":
            return {
              key, title: BLOCK_TITLES[key],
              content: "現在の接続: 会計CSV。追加接続で見えるようになる領域: カレンダー(予定の異常), 勤怠(労務リスク), Slack(コミュニケーション変化)",
              hasData: true,
              sources: ["system:coverage"],
            };
        }
      }),
    );

    const generationTimeMs = Date.now() - start;

    const report = {
      company_id,
      blocks,
      generated_at: new Date().toISOString(),
      generation_time_ms: generationTimeMs,
    };

    // Store in delivery_log
    await supabase.from("delivery_log").insert({
      id: crypto.randomUUID(),
      company_id,
      channel: "email",
      delivery_type: "day0",
      content: report,
      status: "sent",
      created_at: new Date().toISOString(),
    });

    // Send via Resend
    if (resendKey && email) {
      const htmlBlocks = blocks
        .map((b) => {
          const style = b.hasData
            ? ""
            : 'style="color: #999;"';
          return `<h3 ${style}>${b.title}</h3><p ${style}>${b.content.replace(/\n/g, "<br>")}</p>`;
        })
        .join("");

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Sentio <noreply@sentio.app>",
          to: [email],
          subject: `[Sentio] Day0レポート: ${company_name}`,
          html: `<h1>Day0レポート: ${company_name}</h1>${htmlBlocks}<hr><p style="font-size:12px;color:#999;">生成時間: ${generationTimeMs}ms</p>`,
        }),
      });
    }

    return new Response(
      JSON.stringify({ status: "ok", report }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
