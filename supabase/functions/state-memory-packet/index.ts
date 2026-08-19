// State-memory-packet Edge Function — assembles memory packet within token budget
// Unified recall mechanism for Investigator, "Ask Sentio", and weekly generation

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { errorResponse, mustData, mustMaybe } from "../_shared/db.ts";
import { toFlatBaselines } from "../_shared/baseline-stats.ts";
import { decayedConfidence } from "../_shared/narrative-confidence.ts";

function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は **DBに触る前**（契約 S-2-9）。
  // 修復前はここが無く、認証情報ゼロでも 200 と実データを返していた
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const { company_id: bodyCompanyId, token_budget = 4000 } = await req.json();

    const scope = resolveCompanyId(caller.caller, bodyCompanyId);
    if (!scope.ok) return scope.response;
    const company_id = scope.companyId;

    const supabase = getSupabaseAdmin();

    // Gather sections from DB
    const [summary, baselines, events, findings, narratives] = await Promise.all([
      mustMaybe<{ content: string }>(
        supabase
          .from("company_summary")
          .select("content")
          .eq("company_id", company_id)
          .maybeSingle(),
        "state-memory-packet: company_summary",
      ),
      mustData(
        supabase
          .from("baselines")
          .select("metric_key, is_established, stats")
          .eq("company_id", company_id)
          .eq("is_established", true),
        "state-memory-packet: baselines",
      ),
      mustData(
        supabase
          .from("events")
          .select("event_id, event_type, source, occurred_at")
          .eq("company_id", company_id)
          .order("occurred_at", { ascending: false })
          .limit(20),
        "state-memory-packet: events",
      ),
      mustData(
        supabase
          .from("findings")
          .select("what, urgency, status, evidence_event_ids")
          .eq("company_id", company_id)
          .in("status", ["open", "watching"]),
        "state-memory-packet: findings",
      ),
      mustData(
        supabase
          .from("narratives")
          // 実在列は category / topic / content / confidence / source_event_ids /
          // last_confirmed_at。`updated_at` は存在しない（P-2）
          .select("category, topic, content, confidence, last_confirmed_at")
          .eq("company_id", company_id)
          .order("last_confirmed_at", { ascending: false, nullsFirst: false })
          .limit(10),
        "state-memory-packet: narratives",
      ),
    ]);

    // Build section candidates with priorities (lower = higher priority)
    const rawSections = [
      { type: "summary", priority: 1, content: summary?.content || "(no summary)" },
      {
        type: "baselines",
        priority: 2,
        // 統計は `stats` JSONB から取り出す。変換はアダプタ1本だけを通す（S-1-2）
        content:
          toFlatBaselines(baselines)
            .map((b) => `${b.metric_key}: median=${b.median}, iqr=${b.iqr}`)
            .join("\n") || "(no baselines)",
      },
      {
        type: "recent_events",
        priority: 3,
        // metrics を載せない。編成器は spec/02「想起の一元化」により Investigator・週次生成・
        // 「Sentioに聞く」の共通経路なので、ここに本文を足すと3機能すべてに一斉に
        // 予定の件名や取引の摘要が流れ込む（LLMへの送信面が一段広がる）
        content:
          (events || [])
            .map(
              (e: { event_type: string; source: string; occurred_at: string }) =>
                `[${e.event_type}] ${e.source} @ ${e.occurred_at}`,
            )
            .join("\n") || "(no recent events)",
      },
      {
        type: "findings",
        priority: 4,
        content:
          (findings || [])
            .map((f: { what: string; urgency: string }) => `[${f.urgency}] ${f.what}`)
            .join("\n") || "(no open findings)",
      },
      {
        type: "narratives",
        priority: 5,
        // category / topic を添える。どの面の話かが分からないと編成器の後段で使えない
        // confidence は**読む側で減衰させる**（S-1-3）。保存値は最後に確認した時点の値で、
        // 実効値は last_confirmed_at からの経過で減る
        content:
          narratives
            .map(
              (n: {
                category: string;
                topic: string;
                content: string;
                confidence: number;
                last_confirmed_at: string | null;
              }) =>
                `[${n.category}/${n.topic}] (conf=${decayedConfidence(n.confidence, n.last_confirmed_at, new Date()).toFixed(2)}) ${n.content}`,
            )
            .join("\n") || "(no narratives)",
      },
    ];

    // Assemble within budget
    const assembled = [];
    let totalTokens = 0;

    for (const section of rawSections) {
      const sectionTokens = estimateTokens(section.content);

      // Summary is always included
      if (section.type === "summary") {
        assembled.push({ ...section, tokens: sectionTokens });
        totalTokens += sectionTokens;
        continue;
      }

      const remaining = token_budget - totalTokens;
      if (remaining <= 0) break;

      if (sectionTokens <= remaining) {
        assembled.push({ ...section, tokens: sectionTokens });
        totalTokens += sectionTokens;
      } else {
        const truncated = section.content.slice(0, remaining * 4);
        const truncTokens = estimateTokens(truncated);
        assembled.push({ ...section, content: truncated, tokens: truncTokens });
        totalTokens += truncTokens;
        break;
      }
    }

    const packet = {
      company_id,
      sections: assembled,
      totalTokens,
      budgetTokens: token_budget,
      assembled_at: new Date().toISOString(),
    };

    return new Response(JSON.stringify({ status: "ok", packet }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});
