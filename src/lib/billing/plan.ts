/**
 * 会社のプランを解決する（課金と枠のつなぎ目）。
 *
 * **枠の定義は `supabase/functions/_shared/budget.ts` が正本。** ここは持たない。
 * Edge Function（`investigate`）と Next の両方が同じ枠を見る必要があるが、
 * Edge は `supabase/functions/` の外を import できないので、
 * **枠の値そのものは Edge 側に置き、こちらはそれを読む**（`retention` 対と同じ形）。
 *
 * ## 購読をどこに持つか
 *
 * `auth.users.user_metadata` に置く。**新しいテーブルを作らない。**
 * `company_id` は `auth.uid()` そのもの（RLS 00019）なので、
 * 会社の属性とユーザーの属性が1対1で対応する。`site_url` と同じ扱いである。
 *
 * ## 購読が無い会社
 *
 * **試用に落ちる**（2026-09-09 に `DEFAULT_PLAN` を `TRIAL_PLAN` へ倒した）。
 * 未購読のアカウントに標準枠で LLM 費用が出る形をやめたためで、
 * 走査が5種の現状では体験は変わらない（`docs/spec/09_pricing.md`）。
 *
 * ## 解決の実体は Edge 側にある
 *
 * `investigate`（Edge）も同じ解決を要る。Edge は `supabase/functions/` の外を
 * import できないので、**実体は `_shared/budget.ts` に1つだけ置き、ここは呼ぶだけ**にする。
 * 同じ関数を2つ書くと `check:dual-impl` の宣言台帳が1件増え、ずれる余地も1つ増える。
 */
import { isEntitledStatus, planFromSubscriptionMetadata, type Plan } from "@edge/_shared/budget.ts";

/** `user_metadata` に入れる購読の形。**Stripe の識別子以外は持たない** */
export interface Subscription {
  /** `PLANS` の id（`trial` / `standard`） */
  plan_id: string;
  /** Stripe の顧客ID。解約や再開のときに引き当てる */
  stripe_customer_id: string;
  /** Stripe の購読ID */
  stripe_subscription_id: string;
  /** `active` / `past_due` / `canceled` など Stripe の status をそのまま */
  status: string;
}

/**
 * `user_metadata` からプランを解決する。**実体は `_shared/budget.ts`。**
 *
 * 支払いが滞っている購読（`past_due` / `canceled`）では枠を与えず、`TRIAL_PLAN` に落ちる。
 */
export function planFromMetadata(metadata: unknown): Plan {
  return planFromSubscriptionMetadata(metadata);
}

/** 枠と配信を与えてよい購読状態か。**実体は `_shared/budget.ts`**（発注 B-4） */
export function isEntitled(status: string | null | undefined): boolean {
  return isEntitledStatus(status);
}
