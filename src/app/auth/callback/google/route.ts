import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const companyId = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      `${req.nextUrl.origin}/register?error=${encodeURIComponent(error)}`,
    );
  }

  if (!code || !companyId) {
    return NextResponse.redirect(
      `${req.nextUrl.origin}/register?error=missing_params`,
    );
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
    return NextResponse.redirect(
      `${req.nextUrl.origin}/register?error=token_exchange_failed`,
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // 2. Store tokens in Vault
  const tokenPayload = JSON.stringify({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
  });

  const { data: vaultId, error: vaultErr } = await supabase.rpc(
    "store_vault_secret",
    {
      p_name: `google_calendar:${companyId}`,
      p_secret: tokenPayload,
      p_description: "Google Calendar OAuth token",
    },
  );

  if (vaultErr) {
    console.error("Vault store failed:", vaultErr.message);
    return NextResponse.redirect(
      `${req.nextUrl.origin}/register?error=vault_failed`,
    );
  }

  // 3. Register connection
  const expiresAt = new Date(
    Date.now() + (tokenData.expires_in || 3600) * 1000,
  ).toISOString();

  const { error: connErr } = await supabase.from("connections").upsert(
    {
      company_id: companyId,
      provider: "google_calendar",
      vault_secret_id: vaultId,
      scopes: ["calendar.readonly"],
      status: "active",
      last_refresh: new Date().toISOString(),
      expires_at: expiresAt,
    },
    { onConflict: "company_id,provider", ignoreDuplicates: false },
  );

  if (connErr) {
    console.error("Connection insert failed:", connErr.message);
    return NextResponse.redirect(
      `${req.nextUrl.origin}/register?error=connection_failed`,
    );
  }

  // 4. Sync calendar events (past 12 months)
  const syncCount = await syncCalendarEvents(
    tokenData.access_token,
    companyId,
    supabase,
  );

  return NextResponse.redirect(
    `${req.nextUrl.origin}/register/complete?events=${syncCount}`,
  );
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

  const res = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

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
      const attendees = (item.attendees || []).map(
        (a: { email: string }) => a.email,
      );

      const fingerprint = `calendar:${companyId}`;
      const rowContent = `${title}:${start}:${end}`;
      const eventId = createHash("sha256")
        .update(`${fingerprint}:${rowContent}`)
        .digest("hex");

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

  const { error } = await supabase
    .from("events")
    .upsert(rows, { onConflict: "event_id" });

  if (error) {
    console.error("Calendar events upsert failed:", error.message);
    return 0;
  }

  return rows.length;
}
