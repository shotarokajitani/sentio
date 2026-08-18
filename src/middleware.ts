import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

// 未認証で開かせない画面。ここに無い画面は公開扱い
const PROTECTED_PREFIXES = ["/connect", "/register/complete"];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function toLogin(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  // 設定欠落時は fail-closed。保護対象を素通しさせない
  if (!supabaseUrl || !anonKey) {
    console.error("SUPABASE_URL / SUPABASE_ANON_KEY が未設定のため認証判定ができません");
    return isProtected(req.nextUrl.pathname) ? toLogin(req) : NextResponse.next();
  }

  let res = NextResponse.next({ request: req });

  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        // リフレッシュされたセッションcookieを、リクエストとレスポンスの両方に反映する。
        // 片方だけだと同一リクエスト内の後続処理が古いセッションを見る
        for (const { name, value } of list) req.cookies.set(name, value);
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of list) res.cookies.set(name, value, options);
      },
    },
  });

  const { data } = await supabase.auth.getUser();

  if (!data.user && isProtected(req.nextUrl.pathname)) {
    return toLogin(req);
  }

  return res;
}

export const config = {
  // 静的アセットと画像最適化は認証判定の対象外
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
