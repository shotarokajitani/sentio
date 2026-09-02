import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, type PendingCookie } from "@/lib/supabase/server";
import { safeNext } from "@/lib/auth/safe-next";

const MIN_PASSWORD_LENGTH = 8;

/**
 * フォームPOSTからの遷移。307だとPOSTのまま再送されるため303で戻す。
 * 発行されたセッションcookieは必ずこのレスポンスに載せる
 */
function redirect(req: NextRequest, path: string, pending: PendingCookie[]): NextResponse {
  const res = NextResponse.redirect(`${req.nextUrl.origin}${path}`, 303);
  for (const c of pending) res.cookies.set(c.name, c.value, c.options);
  return res;
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const intent = String(form.get("intent") ?? "login");
  const next = safeNext(form.get("next"));

  const { supabase, pending } = createAuthClient(req);
  const backToLogin = (key: string) =>
    redirect(req, `/login?e=${key}&next=${encodeURIComponent(next)}`, pending);

  if (!email || !password) {
    return backToLogin("missing_fields");
  }

  if (intent === "signup") {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return backToLogin("weak_password");
    }

    // 自社サイトのURLはユーザーのメタデータに置く。**新しいテーブルを作らない。**
    // `company_id` は `auth.uid()` そのもの（RLS 00019）なので、会社の属性と
    // ユーザーの属性が1対1で対応する。空欄なら何も入れない（任意項目）
    const siteUrl = String(form.get("site_url") ?? "").trim();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      ...(siteUrl ? { options: { data: { site_url: siteUrl } } } : {}),
    });
    if (error) {
      console.error("signUp failed:", error.message);
      return backToLogin(
        error.message.toLowerCase().includes("already") ? "email_taken" : "unknown",
      );
    }

    // 確認メールが有効な場合はセッションが発行されない。その旨を伝えて待たせる
    if (!data.session) {
      return redirect(req, "/login?confirm=1", pending);
    }
    return redirect(req, next, pending);
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("signIn failed:", error.message);
    return backToLogin("invalid_credentials");
  }

  return redirect(req, next, pending);
}
