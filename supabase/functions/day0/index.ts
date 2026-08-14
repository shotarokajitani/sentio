// Day0 batch Edge Function — Investigator harness (Planner→Generator→Evaluator)
// Generates 8-block report from real data, evaluates each block, sends via Resend
// spec/03 (Sense) + spec/04 (Act) compliant

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { MODEL_GENERATOR, warnIfModelDeprecated } from "../_shared/models.ts";
import { renderDay0Html, renderDay0Text } from "../_shared/email-html.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";

const DAY0_BLOCK_KEYS = [
  "external_view",
  "reputation",
  "site_health",
  "public_records",
  "opportunities",
  "industry_position",
  "initial_hypothesis",
  "coverage_map",
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

interface BlockPlan {
  key: string;
  title: string;
  dataSources: string[];
  dataAvailable: boolean;
  instructions: string;
}

interface GeneratedBlock {
  key: string;
  title: string;
  content: string;
  hasData: boolean;
  sources: string[];
  tokensUsed: number;
  generationMs: number;
}

interface EvalResult {
  key: string;
  pass: boolean;
  scores: Record<string, { pass: boolean; reason: string }>;
  tokensUsed: number;
}

// ──────────────────────────────────────────────────────
// Data fetchers
// ──────────────────────────────────────────────────────

async function fetchCompanyEvents(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  companyId: string,
) {
  const { data } = await supabase
    .from("events")
    .select("event_id, occurred_at, source, event_type, metrics, sensitivity")
    .eq("company_id", companyId)
    .order("occurred_at", { ascending: false })
    .limit(200);
  return data || [];
}

async function fetchS0Events(supabase: ReturnType<typeof getSupabaseAdmin>) {
  const { data } = await supabase
    .from("events")
    .select("event_id, occurred_at, source, event_type, metrics")
    .is("company_id", null)
    .eq("sensitivity", "S0")
    .order("occurred_at", { ascending: false })
    .limit(50);
  return data || [];
}

async function fetchConnections(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string) {
  const { data } = await supabase
    .from("connections")
    .select("provider, status")
    .eq("company_id", companyId);
  return data || [];
}

async function fetchCompetitors(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string) {
  const { data } = await supabase
    .from("entities")
    .select("canonical_name, attrs")
    .eq("company_id", companyId)
    .eq("type", "competitor");
  return data || [];
}

async function analyzeUrl(url: string): Promise<Record<string, string | null>> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Sentio/1.0", Accept: "text/html" },
      redirect: "follow",
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };

    const contentType = res.headers.get("content-type") || "";
    let charset = "utf-8";
    const cm = contentType.match(/charset=([^\s;]+)/i);
    if (cm) charset = cm[1].toLowerCase();

    const bytes = await res.arrayBuffer();
    let html: string;
    try {
      html = new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }

    // Re-detect charset from meta tag
    if (!cm) {
      const mc = html.match(/<meta[^>]+charset=["']?([^"'\s;>]+)/i);
      if (mc) {
        try {
          html = new TextDecoder(mc[1].toLowerCase(), { fatal: false }).decode(bytes);
        } catch {
          /* keep */
        }
      }
    }

    const extract = (re: RegExp) => {
      const m = html.match(re);
      return m ? m[1].trim() : null;
    };
    const metaContent = (name: string, attr = "name") => {
      const re = new RegExp(
        `<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${name}["']`,
        "i",
      );
      const m = html.match(re);
      return m ? (m[1] || m[2]).trim() : null;
    };

    return {
      title: extract(/<title[^>]*>([^<]+)<\/title>/i),
      description: metaContent("description"),
      h1: extract(/<h1[^>]*>([^<]+)<\/h1>/i),
      ogTitle: metaContent("og:title", "property"),
      ogDescription: metaContent("og:description", "property"),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ──────────────────────────────────────────────────────
// Phase 1: PLANNER
// ──────────────────────────────────────────────────────

function buildPlan(
  companyEvents: Record<string, unknown>[],
  s0Events: Record<string, unknown>[],
  connections: { provider: string; status: string }[],
  competitors: Record<string, unknown>[],
  concern: string | null,
  siteAnalysis: Record<string, string | null>,
): BlockPlan[] {
  const activeProviders = connections.filter((c) => c.status === "active").map((c) => c.provider);

  const calendarEvents = companyEvents.filter((e) => e.event_type === "schedule");
  const transactionEvents = companyEvents.filter((e) => e.event_type === "transaction");
  const gbizEvents = s0Events.filter((e) => (e.source as string)?.includes("gbizinfo"));

  return DAY0_BLOCK_KEYS.map((key) => {
    switch (key) {
      case "external_view":
        return {
          key,
          title: BLOCK_TITLES[key],
          dataSources: ["analyze-url", "calendar", "transaction"],
          dataAvailable: true, // Always attempt: we have company info + events even if site fetch fails
          instructions:
            "URLの実分析結果があれば活用。なくてもカレンダー・入出金データから外部視点で会社を描写。",
        };
      case "reputation":
        return {
          key,
          title: BLOCK_TITLES[key],
          dataSources: [],
          dataAvailable: false,
          instructions: "Google Places / レビューデータは未接続。正直に表示。",
        };
      case "site_health": {
        const monitorEvents = companyEvents.filter((e) => e.event_type === "monitor");
        return {
          key,
          title: BLOCK_TITLES[key],
          dataSources: monitorEvents.length > 0 ? ["monitor:health"] : [],
          dataAvailable: monitorEvents.length > 0,
          instructions:
            monitorEvents.length > 0
              ? "モニターデータからSSL残存日数・応答時間を報告。"
              : "モニターデータは未取得。正直に表示。",
        };
      }
      case "public_records":
        return {
          key,
          title: BLOCK_TITLES[key],
          dataSources: gbizEvents.length > 0 ? ["gbizinfo"] : [],
          dataAvailable: gbizEvents.length > 0,
          instructions:
            gbizEvents.length > 0
              ? "gBizINFOで法人番号が完全一致した企業のみ言及すること。一致しなかった競合は「gBizINFOでは特定できませんでした」の1行で済ませる。一致した企業について補助金採択・認定・事業規模を報告し、自社の入出金・カレンダーデータと交差させて経営者が一枚の絵として掴める描写にする。"
              : "gBizINFOデータなし。正直に表示。",
        };
      case "opportunities":
        return {
          key,
          title: BLOCK_TITLES[key],
          dataSources: [],
          dataAvailable: false,
          instructions: "jGrantsデータは未取得。正直に表示。",
        };
      case "industry_position":
        return {
          key,
          title: BLOCK_TITLES[key],
          dataSources: [],
          dataAvailable: false,
          instructions: "e-Stat・日銀データは未取得。正直に表示。",
        };
      case "initial_hypothesis":
        return {
          key,
          title: BLOCK_TITLES[key],
          dataSources: concern
            ? ["registration:concern", "calendar", "transaction", "gbizinfo"]
            : ["calendar", "transaction"],
          dataAvailable: calendarEvents.length > 0 || transactionEvents.length > 0,
          instructions: concern
            ? "経営者の懸念と全実データを交差させて初期仮説を生成。"
            : "懸念未登録。実データ（カレンダー・入出金）から自動的に見える傾向を報告。",
        };
      case "coverage_map":
        return {
          key,
          title: BLOCK_TITLES[key],
          dataSources: ["system:coverage"],
          dataAvailable: true,
          instructions: "接続状況と各データソースの件数を動的に報告。",
        };
    }
  });
}

// ──────────────────────────────────────────────────────
// Phase 2: GENERATOR (LLM per block)
// ──────────────────────────────────────────────────────

async function generateBlock(
  client: Anthropic,
  model: string,
  plan: BlockPlan,
  context: {
    companyName: string;
    url: string;
    industry: string;
    concern: string | null;
    siteAnalysis: Record<string, string | null>;
    calendarSummary: string;
    transactionSummary: string;
    gbizSummary: string;
    competitorsSummary: string;
    connections: { provider: string; status: string }[];
    eventCounts: Record<string, number>;
  },
): Promise<GeneratedBlock> {
  // coverage_map is deterministic (no LLM needed)
  if (plan.key === "coverage_map") {
    const active = context.connections.filter((c) => c.status === "active").map((c) => c.provider);

    const connected: string[] = [];
    const notConnected: string[] = [];

    if (active.includes("google_calendar")) {
      connected.push(`カレンダー(${context.eventCounts["google_calendar"] || 0}件)`);
    } else {
      notConnected.push("カレンダー(予定の異常)");
    }

    const csvCount = context.eventCounts["csv:accounting"] || 0;
    if (active.includes("freee") || csvCount > 0) {
      connected.push(`入出金CSV[入出金明細からの暫定集計・${csvCount}件]`);
    } else {
      notConnected.push("入出金(収支の変化)");
    }

    if (!active.includes("slack")) notConnected.push("Slack(コミュニケーション変化)");
    notConnected.push("勤怠(労務リスク)");

    const parts: string[] = [];
    if (connected.length > 0) parts.push(`現在の接続: ${connected.join("、")}`);
    if (notConnected.length > 0)
      parts.push(`追加接続で見えるようになる領域: ${notConnected.join("、")}`);

    return {
      key: plan.key,
      title: plan.title,
      content: parts.join("。"),
      hasData: true,
      sources: ["system:coverage"],
      tokensUsed: 0,
      generationMs: 0,
    };
  }

  // Blocks with no data: honest display (no LLM needed)
  if (!plan.dataAvailable && plan.key !== "initial_hypothesis") {
    const noDataMessages: Record<string, string> = {
      reputation:
        "評判データ（Google Places等）はまだ接続されていません。接続後に競合との比較が可能になります。",
      site_health: "サイト健全性のモニタリングはまだ開始されていません。",
      opportunities: "補助金・助成金情報（jGrants）はまだ取得されていません。",
      industry_position: "業界統計（e-Stat・日銀）はまだ取得されていません。",
    };
    return {
      key: plan.key,
      title: plan.title,
      content: noDataMessages[plan.key] || "このブロックのデータはまだ利用できません。",
      hasData: false,
      sources: [],
      tokensUsed: 0,
      generationMs: 0,
    };
  }

  // Build block-specific data context
  let dataContext = "";
  switch (plan.key) {
    case "external_view":
      dataContext = `## URL分析結果（${context.url}）
タイトル: ${context.siteAnalysis.title || "取得不可"}
説明: ${context.siteAnalysis.description || "なし"}
H1: ${context.siteAnalysis.h1 || "なし"}
OGタイトル: ${context.siteAnalysis.ogTitle || "なし"}
OG説明: ${context.siteAnalysis.ogDescription || "なし"}
${context.siteAnalysis.error ? `(サイト取得エラー: ${context.siteAnalysis.error})` : ""}

## カレンダーデータ概要
${context.calendarSummary}

## 入出金データ概要
${context.transactionSummary}

## 推定競合
${context.competitorsSummary || "推定なし"}`;
      break;
    case "public_records":
      dataContext = `## gBizINFO取得データ
${context.gbizSummary || "データなし"}

## 自社の概要（比較材料として）
会社: ${context.companyName}（${context.industry}）
入出金概要: ${context.transactionSummary}
カレンダー概要: ${context.calendarSummary}`;
      break;
    case "initial_hypothesis":
      dataContext = `## カレンダーデータ分析
${context.calendarSummary}

## 入出金データ分析
${context.transactionSummary}

## 外部データ
${context.gbizSummary || "なし"}
${context.concern ? `\n## 経営者の懸念\n${context.concern}` : "（懸念未登録: 実データから見える傾向を報告すること）"}`;
      break;
    default:
      dataContext = "データなし";
  }

  const start = Date.now();
  const { data: response, response: rawResponse } = await client.messages
    .create({
      model,
      max_tokens: 16000,
      messages: [
        {
          role: "user",
          content: `あなたはSentioのDay0レポート生成器です。以下のブロックの本文を生成してください。

## ブロック: ${plan.title}
## 会社: ${context.companyName}（${context.industry}）
## URL: ${context.url}

## 実データ
${dataContext}

## Day0生成ルール（厳守）
- 以下の3パート構造で書くこと:
  【見えたこと】実データから直接読み取れる事実（数字・傾向・固有名詞を含む）
  【根拠】その事実の出所（「入出金明細によると」「カレンダーデータによると」「gBizINFOによると」等）
  【考えられること】事実から推察される示唆（暫定推察であることを明示）
- 「外部データのみに基づく暫定推察」であることを冒頭に明示すること
- 断定表現は不合格（「である」「に違いない」「確実に」「必ず」は使用禁止）
- データがないことを推測で埋めないこと
- 入出金データがある場合: 資金の出入りのリズム、大きな支出、入金元の集中度を分析すること
- カレンダーデータがある場合: 時間配分、会議相手の傾向を分析すること

日本語で各パート2〜4文。本文のみ出力（ブロックタイトルやマークダウンヘッダーは不要。パート見出し【見えたこと】【根拠】【考えられること】は出力する）。`,
        },
      ],
    })
    .withResponse();
  warnIfModelDeprecated(rawResponse.headers, model);

  const genTextBlock = response.content.find((c: { type: string }) => c.type === "text");
  const text =
    genTextBlock && "text" in genTextBlock
      ? (genTextBlock as { type: "text"; text: string }).text
      : "";
  const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

  return {
    key: plan.key,
    title: plan.title,
    content: text,
    hasData: true,
    sources: plan.dataSources,
    tokensUsed,
    generationMs: Date.now() - start,
  };
}

// ──────────────────────────────────────────────────────
// Phase 2b: REVISE (re-generate with Evaluator feedback)
// ──────────────────────────────────────────────────────

async function reviseBlock(
  client: Anthropic,
  model: string,
  plan: BlockPlan,
  context: Parameters<typeof generateBlock>[3],
  previousContent: string,
  evaluatorFeedback: string,
  attempt: number,
): Promise<GeneratedBlock> {
  const start = Date.now();
  const { data: reviseResponse, response: reviseRawResponse } = await client.messages
    .create({
      model,
      max_tokens: 16000,
      messages: [
        {
          role: "user",
          content: `あなたはSentioのDay0レポート生成器です。前回生成したブロックがEvaluatorに不合格とされました。フィードバックを反映して書き直してください。

## ブロック: ${plan.title}（リバイズ${attempt}回目）
## 会社: ${context.companyName}（${context.industry}）

## 前回の生成内容
${previousContent}

## Evaluatorフィードバック（不通過理由）
${evaluatorFeedback}

## 重要な指示
- 経営者の頭に「自社の今の姿」が一枚の絵として浮かぶよう、具体的な数字・傾向を織り交ぜた物語として書くこと
- 数字の羅列ではなく、数字が何を意味するかを語ること
- 全ての記述に出所を明示すること
- 「外部データのみに基づく暫定推察」であることを明示すること
- 断定表現は不合格

日本語で5〜10文。本文のみ出力。`,
        },
      ],
    })
    .withResponse();
  warnIfModelDeprecated(reviseRawResponse.headers, model);

  const revTextBlock = reviseResponse.content.find((c: { type: string }) => c.type === "text");
  const text =
    revTextBlock && "text" in revTextBlock
      ? (revTextBlock as { type: "text"; text: string }).text
      : "";
  const tokensUsed =
    (reviseResponse.usage?.input_tokens || 0) + (reviseResponse.usage?.output_tokens || 0);

  return {
    key: plan.key,
    title: plan.title,
    content: text,
    hasData: true,
    sources: plan.dataSources,
    tokensUsed,
    generationMs: Date.now() - start,
  };
}

// ──────────────────────────────────────────────────────
// Phase 3: EVALUATOR (Day0 variant)
// ──────────────────────────────────────────────────────

async function evaluateBlock(
  client: Anthropic,
  model: string,
  block: GeneratedBlock,
): Promise<EvalResult> {
  // Skip evaluation for no-data blocks and deterministic blocks
  if (!block.hasData || block.tokensUsed === 0) {
    return {
      key: block.key,
      pass: true, // No-data honest display always passes
      scores: { honest_display: { pass: true, reason: "データなしの正直表示" } },
      tokensUsed: 0,
    };
  }

  const { data: evalBlockResponse, response: evalBlockRawResponse } = await client.messages
    .create({
      model,
      max_tokens: 16000,
      system: `あなたはSentioのDay0レポートEvaluatorです。採点結果をJSON形式のみで返してください。JSON以外のテキスト（説明・マークダウン・コードブロック記号）は一切出力しないでください。`,
      messages: [
        {
          role: "user",
          content: `採点対象ブロック「${block.title}」:
${block.content}

ハード基準（全5基準を通過した場合のみpass。1つでもfailならoverall_pass:false）:
1 像: このブロックを読んだ経営者の頭に、自社の状態が一枚の絵として浮かぶか。数字の羅列や一般論は不合格
2 出所: 全事実に出所が明示されているか（例:「入出金明細によると」「カレンダーデータによると」）。出所不明の事実が1つでもあれば不合格
3 暫定推察: 「外部データのみに基づく暫定推察」であることが明示されているか。断定表現（「である」「に違いない」「確実に」）があれば不合格
4 トーン: 誰かを責めていないか。上から目線・査定口調でないか
5 具体: 実データに基づく数字・傾向・固有名詞が含まれているか。抽象的な一般論のみなら不合格

回答は以下のJSON構造のみ:
{"criteria_1":{"pass":true,"reason":"..."},"criteria_2":{"pass":true,"reason":"..."},"criteria_3":{"pass":true,"reason":"..."},"criteria_4":{"pass":true,"reason":"..."},"criteria_5":{"pass":true,"reason":"..."},"overall_pass":true,"feedback":"不通過時の改善指示"}`,
        },
      ],
    })
    .withResponse();
  warnIfModelDeprecated(evalBlockRawResponse.headers, model);

  const textBlock = evalBlockResponse.content.find((c: { type: string }) => c.type === "text");
  const text =
    textBlock && "text" in textBlock ? (textBlock as { type: "text"; text: string }).text : "{}";
  const tokensUsed =
    (evalBlockResponse.usage?.input_tokens || 0) + (evalBlockResponse.usage?.output_tokens || 0);

  // Robust JSON extraction: find the outermost { ... } handling nested objects
  let braceDepth = 0;
  let jsonStart = -1;
  let jsonEnd = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (braceDepth === 0) jsonStart = i;
      braceDepth++;
    } else if (text[i] === "}") {
      braceDepth--;
      if (braceDepth === 0 && jsonStart >= 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  if (jsonStart < 0 || jsonEnd < 0) {
    return {
      key: block.key,
      pass: false,
      scores: { parse_error: { pass: false, reason: "Evaluator出力にJSONが見つからない" } },
      tokensUsed,
    };
  }

  try {
    const parsed = JSON.parse(text.substring(jsonStart, jsonEnd));
    const scores: Record<string, { pass: boolean; reason: string }> = {};
    for (let i = 1; i <= 5; i++) {
      const c = parsed[`criteria_${i}`];
      if (c) scores[`criteria_${i}`] = { pass: !!c.pass, reason: c.reason || "" };
    }
    // Compute pass from individual criteria AND (not LLM's overall_pass)
    const allCriteriaPass =
      Object.values(scores).length >= 5 && Object.values(scores).every((s) => s.pass);
    return {
      key: block.key,
      pass: allCriteriaPass,
      scores,
      tokensUsed,
    };
  } catch {
    return {
      key: block.key,
      pass: false,
      scores: {
        parse_error: {
          pass: false,
          reason: `JSON parse failed: ${text.substring(jsonStart, Math.min(jsonStart + 100, jsonEnd))}...`,
        },
      },
      tokensUsed,
    };
  }
}

// ──────────────────────────────────────────────────────
// Data summarizers (no PII leakage to LLM)
// ──────────────────────────────────────────────────────

function summarizeCalendar(events: Record<string, unknown>[]): string {
  const calEvents = events.filter((e) => e.event_type === "schedule");
  if (calEvents.length === 0) return "カレンダーデータなし";

  const titles = calEvents.map(
    (e) => ((e.metrics as Record<string, unknown>)?.title as string) || "(無題)",
  );
  const dates = calEvents.map((e) => (e.occurred_at as string).split("T")[0]);

  // Meeting partner analysis
  const partnerCounts: Record<string, number> = {};
  for (const e of calEvents) {
    const m = e.metrics as Record<string, unknown>;
    const attendees = (m?.attendees as string[]) || [];
    for (const a of attendees) {
      const domain = a.split("@")[1];
      if (domain) partnerCounts[domain] = (partnerCounts[domain] || 0) + 1;
    }
  }
  const topPartners = Object.entries(partnerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain, count]) => `${domain}: ${count}件`);

  // Time distribution
  const monthCounts: Record<string, number> = {};
  for (const d of dates) {
    const month = d.substring(0, 7);
    monthCounts[month] = (monthCounts[month] || 0) + 1;
  }

  const earliest = dates[dates.length - 1];
  const latest = dates[0];

  return `全${calEvents.length}件（${earliest}〜${latest}）
月別分布: ${Object.entries(monthCounts)
    .map(([m, c]) => `${m}: ${c}件`)
    .join("、")}
予定タイトル例: ${titles.slice(0, 5).join("、")}
会議相手ドメイン: ${topPartners.length > 0 ? topPartners.join("、") : "出席者情報なし"}`;
}

function summarizeTransactions(events: Record<string, unknown>[]): string {
  const txEvents = events.filter((e) => e.event_type === "transaction");
  if (txEvents.length === 0) return "入出金データなし";

  let totalCredit = 0,
    totalDebit = 0;
  let creditCount = 0,
    debitCount = 0;
  let maxCredit = 0,
    maxDebit = 0;
  const dates: string[] = [];

  for (const e of txEvents) {
    const m = e.metrics as Record<string, unknown>;
    const amount = (m?.amount as number) || 0;
    const direction = m?.direction as string;
    dates.push((e.occurred_at as string).split("T")[0]);

    if (direction === "credit" || amount > 0) {
      const absAmt = Math.abs(amount);
      totalCredit += absAmt;
      creditCount++;
      if (absAmt > maxCredit) maxCredit = absAmt;
    }
    if (direction === "debit" || amount < 0) {
      const absAmt = Math.abs(amount);
      totalDebit += absAmt;
      debitCount++;
      if (absAmt > maxDebit) maxDebit = absAmt;
    }
  }

  const earliest = dates[dates.length - 1];
  const latest = dates[0];

  // Monthly breakdown
  const monthlyNet: Record<string, { credit: number; debit: number }> = {};
  for (const e of txEvents) {
    const m = e.metrics as Record<string, unknown>;
    const amount = Math.abs((m?.amount as number) || 0);
    const direction = m?.direction as string;
    const month = (e.occurred_at as string).substring(0, 7);
    if (!monthlyNet[month]) monthlyNet[month] = { credit: 0, debit: 0 };
    if (direction === "credit") monthlyNet[month].credit += amount;
    else monthlyNet[month].debit += amount;
  }

  const fmt = (n: number) => n.toLocaleString("ja-JP");

  return `全${txEvents.length}件（${earliest}〜${latest}）
入金: ${creditCount}件・合計¥${fmt(totalCredit)}・最大¥${fmt(maxCredit)}
出金: ${debitCount}件・合計¥${fmt(totalDebit)}・最大¥${fmt(maxDebit)}
月別:
${Object.entries(monthlyNet)
  .map(
    ([m, v]) =>
      `  ${m}: 入金¥${fmt(v.credit)} / 出金¥${fmt(v.debit)} / 差引¥${fmt(v.credit - v.debit)}`,
  )
  .join("\n")}`;
}

function summarizeGbiz(events: Record<string, unknown>[]): string {
  const gbiz = events.filter((e) => (e.source as string)?.includes("gbizinfo"));
  if (gbiz.length === 0) return "";

  return gbiz
    .map((e) => {
      const m = e.metrics as Record<string, unknown>;
      if (m.type === "subsidy") return `補助金採択: ${m.company_name} — ${m.title}`;
      if (m.type === "certification") return `認定: ${m.company_name} — ${m.title}`;
      if (m.type === "corporate_info")
        return `法人情報: ${m.name}（${m.location || "所在地不明"}）`;
      return JSON.stringify(m);
    })
    .join("\n");
}

// ──────────────────────────────────────────────────────
// Main handler
// ──────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const start = Date.now();

  try {
    const input: Day0Input = await req.json();
    const { company_id, company_name, url, industry, concern, email } = input;

    const model = MODEL_GENERATOR;
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY must be set" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const client = new Anthropic({ apiKey });
    const supabase = getSupabaseAdmin();

    // ── Gather all data ──
    const [companyEvents, s0Events, connections, competitors, siteAnalysis] = await Promise.all([
      fetchCompanyEvents(supabase, company_id),
      fetchS0Events(supabase),
      fetchConnections(supabase, company_id),
      fetchCompetitors(supabase, company_id),
      analyzeUrl(url),
    ]);

    // Event counts for coverage_map
    const eventCounts: Record<string, number> = {};
    for (const e of companyEvents) {
      const src = e.source as string;
      eventCounts[src] = (eventCounts[src] || 0) + 1;
    }

    // Summarize data for LLM context
    const calendarSummary = summarizeCalendar(companyEvents);
    const transactionSummary = summarizeTransactions(companyEvents);
    const gbizSummary = summarizeGbiz(s0Events);
    const competitorsSummary =
      competitors.length > 0
        ? competitors
            .map(
              (c) => `- ${c.canonical_name}: ${(c.attrs as Record<string, string>)?.reason || ""}`,
            )
            .join("\n")
        : "競合推定なし";

    // ── PLANNER ──
    const plan = buildPlan(
      companyEvents,
      s0Events,
      connections,
      competitors,
      concern,
      siteAnalysis,
    );

    // ── GENERATOR (parallel) ──
    const generatorContext = {
      companyName: company_name,
      url,
      industry,
      concern,
      siteAnalysis,
      calendarSummary,
      transactionSummary,
      gbizSummary,
      competitorsSummary,
      connections,
      eventCounts,
    };

    const blocks = await Promise.all(
      plan.map((blockPlan) => generateBlock(client, model, blockPlan, generatorContext)),
    );
    let totalGeneratorTokens = blocks.reduce((sum, b) => sum + b.tokensUsed, 0);

    // ── EVALUATOR with revise loop (spec: revise ≤ 1 to stay within timeout) ──
    const MAX_REVISE = 1;

    // Evaluate all blocks in parallel
    const initialEvals = await Promise.all(
      blocks.map((block) => evaluateBlock(client, model, block)),
    );
    let totalEvaluatorTokens = initialEvals.reduce((sum, e) => sum + e.tokensUsed, 0);

    // Revise failed LLM blocks in parallel
    const revisePromises = initialEvals.map(async (evalResult, idx) => {
      if (evalResult.pass || blocks[idx].tokensUsed === 0) {
        return { block: blocks[idx], eval: evalResult };
      }

      // Revise once
      const feedback = Object.entries(evalResult.scores)
        .filter(([, v]) => !v.pass)
        .map(([k, v]) => `${k}: ${v.reason}`)
        .join("\n");

      const revisedBlock = await reviseBlock(
        client,
        model,
        plan[idx],
        generatorContext,
        blocks[idx].content,
        feedback,
        1,
      );

      const revisedEval = await evaluateBlock(client, model, revisedBlock);
      return { block: revisedBlock, eval: revisedEval };
    });

    const reviseResults = await Promise.all(revisePromises);

    const evalResults: EvalResult[] = [];
    const passedBlocks: GeneratedBlock[] = [];

    for (let i = 0; i < reviseResults.length; i++) {
      const { block, eval: evalResult } = reviseResults[i];
      // Count revised block tokens (not already counted in initial generation)
      if (block !== blocks[i]) totalGeneratorTokens += block.tokensUsed;
      // Count revised eval tokens (initial eval already counted above)
      if (evalResult !== initialEvals[i]) totalEvaluatorTokens += evalResult.tokensUsed;
      evalResults.push(evalResult);
      if (evalResult.pass) passedBlocks.push(block);
    }

    const generationTimeMs = Date.now() - start;
    const totalTokens = totalGeneratorTokens + totalEvaluatorTokens;

    // ── fail-closed: if all LLM-generated blocks fail, don't send ──
    const llmBlocks = blocks.filter((b) => b.tokensUsed > 0);
    const passedLlmBlocks = passedBlocks.filter((b) => b.tokensUsed > 0);

    if (llmBlocks.length > 0 && passedLlmBlocks.length === 0) {
      return new Response(
        JSON.stringify({
          status: "fail_closed",
          reason: "全LLM生成ブロックがEvaluator不通過。送信を中止しました。",
          eval_log: evalResults,
          generation_time_ms: generationTimeMs,
          total_tokens: totalTokens,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const report = {
      company_id,
      blocks: passedBlocks.map((b) => ({
        key: b.key,
        title: b.title,
        content: b.content,
        hasData: b.hasData,
        sources: b.sources,
      })),
      eval_log: evalResults,
      generated_at: new Date().toISOString(),
      generation_time_ms: generationTimeMs,
      total_tokens: totalTokens,
      generator_tokens: totalGeneratorTokens,
      evaluator_tokens: totalEvaluatorTokens,
      blocks_generated: blocks.length,
      blocks_passed: passedBlocks.length,
    };

    // Send via Resend — fail-closed: missing config is an error, not a silent skip
    if (!resendKey) {
      return new Response(
        JSON.stringify({ status: "error", reason: "RESEND_API_KEY not configured", report }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let emailStatus = "skipped";
    let emailId: string | undefined;
    let sendError: string | undefined;

    if (email) {
      const resendFrom = Deno.env.get("RESEND_FROM");
      if (!resendFrom) {
        await supabase.from("delivery_log").insert({
          id: crypto.randomUUID(),
          company_id,
          channel: "email",
          delivery_type: "day0",
          content: report,
          status: "failed",
          created_at: new Date().toISOString(),
        });
        return new Response(
          JSON.stringify({
            status: "error",
            reason: "RESEND_FROM未設定。サンドボックス送信を防止しました。",
            report,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const emailHtml = renderDay0Html(company_name, passedBlocks, {
        generationTimeMs,
        totalTokens,
        passedCount: passedBlocks.length,
        totalCount: blocks.length,
      });
      const emailText = renderDay0Text(company_name, passedBlocks);

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: resendFrom,
          to: [email],
          subject: `[Sentio] Day0レポート: ${company_name}`,
          html: emailHtml,
          text: emailText,
        }),
      });

      const resendBody = await resendRes.json().catch(() => ({}));

      if (resendRes.ok) {
        emailId = resendBody.id;
        emailStatus = "sent";
        console.log(`Resend OK: email_id=${emailId}`);
      } else {
        emailStatus = "failed";
        sendError = `Resend ${resendRes.status}: ${resendBody.message || JSON.stringify(resendBody)}`;
        console.error(`Resend failed: ${sendError}`);
      }
    }

    // Store in delivery_log (actual send status)
    const { error: logErr } = await supabase.from("delivery_log").insert({
      id: crypto.randomUUID(),
      company_id,
      channel: "email",
      delivery_type: "day0",
      content: { ...report, email_id: emailId },
      status: emailStatus,
      created_at: new Date().toISOString(),
    });

    if (logErr) {
      return new Response(
        JSON.stringify({ error: `delivery_log insert failed: ${logErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (emailStatus === "failed") {
      return new Response(JSON.stringify({ status: "error", reason: sendError, report }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ status: "ok", email_id: emailId, report }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
