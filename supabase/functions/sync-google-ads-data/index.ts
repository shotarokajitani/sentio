import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";
import { startCronLog, finishCronLog } from "../_shared/cron-logger.ts";

initSentry("sync-google-ads-data");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEVELOPER_TOKEN = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!;

const ADS_ENDPOINT = "https://googleads.googleapis.com/v17/customers";

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function ensureFreshToken(integ: any) {
  if (!integ.token_expires_at) return integ;
  if (new Date(integ.token_expires_at).getTime() > Date.now() + 30_000)
    return integ;
  await fetch(`${SUPABASE_URL}/functions/v1/google-ads-oauth/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ company_id: integ.company_id }),
  });
  const supa = getServiceClient();
  const { data } = await supa
    .from("integrations")
    .select("*")
    .eq("id", integ.id)
    .single();
  return data ?? integ;
}

// Google Ads APIのカスタマーIDはハイフンなしの数字10桁。UI入力は "123-456-7890" の形式も許容する。
function normalizeCustomerId(raw: string): string {
  return raw.replace(/-/g, "").trim();
}

// searchStream は結果を chunk 配列で返す。各 chunk に results[] が入る。
async function searchStream(
  token: string,
  customerId: string,
  query: string,
  loginCustomerId?: string,
): Promise<any[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": DEVELOPER_TOKEN,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const r = await fetch(
    `${ADS_ENDPOINT}/${customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    },
  );
  if (!r.ok)
    throw new Error(
      `google-ads searchStream failed: ${r.status} ${await r.text()}`,
    );
  const json = await r.json();
  const chunks = Array.isArray(json) ? json : [json];
  const results: any[] = [];
  for (const c of chunks) {
    if (Array.isArray(c.results)) results.push(...c.results);
  }
  return results;
}

