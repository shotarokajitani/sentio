import { NextRequest, NextResponse } from "next/server";
import { createAuthClient } from "@/lib/supabase/server";

/** ログアウトはフォームPOSTから呼ぶ（GETリンクにするとプリフェッチで勝手に落ちる） */
export async function POST(req: NextRequest) {
  const { supabase, pending } = createAuthClient(req);
  await supabase.auth.signOut();

  const res = NextResponse.redirect(`${req.nextUrl.origin}/login`, 303);
  for (const c of pending) res.cookies.set(c.name, c.value, c.options);
  return res;
}
