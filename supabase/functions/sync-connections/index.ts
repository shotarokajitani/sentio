/**
 * sync-connections Edge Function
 *
 * Why: pg_cronから毎日呼ばれ、全アクティブ接続のトークンをリフレッシュし、
 * 過去7日分のデータを同期する。OAuth callbackの初回同期（12ヶ月）とは異なり、
 * 差分同期に特化。
 */

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller } from "../_shared/caller.ts";
import { errorResponse, mustData, mustOk } from "../_shared/db.ts";
import {
  isTokenExpired,
  planSyncRecovery,
  refreshToken,
  shouldRetryReauth,
} from "../_shared/token-refresh.ts";
import { recordConnectionEvent } from "../_shared/connection-events.ts";
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
  /** 遷移を残すために引く（PS-9）。「どこから」が無いと本物の遷移を見分けられない */
  status: string | null;
  /** 一時的な失敗の連続回数（00037・発注 ①-2） */
  consecutive_failures?: number | null;
  /** 最後に失敗した時刻（00037）。`reauth_required` の再試行を1日1回に絞る */
  last_failure_at?: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は**DBに触る前**（契約 S-2-9 / S-4-1）。
  // この関数は全社の接続を横断して読むため、company_id のスコープ判定は無い。
  // 通せるのは internal（pg_cron / 内部呼び出し）だけ、が唯一の境界になる
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  const supabase = getSupabaseAdmin();
  const results: SyncResult[] = [];

  try {
    // 1. 同期の対象を取る（発注 ①-2 で `reauth_required` も含めた）。
    //
    // **倒れた行を二度と触らない形をやめる。** 以前は `status = 'active'` だけを拾っており、
    // ネットワークの瞬断で `reauth_required` になった行は、顧客が手で再連携するまで
    // cron から一度も試されなかった。7日ごとに「連携が切れています」が届き続ける。
    //
    // ただし `reauth_required` は**1日1回だけ**にする。本当に切れている行を
    // 6時間ごとに叩くと、相手側に無駄な負荷をかけ、こちらのログも埋まる。
    const now = new Date();
    const candidates = await mustData(
      supabase
        .from("connections")
        .select(
          "id, company_id, provider, vault_secret_id, expires_at, status, " +
            "consecutive_failures, last_failure_at",
        )
        .in("status", ["active", "reauth_required"]),
      "sync-connections: sync targets",
    );

    const connections = (candidates as unknown as Connection[]).filter(
      (c) => c.status !== "reauth_required" || shouldRetryReauth(c.last_failure_at ?? null, now),
    );

    if (connections.length === 0) {
      return new Response(
        JSON.stringify({
          results: [],
          message: "no connections to sync",
          // **0件の理由を区別できるようにする。** 「対象が無い」と「全部待ち時間の中」は別
          candidates: candidates.length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. 各接続を処理
    for (const conn of connections as Connection[]) {
      try {
        let accessToken: string;
        // **リフレッシュを通ったかを覚える。** 通っていれば復旧は `refreshToken` が済ませている。
        // ここでもう一度書くと `connection_events` に同じ遷移が2行残る
        let recoveredByRefresh = false;

        // 2a. トークン期限チェック & リフレッシュ
        if (isTokenExpired(conn.expires_at)) {
          const refreshResult = await refreshToken(conn, supabase, (k) => Deno.env.get(k));

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
          recoveredByRefresh = true;
        } else {
          // トークンまだ有効 → Vaultから読み出し
          const { data: vaultData, error: vaultError } = await supabase.rpc("read_vault_secret", {
            p_id: conn.vault_secret_id,
          });

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

        // 2f. last_refresh を更新し、**成功したら失敗の記録を消す**（発注 ①-2）。
        //
        // **トークンが有効なまま同期できた経路がここに来る。** リフレッシュを通らないので
        // `refreshToken` の復旧処理が走らず、`reauth_required` のまま残っていた
        // （2026-09-09 の検収で指摘）。取り込めているのに「切れています」と出続ける
        const { restoreActive, recordEvent } = planSyncRecovery({
          status: conn.status,
          recoveredByRefresh,
        });

        await mustOk(
          supabase
            .from("connections")
            .update({
              last_refresh: new Date().toISOString(),
              consecutive_failures: 0,
              last_failure_at: null,
              ...(restoreActive ? { status: "active" } : {}),
            })
            .eq("id", conn.id),
          "sync-connections: last_refresh",
        );

        if (recordEvent) {
          // **勝手に直ったことを残す**（`reconnected` とは別の理由）
          const recorded = await recordConnectionEvent(supabase, {
            companyId: conn.company_id,
            provider: conn.provider,
            fromStatus: "reauth_required",
            toStatus: "active",
            reason: "recovered",
          });
          if (!recorded.ok) console.error("connection_events insert failed:", recorded.error);
        }

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
  } catch (error) {
    // 接続一覧が引けない＝同期対象が分からない。0件と区別できないので握りつぶさない
    return errorResponse(error, corsHeaders);
  }
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

  const res = await fetch(`${GOOGLE_CALENDAR_API}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

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
        const attendees = (item.attendees || []).map((a: { email: string }) => a.email);

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

  await mustOk(
    supabase.from("events").upsert(rows, { onConflict: "event_id" }),
    "sync-connections: calendar events upsert",
  );

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

  await mustOk(
    supabase.from("events").upsert(rows, { onConflict: "event_id" }),
    "sync-connections: freee events upsert",
  );

  return rows.length;
}