async function fetchAdsSummary(
  token: string,
  customerId: string,
  loginCustomerId?: string,
) {
  // 週次集計：cost_micros / clicks / conversions
  const weeklyQuery = `
    SELECT
      segments.week,
      metrics.cost_micros,
      metrics.clicks,
      metrics.conversions
    FROM customer
    WHERE segments.date DURING LAST_30_DAYS
    ORDER BY segments.week
  `;
  const weeklyRows = await searchStream(
    token,
    customerId,
    weeklyQuery,
    loginCustomerId,
  );

  // キャンペーン別費用上位3件（30日合計）
  const campaignQuery = `
    SELECT
      campaign.name,
      metrics.cost_micros,
      metrics.clicks,
      metrics.conversions
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
    ORDER BY metrics.cost_micros DESC
    LIMIT 3
  `;
  const campaignRows = await searchStream(
    token,
    customerId,
    campaignQuery,
    loginCustomerId,
  );

  // 週次ごとに集約（同一週が複数行で返ることがあるのでJSで合算）
  const weekMap = new Map<
    string,
    { cost: number; clicks: number; conversions: number }
  >();
  for (const row of weeklyRows) {
    const week = row?.segments?.week ?? "";
    if (!week) continue;
    const cost = Number(row?.metrics?.costMicros ?? 0) / 1_000_000;
    const clicks = Number(row?.metrics?.clicks ?? 0);
    const conversions = Number(row?.metrics?.conversions ?? 0);
    const prev = weekMap.get(week) ?? { cost: 0, clicks: 0, conversions: 0 };
    weekMap.set(week, {
      cost: prev.cost + cost,
      clicks: prev.clicks + clicks,
      conversions: prev.conversions + conversions,
    });
  }
  const sortedWeeks = Array.from(weekMap.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const costWeekly = sortedWeeks.map(([week, v]) => ({
    week,
    cost: Math.round(v.cost * 100) / 100,
  }));
  const clicksWeekly = sortedWeeks.map(([week, v]) => ({
    week,
    clicks: v.clicks,
  }));
  const conversionsWeekly = sortedWeeks.map(([week, v]) => ({
    week,
    conversions: Math.round(v.conversions * 100) / 100,
  }));
  // CPA = cost / conversions（コンバージョンゼロ週はnull）
  const cpaWeekly = sortedWeeks.map(([week, v]) => ({
    week,
    cpa:
      v.conversions > 0
        ? Math.round((v.cost / v.conversions) * 100) / 100
        : null,
  }));

  const topCampaigns = campaignRows.map((row) => {
    const cost = Number(row?.metrics?.costMicros ?? 0) / 1_000_000;
    const conversions = Number(row?.metrics?.conversions ?? 0);
    return {
      name: row?.campaign?.name ?? "",
      cost: Math.round(cost * 100) / 100,
      clicks: Number(row?.metrics?.clicks ?? 0),
      conversions: Math.round(conversions * 100) / 100,
      cpa:
        conversions > 0 ? Math.round((cost / conversions) * 100) / 100 : null,
    };
  });

  return {
    cost_weekly: costWeekly,
    clicks_weekly: clicksWeekly,
    conversions_weekly: conversionsWeekly,
    top_campaigns: topCampaigns,
    cpa_weekly: cpaWeekly,
    customer_id: customerId,
    fetched_at: new Date().toISOString(),
  };
}

async function syncOne(supa: ReturnType<typeof getServiceClient>, integ: any) {
  const rawCustomerId = integ.metadata?.customer_id;
  if (!rawCustomerId) {
    await supa
      .from("integrations")
      .update({ status: "pending" })
      .eq("id", integ.id);
    return { company_id: integ.company_id, skipped: "no_customer_id" };
  }
  const customerId = normalizeCustomerId(String(rawCustomerId));
  const loginCustomerId = integ.metadata?.login_customer_id
    ? normalizeCustomerId(String(integ.metadata.login_customer_id))
    : undefined;

  try {
    const fresh = await ensureFreshToken(integ);
    const content = await fetchAdsSummary(
      fresh.access_token,
      customerId,
      loginCustomerId,
    );
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await supa.from("external_data").insert({
      company_id: integ.company_id,
      source_type: "google_ads",
      content,
      expires_at: expiresAt,
    });

    await supa
      .from("integrations")
      .update({
        last_synced_at: new Date().toISOString(),
        status: "connected",
      })
      .eq("id", integ.id);

    return { company_id: integ.company_id, synced: true };
  } catch (e) {
    captureError(e as Error, { company_id: integ.company_id });
    await supa
      .from("integrations")
      .update({ status: "error" })
      .eq("id", integ.id);
    return {
      company_id: integ.company_id,
      synced: false,
      error: (e as Error).message,
    };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  const supa = getServiceClient();
  const cronLog = await startCronLog(supa, "sync-google-ads-data");

  try {
    const body = await req.json().catch(() => ({}));
    const { company_id } = body as { company_id?: string };

    if (company_id) {
      const { data: integ } = await supa
        .from("integrations")
        .select("*")
        .eq("company_id", company_id)
        .eq("type", "google_ads")
        .eq("status", "connected")
        .single();

      if (!integ) {
        await finishCronLog(supa, cronLog, {
          status: "success",
          recordsProcessed: 0,
        });
        return jsonResp({ success: true, synced: 0, message: "未連携" });
      }

      const r = await syncOne(supa, integ);
      await finishCronLog(supa, cronLog, {
        status: r.synced ? "success" : "error",
        errorMessage: r.error,
        recordsProcessed: r.synced ? 1 : 0,
      });
      return jsonResp({ success: true, result: r });
    }

    // 全社バッチ（pg_cron用）
    const { data: integs } = await supa
      .from("integrations")
      .select("*")
      .eq("type", "google_ads")
      .eq("status", "connected");

    const results = [];
    let successCount = 0;
    for (const integ of integs ?? []) {
      const r = await syncOne(supa, integ);
      if (r.synced) successCount++;
      results.push(r);
    }

    await finishCronLog(supa, cronLog, {
      status: "success",
      recordsProcessed: successCount,
    });
    return jsonResp({
      success: true,
      total: integs?.length ?? 0,
      synced: successCount,
      results,
    });
  } catch (e) {
    captureError(e as Error);
    await finishCronLog(supa, cronLog, {
      status: "error",
      errorMessage: (e as Error).message,
    });
    return jsonResp({ error: (e as Error).message }, 500);
  }
});
