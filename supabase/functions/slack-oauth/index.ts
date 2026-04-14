import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import {
  getServiceClient,
  getUserClient,
  corsHeaders,
} from "../_shared/supabase.ts";
import { signState, verifyState } from "../_shared/oauth-state.ts";

initSentry("slack-oauth");

const CLIENT_ID = Deno.env.get("SLACK_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("SLACK_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/slack-oauth/callback`;
const APP_BASE = "https://www.sentio-ai.jp";

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const TOKEN_URL = "https://slack.com/api/oauth.v2.access";
// Bot Token Scopes
const SCOPES = "channels:history,channels:read,users:read";

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function exchangeCode(code: string) {
  const params = new URLSearchParams({
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
  const j = await r.json();
  if (!r.ok || !j.ok)
    throw new Error(`slack token exchange failed: ${JSON.stringify(j)}`);
  return j as {
    ok: boolean;
    access_token: string; // bot token (xoxb-)
    token_type: string;
    scope: string;
    bot_user_id: string;
    app_id: string;
    team: { id: string; name: string };
    authed_user: { id: string };
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const action = url.pathname.split("/").pop();

  try {
    if (action === "authorize") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return jsonResp({ error: "認証が必要です" }, 401);

      const jwt = authHeader.replace(/^Bearer\s+/i, "");
      if (!jwt) return jsonResp({ error: "JWTが不正です" }, 401);

      const userClient = getUserClient(authHeader);
      const {
        data: { user },
        error: authError,
      } = await userClient.auth.getUser(jwt);
      if (authError || !user) {
        console.error("[slack-oauth] auth failed:", authError);
        return jsonResp(
          { error: "認証が必要です", detail: authError?.message },
          401,
        );
      }

      const company_id = url.searchParams.get("company_id");
      if (!company_id) return jsonResp({ error: "company_id が必要です" }, 400);

      const { data: company } = await userClient
        .from("companies")
        .select("id")
        .eq("id", company_id)
        .single();
      if (!company) return jsonResp({ error: "権限がありません" }, 403);

      const state = await signState({
        company_id,
        user_id: user.id,
        provider: "slack",
      });
      const authorizeUrl = new URL(AUTHORIZE_URL);
      authorizeUrl.searchParams.set("client_id", CLIENT_ID);
      authorizeUrl.searchParams.set("scope", SCOPES); // bot scopes
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("state", state);

      return jsonResp({ authorize_url: authorizeUrl.toString() });
    }

    if (action === "callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return Response.redirect(
          `${APP_BASE}/app.html?integration=slack&result=error&reason=${encodeURIComponent(error)}`,
          302,
        );
      }
      if (!code || !state)
        return jsonResp({ error: "code/state が必要です" }, 400);

      const payload = await verifyState(state);
      if (payload.provider !== "slack")
        return jsonResp({ error: "invalid provider" }, 400);

      const tokens = await exchangeCode(code);

      const service = getServiceClient();
      const { error: upErr } = await service.from("integrations").upsert(
        {
          company_id: payload.company_id,
          type: "slack",
          status: "connected",
          access_token: tokens.access_token,
          refresh_token: null,
          token_expires_at: null, // Slack bot tokens are non-expiring by default
          metadata: {
            scope: tokens.scope,
            team_id: tokens.team?.id,
            team_name: tokens.team?.name,
            bot_user_id: tokens.bot_user_id,
            app_id: tokens.app_id,
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "company_id,type" },
      );
      if (upErr) throw upErr;

      return Response.redirect(
        `${APP_BASE}/app.html?integration=slack&result=success`,
        302,
      );
    }

    return jsonResp({ error: "unknown action" }, 404);
  } catch (e) {
    captureError(e as Error);
    return jsonResp({ error: (e as Error).message }, 500);
  }
});
