import { NextRequest, NextResponse } from "next/server";

const FREEE_AUTH_URL = "https://accounts.secure.freee.co.jp/public_api/authorize";

export async function GET(req: NextRequest) {
  const clientId = process.env.FREEE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "FREEE_CLIENT_ID not set. freee連携は現在準備中です。" },
      { status: 503 },
    );
  }

  const companyId = req.nextUrl.searchParams.get("company_id");
  if (!companyId) {
    return NextResponse.json({ error: "company_id required" }, { status: 400 });
  }

  const redirectUri = `${req.nextUrl.origin}/auth/callback/freee`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    prompt: "consent",
    state: companyId,
  });

  return NextResponse.redirect(`${FREEE_AUTH_URL}?${params.toString()}`);
}
