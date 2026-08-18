import { NextRequest, NextResponse } from "next/server";
import { createRouteClient } from "@/lib/supabase/server";

/** ログアウトはフォームPOSTから呼ぶ（GETリンクにするとプリフェッチで勝手に落ちる） */
export async function POST(req: NextRequest) {
  const supabase = await createRouteClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(`${req.nextUrl.origin}/login`, 303);
}
