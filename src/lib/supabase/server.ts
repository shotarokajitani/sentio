import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

/**
 * Route Handler / Server Action 用のSupabaseクライアント。
 *
 * anon key ＋ ユーザーセッションで作るため、RLS（company_id = auth.uid()）が効く。
 * service_role はRLSをバイパスするので、ユーザー操作の経路では使わない。
 */
export async function createRouteClient(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_ANON_KEY"), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        for (const { name, value, options } of list) store.set(name, value, options);
      },
    },
  });
}

/**
 * Server Component 用。
 *
 * setAll を意図的に何もしない実装にしている。Next.jsのServer Componentは
 * cookieを書けないためで、失敗を握りつぶしているのではない。
 * セッションcookieの更新は middleware（src/middleware.ts）が担う。
 */
export async function createReadOnlyClient(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_ANON_KEY"), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: () => {},
    },
  });
}

export interface PendingCookie {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

/**
 * 認証操作（サインイン／サインアップ／サインアウト）専用のクライアント。
 *
 * 発行されたセッションcookieを配列に溜め、呼び出し側が作ったレスポンスへ
 * 明示的に載せる。`next/headers` の cookies() 経由の書き込みが
 * 自作の NextResponse に載るかどうかはフレームワーク側の合流に依存するため、
 * ログインという最重要経路ではその依存を持たない。
 */
export function createAuthClient(request: {
  cookies: { getAll: () => { name: string; value: string }[] };
}): { supabase: SupabaseClient; pending: PendingCookie[] } {
  const pending: PendingCookie[] = [];

  const supabase = createServerClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          pending.push(...list);
        },
      },
    },
  );

  return { supabase, pending };
}
