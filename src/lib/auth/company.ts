import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRouteClient, createReadOnlyClient } from "@/lib/supabase/server";

export interface AuthedContext {
  /** RLSポリシー（00019）が company_id = auth.uid() のため、company_id はユーザーIDそのもの */
  companyId: string;
  /** RLSが効くクライアント。越境はDB側でも止まる */
  supabase: SupabaseClient;
}

/**
 * セッションから company_id を導出する。未認証なら null。
 *
 * company_id をクエリパラメータやリクエストボディから受け取る経路は作らない。
 * 受け取った瞬間、company_id を知っている第三者が他社データに到達できる
 * （docs/spec/07_open_items.md §1）。
 */
export async function getAuthedContext(): Promise<AuthedContext | null> {
  const supabase = await createRouteClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  return { companyId: data.user.id, supabase };
}

/** Server Component から company_id だけを見るとき用 */
export async function getCompanyId(): Promise<string | null> {
  const supabase = await createReadOnlyClient();
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
