import { NextRequest, NextResponse } from "next/server";
import { getAuthedContext } from "@/lib/auth/company";
import {
  createOAuthState,
  oauthStateCookieName,
  OAUTH_STATE_MAX_AGE_SEC,
} from "@/lib/auth/oauth-state";

const FREEE_AUTH_URL = "https://accounts.secure.freee.co.jp/public_api/authorize";

export async function GET(req: NextRequest) {
  const clientId = process.env.FREEE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "FREEE_CLIENT_ID not set. freee連携は現在準備中です。" },
      { status: 503 },
    );
  }

  // 画面遷移用のエンドポイント。未認証はログインへ送る（運用ルール§6）
  const ctx = await getAuthedContext();
  if (!ctx) {
    return NextResponse.redirect(`${req.nextUrl.origin}/login?next=%2Fconnect`);
  }

  const redirectUri = `${req.nextUrl.origin}/auth/callback/freee`;
  const state = createOAuthState();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    prompt: "consent",
    state,
  });

  const res = NextResponse.redirect(`${FREEE_AUTH_URL}?${params.toString()}`);
  res.cookies.set(oauthStateCookieName("freee"), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_STATE_MAX_AGE_SEC,
  });
  return res;
}
