import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";

const GBIZINFO_API = "https://info.gbiz.go.jp/hojin/v1";

interface CompetitorSuggestion {
  name: string;
  corporate_number?: string;
  reason: string;
}

export async function POST(req: NextRequest) {
  const { company_id, company_name, url, industry } = (await req.json()) as {
    company_id: string;
    company_name: string;
    url: string;
    industry: string;
  };

  if (!company_id || !company_name) {
    return NextResponse.json({ error: "company_id, company_name required" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  const gbizToken = process.env.GBIZINFO_TOKEN;

  if (!apiKey || !model) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY / ANTHROPIC_MODEL not set" },
      { status: 500 },
    );
  }

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // 1. Use Claude to suggest competitors
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `以下の会社の競合企業を3〜5社推定してください。

会社名: ${company_name}
URL: ${url || "不明"}
業種: ${industry || "不明"}

各競合について、以下のJSON配列で回答してください。他のテキストは不要です:
[{"name":"社名","corporate_number":"法人番号(13桁、わかる場合)","reason":"競合と判断した理由(1文)"}]

法人番号が不明な場合はcorporate_numberフィールドを省略してください。
日本の中小企業を想定してください。`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "[]";

  let competitors: CompetitorSuggestion[] = [];
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      competitors = JSON.parse(jsonMatch[0]);
    } catch {
      competitors = [];
    }
  }

  // 2. Register competitors as entities
  const entityRows = competitors.map((c) => ({
    company_id,
    type: "competitor",
    canonical_name: c.name,
    merge_keys: c.corporate_number ? { corporate_number: c.corporate_number } : {},
    attrs: { reason: c.reason, source: "suggest-competitors" },
    care_only: false,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  }));

  if (entityRows.length > 0) {
    const { error: entErr } = await supabase.from("entities").insert(entityRows);
    if (entErr) {
      console.error("entities insert failed:", entErr.message);
    }
  }

  // 3. Fetch gBizINFO data for competitors (S0, company_id=null)
  const gbizEvents = [];
  if (gbizToken) {
    for (const competitor of competitors) {
      try {
        const events = await fetchGbizInfo(gbizToken, competitor.name, competitor.corporate_number);
        gbizEvents.push(...events);
      } catch (e) {
        console.error(`gBizINFO fetch failed for ${competitor.name}:`, e);
      }
    }

    if (gbizEvents.length > 0) {
      // S0: company_id=null, deduplicated via event_id
      const now = new Date().toISOString();
      const eventRows = gbizEvents.map((evt) => {
        const fingerprint = `s0:gbizinfo`;
        const rowContent = JSON.stringify(evt.metrics);
        const eventId = createHash("sha256").update(`${fingerprint}:${rowContent}`).digest("hex");

        return {
          event_id: eventId,
          company_id: null, // S0 shared
          occurred_at: evt.occurred_at || now,
          ingested_at: now,
          source: "gbizinfo",
          event_type: "external",
          entity_refs: [],
          metrics: evt.metrics,
          sensitivity: "S0",
        };
      });

      const { error: evtErr } = await supabase
        .from("events")
        .upsert(eventRows, { onConflict: "event_id" });

      if (evtErr) {
        console.error("gBizINFO events upsert failed:", evtErr.message);
      }
    }
  }

  // Track which competitors had gBizINFO matches
  const competitorResults = [];
  for (const c of competitors) {
    const hasGbiz = gbizEvents.some(
      (evt) =>
        (evt.metrics as Record<string, unknown>).company_name === c.name ||
        (evt.metrics as Record<string, unknown>).name === c.name,
    );
    competitorResults.push({
      name: c.name,
      reason: c.reason,
      gbiz_matched: hasGbiz,
    });
  }

  return NextResponse.json({
    competitors: competitorResults,
    gbiz_events_count: gbizEvents.length,
    unmatched_note:
      competitorResults.filter((c) => !c.gbiz_matched).length > 0
        ? "一部の競合候補はgBizINFOで法人が特定できませんでした"
        : null,
  });
}

async function fetchGbizInfo(
  token: string,
  companyName: string,
  corporateNumber?: string,
): Promise<{ occurred_at: string; metrics: Record<string, unknown> }[]> {
  const events: { occurred_at: string; metrics: Record<string, unknown> }[] = [];

  // Search by corporate number (exact) or name
  const searchParam = corporateNumber
    ? `corporate_number=${corporateNumber}`
    : `name=${encodeURIComponent(companyName)}`;

  const res = await fetch(`${GBIZINFO_API}/hojin?${searchParam}`, {
    headers: {
      "X-hojinInfo-api-token": token,
      Accept: "application/json",
    },
  });

  if (!res.ok) return events;

  const data = await res.json();
  const corps = data["hojin-infos"] || [];

  // Exact name match: reject partial matches that return unrelated companies
  const matched = corps.filter((corp: { name: string }) => {
    if (corporateNumber) return true; // corporate_number is exact
    // Normalize full-width to half-width for comparison
    const normalize = (s: string) =>
      s
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/[　\s]+/g, "")
        .replace(/株式会社|有限会社|合同会社/g, "")
        .toLowerCase();
    return normalize(corp.name) === normalize(companyName);
  });

  if (matched.length === 0) return events;

  for (const corp of matched.slice(0, 1)) {
    // Basic corporate info
    if (corp.name) {
      events.push({
        occurred_at: new Date().toISOString(),
        metrics: {
          type: "corporate_info",
          name: corp.name,
          corporate_number: corp.corporate_number,
          location: corp.location,
          status: corp.status,
          business_summary: corp.business_summary,
        },
      });
    }

    // Subsidies (補助金)
    if (corp.subsidy) {
      for (const sub of corp.subsidy.slice(0, 5)) {
        events.push({
          occurred_at: sub.date_of_approval || new Date().toISOString(),
          metrics: {
            type: "subsidy",
            company_name: corp.name,
            title: sub.title,
            amount: sub.subsidy_resource,
            target: sub.target,
          },
        });
      }
    }

    // Certifications (認定)
    if (corp.certification) {
      for (const cert of corp.certification.slice(0, 5)) {
        events.push({
          occurred_at: cert.date_of_approval || new Date().toISOString(),
          metrics: {
            type: "certification",
            company_name: corp.name,
            title: cert.title,
            category: cert.category,
            enterprise_scale: cert.enterprise_scale,
          },
        });
      }
    }
  }

  return events;
}
