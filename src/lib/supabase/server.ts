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
