/**
 * 料金の定数。**出所はここ1か所だけである**（2026-09-09 検収者の決定）。
 *
 * LP・`/legal`（特定商取引法に基づく表記）・申込前の確認画面は、
 * **すべてこの定数から表示する。数字を直書きしない。**
 * `tests/unit/pricing-literals.test.ts` が、このファイル以外に数字が現れないことを見ている。
 *
 * **本番 Stripe の価格とは別に持っている。** Stripe 側の price オブジェクト
 * （税込 30000 / jpy）と、この定数は**別々に動く。ずれても自動では気づけない。**
 * `SENTIO_SITE_ORIGIN` と同じ形の負債であり、`docs/spec/07_open_items.md` に登録してある。
 */

/** 月額（税込・円）。**本番 Stripe の price と同じ値でなければならない** */
export const SENTIO_PRICE_JPY_TAX_INCLUDED = 30000;

/** 無料期間（日）。**Stripe の price ではなく Checkout セッション側で付ける** */
export const SENTIO_TRIAL_DAYS = 14;
