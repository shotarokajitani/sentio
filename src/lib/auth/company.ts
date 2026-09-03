import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRouteClient, createReadOnlyClient } from "@/lib/supabase/server";

export interface AuthedContext {
  /** RLSポリシー（00019）が company_id = auth.uid() のため、company_id はユーザーIDそのもの */
  companyId: string;
  /**
   * 登録時に受け取った自社サイトのURL。**任意項目なので null を許す。**
   *
   * 置き場所は `auth.users.user_metadata`。**新しいテーブルを作っていない。**
   * `company_id` が `auth.uid()` そのものなので、会社の属性とユーザーの属性が
   * 1対1で対応し、専用のテーブルを持つ理由が無い。
   * 将来ほかの会社属性が増えるなら、そのとき表に出すか決める。
   */
  siteUrl: string | null;
  /**
   * ログイン中のアカウントのメールアドレス。解除の二段確認の照合対象（契約 U-2 / 2026-08-27 確定）。
   *
   * `auth.users` が正本であり、**セッション以外から受け取らない**。
   * 取れないことがありうるので `null` を許す。照合側は null を fail-closed に扱う。
   */
  email: string | null;
  /**
   * 購読の状態（契約 スライスBU・BU-D2）。`user_metadata.subscription.status` そのもの。
   *
   * **`/api/billing/webhook` が書いている値がここに来る。** これ以外を見ない
   * （画面から Stripe API を叩かない。遅く、失敗しうる）。
   * 購読が一度も無ければ null。`site_url` と同じく**新しいテーブルを作っていない**。
   *
   * 枠の解決（`lib/billing/plan.ts`）はメタデータ全体から別途行う。
   * ここに出すのは**画面が出し分けに使う1つの値**だけである。
   */
  subscriptionStatus: string | null;
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
  // 登録時に受け取った自社サイトのURL。**新しいテーブルを作らず**メタデータに置いてある
  const siteUrl = data.user.user_metadata?.site_url;
  // 購読の状態。**webhook が書いた形をそのまま読む**（契約 スライスBU・BU-D2）
  const status = data.user.user_metadata?.subscription?.status;
  return {
    companyId: data.user.id,
    email: data.user.email ?? null,
    siteUrl: typeof siteUrl === "string" && siteUrl.trim() !== "" ? siteUrl.trim() : null,
    subscriptionStatus: typeof status === "string" ? status : null,
    supabase,
  };
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
