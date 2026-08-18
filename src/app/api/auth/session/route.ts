import { NextRequest, NextResponse } from "next/server";
import { createRouteClient } from "@/lib/supabase/server";

const MIN_PASSWORD_LENGTH = 8;

/** フォームPOSTからの遷移。307だとPOSTのまま再送されるため303で戻す */
function redirect(req: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(`${req.nextUrl.origin}${path}`, 303);
}

/** `next` は自サイト内のパスだけ許す。外部URLを入れられるとオープンリダイレクトになる */
function safeNext(raw: FormDataEntryValue | null): string {
  const value = typeof raw === "string" ? raw : "";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/connect";
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const intent = String(form.get("intent") ?? "login");
  const next = safeNext(form.get("next"));

  if (!email || !password) {
    return redirect(req, `/login?e=missing_fields&next=${encodeURIComponent(next)}`);
  }

  const supabase = await createRouteClient();

  if (intent === "signup") {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return redirect(req, `/login?e=weak_password&next=${encodeURIComponent(next)}`);
    }

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      console.error("signUp failed:", error.message);
      const key = error.message.toLowerCase().includes("already") ? "email_taken" : "unknown";
      return redirect(req, `/login?e=${key}&next=${encodeURIComponent(next)}`);
    }

    // 確認メールが有効な場合はセッションが発行されない。その旨を伝えて待たせる
    if (!data.session) {
      return redirect(req, "/login?confirm=1");
    }
    return redirect(req, next);
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("signIn failed:", error.message);
    return redirect(req, `/login?e=invalid_credentials&next=${encodeURIComponent(next)}`);
  }

  return redirect(req, next);
}
