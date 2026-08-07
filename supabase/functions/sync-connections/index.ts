/**
 * sync-connections Edge Function
 *
 * Why: pg_cronから毎日呼ばれ、全アクティブ接続のトークンをリフレッシュし、
 * 過去7日分のデータを同期する。OAuth callbackの初回同期（12ヶ月）とは異なり、
 * 差分同期に特化。
 */

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { isTokenExpired, refreshToken } from "../_shared/token-refresh.ts";
import { generateEventId } from "../_shared/event-id.ts";

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const FREEE_API_BASE = "https://api.freee.co.jp/api/1";

/** 同期対象期間: 過去7日 */
const SYNC_DAYS = 7;

interface SyncResult {
  provider: string;
  company_id: string;
  status: "synced" | "refreshed" | "skipped" | "error";
  detail: string;
}

interface Connection {
  id: string;
  company_id: string;
  provider: string;
  vault_secret_id: string;
  expires_at: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getSupabaseAdmin();
  const results: SyncResult[] = [];

  // 1. 全アクティブ接続を取得
  const { data: connections, error: fetchErr } = await supabase
    .from("connections")
    .select("id, company_id, provider, vault_secret_id, expires_at")
    .eq("status", "active");

  if (fetchErr) {
    return new Response(
      JSON.stringify({ error: `connections fetch failed: ${fetchErr.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!connections || connections.length === 0) {
    return new Response(
      JSON.stringify({ results: [], message: "no active connections" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // 2. 各接続を処理
  for (const conn of connections as Connection[]) {
    try {
      let accessToken: string;

      // 2a. トークン期限チェック & リフレッシュ
      if (isTokenExpired(conn.expires_at)) {
        const refreshResult = await refreshToken(
          conn,
          supabase,
          (k) => Deno.env.get(k),
        );

        if (!refreshResult.ok) {
          // refreshToken内でreauth_required済み
          console.error(
            `refresh failed: provider=${conn.provider} company=${conn.company_id} reason=${refreshResult.reason}`,
          );
          results.push({
            provider: conn.provider,
            company_id: conn.company_id,
            status: "skipped",
            detail: `refresh failed: ${refreshResult.reason}`,
          });
          continue;
        }

        accessToken = refreshResult.accessToken;
      } else {
        // トークンまだ有効 → Vaultから読み出し
        const { data: vaultData, error: vaultError } = await supabase.rpc(
          "read_vault_secret",
          { p_id: conn.vault_secret_id },
        );

        if (vaultError || !vaultData) {
          console.error(
            `vault read failed: provider=${conn.provider} company=${conn.company_id}`,
          );
          results.push({
            provider: conn.provider,
            company_id: conn.company_id,
            status: "error",
            detail: `vault read failed: ${vaultError?.message ?? "no data"}`,
          });
          continue;
        }

        try {
          const payload = JSON.parse(vaultData);
          accessToken = payload.access_token;
          if (!accessToken) throw new Error("access_token missing");
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({
            provider: conn.provider,
            company_id: conn.company_id,
            status: "error",
            detail: `invalid vault payload: ${msg}`,
          });
          continue;
        }
      }

      // 2e. プロバイダー別にデータ同期
      let syncCount: number;
      if (conn.provider === "google_calendar") {
        syncCount = await syncCalendarEvents(accessToken, conn.company_id, supabase);
      } else if (conn.provider === "freee") {
        syncCount = await syncFreeeTransactions(accessToken, conn.company_id, supabase);
      } else {
        results.push({
          provider: conn.provider,
          company_id: conn.company_id,
          status: "skipped",
          detail: `unknown provider: ${conn.provider}`,
        });
        continue;
      }

      // 2f. last_refresh を更新
      await supabase
        .from("connections")
        .update({ last_refresh: new Date().toISOString() })
        .eq("id", conn.id);

      results.push({
        provider: conn.provider,
        company_id: conn.company_id,
        status: "synced",
        detail: `${syncCount} events`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `sync error: provider=${conn.provider} company=${conn.company_id} error=${msg}`,
      );
      results.push({
        provider: conn.provider,
        company_id: conn.company_id,
        status: "error",
        detail: msg,
      });
    }
  }

  return new Response(JSON.stringify({ results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

// --- Google Calendar 同期 (過去7日) ---

async function syncCalendarEvents(
  accessToken: string,
  companyId: string,
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<number> {
  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - SYNC_DAYS);

  const params = new URLSearchParams({
    timeMin: since.toISOString(),
    timeMax: now.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const res = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) {
    throw new Error(`Calendar API returned ${res.status}`);
  }

  const calData = await res.json();
  const items = calData.items || [];
  if (items.length === 0) return 0;

  const rows = await Promise.all(
    items.map(
      async (item: {
        summary?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        attendees?: { email: string }[];
      }) => {
        const title = item.summary || "(無題)";
        const start = item.start?.dateTime || item.start?.date || now.toISOString();
        const end = item.end?.dateTime || item.end?.date || start;
        const attendees = (item.attendees || []).map(
          (a: { email: string }) => a.email,
        );

        const fingerprint = `calendar:${companyId}`;
        const rowContent = `${title}:${start}:${end}`;
        const eventId = await generateEventId(fingerprint, rowContent);

        return {
          event_id: eventId,
          company_id: companyId,
          occurred_at: start,
          period_start: start,
          period_end: end,
          ingested_at: now.toISOString(),
          source: "google_calendar",
          event_type: "schedule",
          entity_refs: [],
          metrics: { title, attendees },
          sensitivity: "S1",
        };
      },
    ),
  );

  const { error } = await supabase
    .from("events")
    .upsert(rows, { onConflict: "event_id" });

  if (error) {
    throw new Error(`Calendar events upsert failed: ${error.message}`);
  }

  return rows.length;
}

// --- freee 同期 (過去7日) ---

async function syncFreeeTransactions(
  accessToken: string,
  companyId: string,
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<number> {
  // freee事業所IDを取得
  const meRes = await fetch(`${FREEE_API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!meRes.ok) {
    throw new Error(`freee /users/me returned ${meRes.status}`);
  }

  const meData = await meRes.json();
  const freeeCompanyId = meData.user?.companies?.[0]?.id;
  if (!freeeCompanyId) {
    throw new Error("No freee company found for user");
  }

  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - SYNC_DAYS);

  const startDate = since.toISOString().split("T")[0];
  const endDate = now.toISOString().split("T")[0];

  const params = new URLSearchParams({
    company_id: freeeCompanyId.toString(),
    start_date: startDate,
    end_date: endDate,
    limit: "100",
  });

  const txRes = await fetch(`${FREEE_API_BASE}/deals?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!txRes.ok) {
    throw new Error(`freee /deals returned ${txRes.status}`);
  }

  const txData = await txRes.json();
  const deals = txData.deals || [];
  if (deals.length === 0) return 0;

  const rows = await Promise.all(
    deals.map(
      async (deal: {
        id: number;
        issue_date: string;
        type: string;
        details?: { account_item_name?: string; amount?: number }[];
      }) => {
        const detail = deal.details?.[0];
        const description = detail?.account_item_name || "(不明)";
        const amount = detail?.amount || 0;

        const fingerprint = `freee:${companyId}`;
        const rowContent = `${deal.id}:${deal.issue_date}:${amount}`;
        const eventId = await generateEventId(fingerprint, rowContent);

        return {
          event_id: eventId,
          company_id: companyId,
          occurred_at: `${deal.issue_date}T00:00:00.000Z`,
          ingested_at: now.toISOString(),
          source: "freee",
          event_type: "transaction",
          entity_refs: [],
          metrics: { description, amount, deal_type: deal.type },
          sensitivity: "S1",
        };
      },
    ),
  );

  const { error } = await supabase
    .from("events")
    .upsert(rows, { onConflict: "event_id" });

  if (error) {
    throw new Error(`freee events upsert failed: ${error.message}`);
  }

  return rows.length;
}
