import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import {
  getServiceClient,
  getUserClient,
  corsHeaders,
} from "../_shared/supabase.ts";
import { signState, verifyState } from "../_shared/oauth-state.ts";

initSentry("google-calendar-oauth");

const CLIENT_ID = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-calendar-oauth/callback`;
const APP_BASE = "https://www.sentio-ai.jp";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function exchangeCode(code: string) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok)
    throw new Error(
      `google token exchange failed: ${r.status} ${await r.text()}`,
    );
  return (await r.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    scope: string;
    token_type: string;
    id_token?: string;
  };
}

async function refreshToken(refresh: string) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refresh,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok)
    throw new Error(
      `google token refresh failed: ${r.status} ${await r.text()}`,
    );
  return await r.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const action = url.pathname.split("/").pop();

  try {
    // ---- /authorize: JWT必須 ----
    if (action === "authorize") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return jsonResp({ error: "認証が必要です" }, 401);
      const userClient = getUserClient(authHeader);
      const {
        data: { user },
      } = await userClient.auth.getUser();
      if (!user) return jsonResp({ error: "認証が必要です" }, 401);

      const company_id = url.searchParams.get("company_id");
      if (!company_id) return jsonResp({ error: "company_id が必要です" }, 400);

      // 所有権チェック（RLS下）
      const { data: company } = await userClient
        .from("companies")
        .select("id")
        .eq("id", company_id)
        .single();
      if (!company) return jsonResp({ error: "権限がありません" }, 403);

      const state = await signState({
        company_id,
        user_id: user.id,
        provider: "google_calendar",
      });
      const authorizeUrl = new URL(AUTHORIZE_URL);
      authorizeUrl.searchParams.set("client_id", CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", SCOPE);
      authorizeUrl.searchParams.set("state", state);
      // refresh_tokenを必ず取得するため access_type=offline + prompt=consent
      authorizeUrl.searchParams.set("access_type", "offline");
      authorizeUrl.searchParams.set("prompt", "consent");
      authorizeUrl.searchParams.set("include_granted_scopes", "true");

      return jsonResp({ authorize_url: authorizeUrl.toString() });
    }

    // ---- /callback: JWT不要（Googleからのリダイレクト） ----
    if (action === "callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return Response.redirect(
          `${APP_BASE}/app.html?integration=google_calendar&result=error&reason=${encodeURIComponent(error)}`,
          302,
        );
      }
      if (!code || !state)
        return jsonResp({ error: "code/state が必要です" }, 400);

      const payload = await verifyState(state);
      if (payload.provider !== "google_calendar")
        return jsonResp({ error: "invalid provider" }, 400);

      const tokens = await exchangeCode(code);
      const expiresAt = new Date(
        Date.now() + (tokens.expires_in - 60) * 1000,
      ).toISOString();

      const service = getServiceClient();
      const { error: upErr } = await service.from("integrations").upsert(
        {
          company_id: payload.company_id,
          type: "google_calendar",
          status: "connected",
          access_token: tokens.access_token,
          // Googleはrefresh_tokenを初回consent時のみ返す
          refresh_token: tokens.refresh_token ?? null,
          token_expires_at: expiresAt,
          metadata: { scope: tokens.scope },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "company_id,type" },
      );
      if (upErr) throw upErr;

      return Response.redirect(
        `${APP_BASE}/app.html?integration=google_calendar&result=success`,
        302,
      );
    }

    // ---- /refresh: JWT不要（内部呼び出し） ----
    if (action === "refresh") {
      const { company_id } = (await req.json()) as { company_id: string };
      if (!company_id) return jsonResp({ error: "company_id が必要です" }, 400);

      const service = getServiceClient();
      const { data: integ } = await service
        .from("integrations")
        .select("*")
        .eq("company_id", company_id)
        .eq("type", "google_calendar")
        .single();
      if (!integ || !integ.refresh_token)
        return jsonResp({ error: "未連携 or refresh_token なし" }, 404);

      const tokens = await refreshToken(integ.refresh_token);
      const expiresAt = new Date(
        Date.now() + (tokens.expires_in - 60) * 1000,
      ).toISOString();
      await service
        .from("integrations")
        .update({
          access_token: tokens.access_token,
          token_expires_at: expiresAt,
          status: "connected",
          updated_at: new Date().toISOString(),
        })
        .eq("id", integ.id);

      return jsonResp({ success: true, expires_at: expiresAt });
    }

    return jsonResp({ error: "unknown action" }, 404);
  } catch (e) {
    captureError(e as Error);
    return jsonResp({ error: (e as Error).message }, 500);
  }
});
