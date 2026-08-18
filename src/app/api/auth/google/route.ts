import { NextRequest, NextResponse } from "next/server";
import { getAuthedContext } from "@/lib/auth/company";
import {
  createOAuthState,
  oauthStateCookieName,
  OAUTH_STATE_MAX_AGE_SEC,
} from "@/lib/auth/oauth-state";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GOOGLE_CLIENT_ID not set" }, { status: 500 });
  }

  // 画面遷移用のエンドポイントなので、未認証はJSONの401ではなくログインへ送る。
  // 生のJSONを返すと利用者には白画面と内部コードにしか見えない（運用ルール§6）
  const ctx = await getAuthedContext();
  if (!ctx) {
    return NextResponse.redirect(`${req.nextUrl.origin}/login?next=%2Fconnect`);
  }

  const redirectUri = `${req.nextUrl.origin}/auth/callback/google`;
  const state = createOAuthState();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const res = NextResponse.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  res.cookies.set(oauthStateCookieName("google"), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Googleからのコールバックはトップレベル遷移のため lax で届く
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_STATE_MAX_AGE_SEC,
  });
  return res;
}
