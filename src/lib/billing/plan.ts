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
 * **いまは標準に落ちる**（`DEFAULT_PLAN`）。試用に落とすと、いまいる会社の枠を
 * 黙って 10 → 3 に減らすことになる。Stripe が本番で回り始め、
 * 既存の会社に購読が付いた時点で `budget.ts` の `DEFAULT_PLAN` を倒す
 * （`docs/spec/09_pricing.md`）。
 */
import { DEFAULT_PLAN, planFor, type Plan } from "@edge/_shared/budget.ts";

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

/** 枠を与えてよい購読状態。**それ以外は既定に落とす** */
const ENTITLED_STATUSES = new Set(["active", "trialing"]);

/**
 * `user_metadata` からプランを解決する。
 *
 * **支払いが滞っている購読（`past_due` / `canceled`）では枠を与えない。**
 * ただし落とす先は既定（＝いまは標準）であって 0 ではない。
 * 0 にすると請求の不整合で利用者が完全に止まる。
 */
export function planFromMetadata(metadata: unknown): Plan {
  const sub = (metadata as { subscription?: Subscription } | null)?.subscription;
  if (!sub || typeof sub !== "object") return DEFAULT_PLAN;
  if (typeof sub.status !== "string" || !ENTITLED_STATUSES.has(sub.status)) return DEFAULT_PLAN;
  return planFor(sub.plan_id);
}
