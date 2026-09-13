import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRouteClient, createReadOnlyClient } from "@/lib/supabase/server";

export interface AuthedContext {
  /** RLSポリシー（00019）が company_id = auth.uid() のため、company_id はユーザーIDそのもの */
  companyId: string;
  /**
   * 登録時に受け取った自社サイトのURL。**任意項目なので null を許す。**
   *
   * 置き場所は `auth.users.app_metadata`（service_role だけが書ける）。**新しいテーブルを作っていない。**
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
   * 購読の状態（契約 スライスBU・BU-D2）。`app_metadata.subscription.status` そのもの。
   *
   * **`/api/billing/webhook` が書いている値がここに来る。** これ以外を見ない
   * （画面から Stripe API を叩かない。遅く、失敗しうる）。
   * 購読が一度も無ければ null。`site_url` と同じく**新しいテーブルを作っていない**。
   *
   * 枠の解決（`lib/billing/plan.ts`）はメタデータ全体から別途行う。
   * ここに出すのは**画面が出し分けに使う1つの値**だけである。
   */
  subscriptionStatus: string | null;
  /**
   * Stripe の customer id（④-b）。**カスタマーポータルを開くのに要る。**
   *
   * webhook が書いた `app_metadata.subscription.stripe_customer_id` をそのまま読む。
   * **Stripe に問い合わせて引き当てない**——メールで引くと、
   * Stripe 側で変えられる値が会社の鍵になる（`billing/webhook` と同じ理由）。
   * 購読が一度も無ければ null。
   */
  stripeCustomerId: string | null;
  /**
   * Stripe の subscription id（2026-09-13 の点検で追加）。
   *
   * **ポータルを開く前に、customer id を Stripe から取り直すのに使う**（二重の守り）。
   * `app_metadata` に書いた customer id が、その購読の本当の customer と一致するかを見る。
   * 購読が一度も無ければ null。
   */
  stripeSubscriptionId: string | null;
  /** RLSが効くクライアント。越境はDB側でも止まる */
  supabase: SupabaseClient;
}

/**
 * 利用者から購読の情報を読む（2026-09-13 の点検で切り出した）。**判断だけを持つ。**
 *
 * **`app_metadata` だけを見る。** `user_metadata` は利用者本人が
 * `auth.updateUser({ data })` で書けるので、そこを見ると購読を名乗れ、
 * 他社の `cus_` を書けば他社のポータルが開けた。
 *
 * `getAuthedContext` と統合試験の両方がこれを通る。**読み方を2か所に書かない。**
 */
export function subscriptionFromUser(user: { app_metadata?: unknown }): {
  status: string | null;
  customerId: string | null;
  subscriptionId: string | null;
} {
  const sub = (user.app_metadata as { subscription?: Record<string, unknown> } | undefined)
    ?.subscription;
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return {
    status: typeof sub?.status === "string" ? sub.status : null,
    customerId: text(sub?.stripe_customer_id),
    subscriptionId: text(sub?.stripe_subscription_id),
  };
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
  // 購読の状態とポータルの鍵。**`app_metadata` だけを見る**（`subscriptionFromUser`）
  const subscription = subscriptionFromUser(data.user);
  return {
    companyId: data.user.id,
    email: data.user.email ?? null,
    siteUrl: typeof siteUrl === "string" && siteUrl.trim() !== "" ? siteUrl.trim() : null,
    subscriptionStatus: subscription.status,
    stripeCustomerId: subscription.customerId,
    stripeSubscriptionId: subscription.subscriptionId,
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
