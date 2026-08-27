import { NextRequest, NextResponse } from "next/server";
import { getAuthedContext } from "@/lib/auth/company";
import { oauthStateCookieName, isMatchingState } from "@/lib/auth/oauth-state";
import { createClient } from "@supabase/supabase-js";
import { upsertVaultToken } from "@/security/vault-token";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const callbackState = req.nextUrl.searchParams.get("state");
  const providerError = req.nextUrl.searchParams.get("error");

  // 全ての離脱経路でstate cookieを片付ける。使い回されたstateはCSRFトークンとして無価値
  const redirect = (path: string) => {
    const res = NextResponse.redirect(`${req.nextUrl.origin}${path}`);
    res.cookies.delete(oauthStateCookieName("google"));
    return res;
  };

  if (providerError) {
    // プロバイダの生のエラーコードは画面に出さない（運用ルール§6）。詳細はサーバログへ
    console.error("Google OAuth denied:", providerError);
    return redirect("/connect?e=oauth_denied");
  }

  // company_id はセッションから取る。stateから取ると第三者が他社に接続を紐付けられる
  const ctx = await getAuthedContext();
  if (!ctx) {
    return redirect("/login?next=%2Fconnect");
  }
  const companyId = ctx.companyId;

  const cookieState = req.cookies.get(oauthStateCookieName("google"))?.value ?? null;
  if (!isMatchingState(cookieState, callbackState)) {
    console.error("Google OAuth state mismatch");
    return redirect("/connect?e=oauth_state_mismatch");
  }

  if (!code) {
    return redirect("/connect?e=oauth_incomplete");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const redirectUri = `${req.nextUrl.origin}/auth/callback/google`;

  // 1. Exchange code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.access_token) {
    console.error("Token exchange failed:", tokenData.error);
    return redirect("/connect?e=connect_failed");
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // 2. Store tokens in Vault
  const tokenPayload = JSON.stringify({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
  });

  // 再連携でも同名シークレットを増やさない（既存があれば更新する）
  const {
    vaultId,
    action,
    error: vaultErr,
  } = await upsertVaultToken(supabase, companyId, tokenPayload);

  if (vaultErr || !vaultId) {
    console.error("Vault store failed:", vaultErr);
    return redirect("/connect?e=connect_failed");
  }
  console.log(`vault token ${action} for company ${companyId}`);

  // 3. Register connection
  const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();

  const { error: connErr } = await supabase.from("connections").upsert(
    {
      company_id: companyId,
      provider: "google_calendar",
      vault_secret_id: vaultId,
      // 実際に同意を得たスコープを記録する。api/auth/google/route.ts の scope と揃えること
      scopes: ["calendar.events.readonly"],
      status: "active",
      last_refresh: new Date().toISOString(),
      expires_at: expiresAt,
      // 再連携が成立した以上、取り消しの記録は残さない（受入基準 D-2-6）。
      // 残すと30日削除（契約 D-3）が、いま繋ぎ直したばかりの連携のデータを消す
      revoked_at: null,
    },
    { onConflict: "company_id,provider", ignoreDuplicates: false },
  );

  if (connErr) {
    console.error("Connection insert failed:", connErr.message);
    return redirect("/connect?e=connect_failed");
  }

  // 4. Sync calendar events (past 12 months)
  const syncCount = await syncCalendarEvents(tokenData.access_token, companyId, supabase);

  return redirect(`/register/complete?events=${syncCount}`);
}

async function syncCalendarEvents(
  accessToken: string,
  companyId: string,
  supabase: any,
): Promise<number> {
  const now = new Date();
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const params = new URLSearchParams({
    timeMin: twelveMonthsAgo.toISOString(),
    timeMax: now.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const res = await fetch(`${GOOGLE_CALENDAR_API}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    console.error("Calendar API failed:", res.status);
    return 0;
  }

  const calData = await res.json();
  const items = calData.items || [];

  if (items.length === 0) return 0;

  const { createHash } = await import("crypto");

  const rows = items.map(
    (item: {
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
      const eventId = createHash("sha256").update(`${fingerprint}:${rowContent}`).digest("hex");

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
  );

  const { error } = await supabase.from("events").upsert(rows, { onConflict: "event_id" });

  if (error) {
    console.error("Calendar events upsert failed:", error.message);
    return 0;
  }

  return rows.length;
}
