import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";
import { startCronLog, finishCronLog } from "../_shared/cron-logger.ts";

initSentry("sync-ga4-data");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GA4_ENDPOINT = "https://analyticsdata.googleapis.com/v1beta/properties";

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
  await fetch(`${SUPABASE_URL}/functions/v1/ga4-oauth/refresh`, {
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

async function runReport(
  token: string,
  propertyId: string,
  body: Record<string, unknown>,
) {
  const r = await fetch(`${GA4_ENDPOINT}/${propertyId}:runReport`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok)
    throw new Error(`ga4 runReport failed: ${r.status} ${await r.text()}`);
  return await r.json();
}

function getValue(row: any, idx: number): string {
  return row?.metricValues?.[idx]?.value ?? "0";
}

function getDim(row: any, idx: number): string {
  return row?.dimensionValues?.[idx]?.value ?? "";
}

async function fetchGa4Summary(token: string, propertyId: string) {
  // 週次セッション推移（直近30日をISOWEEKでバケット）
  const weekly = await runReport(token, propertyId, {
    dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
    dimensions: [{ name: "isoWeek" }, { name: "isoYear" }],
    metrics: [{ name: "sessions" }],
    orderBys: [
      { dimension: { dimensionName: "isoYear" } },
      { dimension: { dimensionName: "isoWeek" } },
    ],
  });

  // チャネル別セッション数
  const channels = await runReport(token, propertyId, {
    dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }],
  });

  // 直帰率推移（週次）
  const bounce = await runReport(token, propertyId, {
    dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
    dimensions: [{ name: "isoWeek" }, { name: "isoYear" }],
    metrics: [{ name: "bounceRate" }],
    orderBys: [
      { dimension: { dimensionName: "isoYear" } },
      { dimension: { dimensionName: "isoWeek" } },
    ],
  });

  // コンバージョン率（目標完了数 / セッション数）
  const conv = await runReport(token, propertyId, {
    dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
    metrics: [
      { name: "sessions" },
      { name: "conversions" },
      { name: "sessionConversionRate" },
    ],
  });

  // 上位ランディングページ5つ
  const landing = await runReport(token, propertyId, {
    dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
    dimensions: [{ name: "landingPage" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 5,
  });

  // 整形
  const sessionsWeekly =
    (weekly.rows ?? []).map((row: any) => ({
      iso_year: getDim(row, 1),
      iso_week: getDim(row, 0),
      sessions: Number(getValue(row, 0)),
    })) ?? [];

  const channelBuckets = {
    organic: 0,
    direct: 0,
    paid: 0,
    referral: 0,
    other: 0,
  };
  for (const row of channels.rows ?? []) {
    const channel = getDim(row, 0).toLowerCase();
    const sessions = Number(getValue(row, 0));
    if (channel.includes("organic")) channelBuckets.organic += sessions;
    else if (channel.includes("direct")) channelBuckets.direct += sessions;
    else if (channel.includes("paid") || channel.includes("cpc"))
      channelBuckets.paid += sessions;
    else if (channel.includes("referral")) channelBuckets.referral += sessions;
    else channelBuckets.other += sessions;
  }

  const bounceWeekly =
    (bounce.rows ?? []).map((row: any) => ({
      iso_year: getDim(row, 1),
      iso_week: getDim(row, 0),
      bounce_rate: Number(getValue(row, 0)),
    })) ?? [];

  const convRow = conv.rows?.[0];
  const totalSessions = convRow ? Number(getValue(convRow, 0)) : 0;
  const totalConversions = convRow ? Number(getValue(convRow, 1)) : 0;
  const conversionRate = convRow ? Number(getValue(convRow, 2)) : 0;

  const topLandingPages =
    (landing.rows ?? []).map((row: any) => ({
      page: getDim(row, 0),
      sessions: Number(getValue(row, 0)),
    })) ?? [];

  return {
    sessions_weekly: sessionsWeekly,
    channels: channelBuckets,
    bounce_rate_weekly: bounceWeekly,
    conversions: {
      total_sessions: totalSessions,
      total_conversions: totalConversions,
      conversion_rate: conversionRate,
    },
    top_landing_pages: topLandingPages,
    fetched_at: new Date().toISOString(),
  };
}

async function syncOne(supa: ReturnType<typeof getServiceClient>, integ: any) {
  const propertyId = integ.metadata?.property_id;
  if (!propertyId) {
    // property_id 未設定。経営者がUIで入力するまで待つ。
    await supa
      .from("integrations")
      .update({ status: "pending" })
      .eq("id", integ.id);
    return { company_id: integ.company_id, skipped: "no_property_id" };
  }

  try {
    const fresh = await ensureFreshToken(integ);
    const content = await fetchGa4Summary(fresh.access_token, propertyId);
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await supa.from("external_data").insert({
      company_id: integ.company_id,
      source_type: "ga4",
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
  const cronLog = await startCronLog(supa, "sync-ga4-data");

  try {
    const body = await req.json().catch(() => ({}));
    const { company_id } = body as { company_id?: string };

    // 単一会社モード（オンデマンド実行）
    if (company_id) {
      const { data: integ } = await supa
        .from("integrations")
        .select("*")
        .eq("company_id", company_id)
        .eq("type", "ga4")
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

    // 全社バッチモード（pg_cronから）
    const { data: integs } = await supa
      .from("integrations")
      .select("*")
      .eq("type", "ga4")
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
