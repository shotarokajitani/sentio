import { NextRequest, NextResponse } from "next/server";
import { getAuthedContext } from "@/lib/auth/company";
import { oauthStateCookieName, isMatchingState } from "@/lib/auth/oauth-state";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

const FREEE_TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token";
const FREEE_API_BASE = "https://api.freee.co.jp/api/1";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const callbackState = req.nextUrl.searchParams.get("state");
  const providerError = req.nextUrl.searchParams.get("error");

  const redirect = (path: string) => {
    const res = NextResponse.redirect(`${req.nextUrl.origin}${path}`);
    res.cookies.delete(oauthStateCookieName("freee"));
    return res;
  };

  if (providerError) {
    console.error("freee OAuth denied:", providerError);
    return redirect("/connect?e=oauth_denied");
  }

  const ctx = await getAuthedContext();
  if (!ctx) {
    return redirect("/login?next=%2Fconnect");
  }
  const companyId = ctx.companyId;

  const cookieState = req.cookies.get(oauthStateCookieName("freee"))?.value ?? null;
  if (!isMatchingState(cookieState, callbackState)) {
    console.error("freee OAuth state mismatch");
    return redirect("/connect?e=oauth_state_mismatch");
  }

  if (!code) {
    return redirect("/connect?e=oauth_incomplete");
  }

  const clientId = process.env.FREEE_CLIENT_ID;
  const clientSecret = process.env.FREEE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return redirect("/connect?e=freee_unavailable");
  }

  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const redirectUri = `${req.nextUrl.origin}/auth/callback/freee`;

  // 1. Exchange code for tokens
  const tokenRes = await fetch(FREEE_TOKEN_URL, {
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
    console.error("freee token exchange failed:", tokenData.error);
    return redirect("/connect?e=connect_failed");
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // 2. Store tokens in Vault
  const tokenPayload = JSON.stringify({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
  });

  const { data: vaultId, error: vaultErr } = await supabase.rpc("store_vault_secret", {
    p_name: `freee:${companyId}`,
    p_secret: tokenPayload,
    p_description: "freee OAuth token",
  });

  if (vaultErr) {
    console.error("Vault store failed:", vaultErr.message);
    return redirect("/connect?e=connect_failed");
  }

  // 3. Register connection
  const expiresAt = new Date(Date.now() + (tokenData.expires_in || 86400) * 1000).toISOString();

  const { error: connErr } = await supabase.from("connections").upsert(
    {
      company_id: companyId,
      provider: "freee",
      vault_secret_id: vaultId,
      scopes: ["read"],
      status: "active",
      last_refresh: new Date().toISOString(),
      expires_at: expiresAt,
    },
    { onConflict: "company_id,provider", ignoreDuplicates: false },
  );

  if (connErr) {
    console.error("Connection insert failed:", connErr.message);
    return redirect("/connect?e=connect_failed");
  }

  // 4. Sync recent transactions (past 12 months)
  const syncCount = await syncFreeeTransactions(tokenData.access_token, companyId, supabase);

  return redirect(`/connect?freee_synced=${syncCount}`);
}

async function syncFreeeTransactions(
  accessToken: string,
  companyId: string,
  supabase: any,
): Promise<number> {
  // First, get the freee company ID
  const meRes = await fetch(`${FREEE_API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!meRes.ok) {
    console.error("freee /users/me failed:", meRes.status);
    return 0;
  }

  const meData = await meRes.json();
  const freeeCompanyId = meData.user?.companies?.[0]?.id;
  if (!freeeCompanyId) {
    console.error("No freee company found for user");
    return 0;
  }

  // Fetch journal entries (仕訳) for the past 12 months
  const now = new Date();
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const startDate = twelveMonthsAgo.toISOString().split("T")[0];
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
    console.error("freee /deals failed:", txRes.status);
    return 0;
  }

  const txData = await txRes.json();
  const deals = txData.deals || [];
  if (deals.length === 0) return 0;

  const rows = deals.map(
    (deal: {
      id: number;
      issue_date: string;
      type: string;
      details?: { account_item_name?: string; amount?: number; tax_code?: number }[];
    }) => {
      const detail = deal.details?.[0];
      const description = detail?.account_item_name || "(不明)";
      const amount = detail?.amount || 0;
      const fingerprint = `freee:${companyId}`;
      const rowContent = `${deal.id}:${deal.issue_date}:${amount}`;
      const eventId = createHash("sha256").update(`${fingerprint}:${rowContent}`).digest("hex");

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
  );

  const { error } = await supabase.from("events").upsert(rows, { onConflict: "event_id" });

  if (error) {
    console.error("freee events upsert failed:", error.message);
    return 0;
  }

  return rows.length;
}
