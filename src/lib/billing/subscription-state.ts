/**
 * **Stripe 側に購読が存在するか**（2026-09-08 決定・否定リスト）。
 *
 * ## なぜ列挙式をやめたか
 *
 * 最初は `active` / `past_due` / `trialing` の**3つを列挙**していた。
 * その形だと `unpaid` を足すかどうかで迷うことになり、
 * **列挙漏れがそのまま穴になる。** Stripe が将来新しい状態を足せば、
 * その状態は**素通りする。**
 *
 * これは `status = 'active'` の行だけを読んでいたために起きた
 * 2026-09-03〜09-06 の4日間の沈黙（07「パルスが4日間出ず…」）と**同じ構造**である。
 * だから**否定リスト**にする——「購読が存在しない2つ以外は、すべて購読がある」。
 *
 * ## Stripe の購読の状態は8つ
 *
 * `incomplete` / `incomplete_expired` / `trialing` / `active` /
 * `past_due` / `canceled` / `unpaid` / `paused`
 *
 * **購読が存在しないのは `canceled` と `incomplete_expired` の2つだけ。**
 * 残りはすべて Stripe 側に購読の実体が残っているので、
 * checkout を通せば**2本目ができる**（`checkout.sessions.create` に `customer` を渡していない）。
 *
 * ## 枠の判定（`plan.ts` の `ENTITLED_STATUSES`）とは**別物**
 *
 * あちらは「枠を与えてよいか」で、`active` / `trialing` の2つだけを通す。
 * ここは「購読の実体があるか」で、集合が違うのは意図的である。
 * **片方をもう片方で代用しない。**
 */

/**
 * **購読が存在しない状態。** ここだけが新しく購読を始めてよい。
 *
 * `canceled` は終端で、購読は残っていない。
 * `incomplete_expired` は最初の支払いが確定しないまま期限切れになったもので、
 * こちらも購読は残らない。
 */
const NO_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);

/**
 * Stripe 側に購読の実体があるか。**知らない状態は「ある」に倒す**（fail-closed）。
 *
 * `null` と空文字は「記録が無い」＝購読が一度も無い、として扱う。
 * **ここを止めると誰も購読を始められない。**
 * Webhook は Stripe の status をそのまま書くので、空文字は本来現れない。
 */
export function hasStripeSubscription(status: string | null | undefined): boolean {
  const value = (status ?? "").trim();
  if (value === "") return false;
  return !NO_SUBSCRIPTION_STATUSES.has(value);
}

/**
 * 画面に出す状態の区分（2026-09-08 決定）。
 *
 * **文言も否定リストで組む。** 知らない状態を「試用中」に落とすのは、
 * **知らないものを既知として表示する**ことであり、関門を列挙式にしていたのと同じ誤りである。
 * 既定は `unknown`（中立の表示）で、**解約も支払いも補足しない。**
 *
 * `none` は購読が存在しない状態で、画面は購読ボタン側になる。
 */
export type BillingDisplay =
  "none" | "subscribed" | "trial" | "payment_issue" | "incomplete" | "paused" | "unknown";

/**
 * 状態を画面の区分に落とす。**知らない状態は `unknown` に落ちる**（既定）。
 *
 * `past_due` は請求が失敗して再試行中、`unpaid` はその再試行が尽きた後。
 * **どちらも直す場所は同じ**なので、同じ区分に寄せる。
 */
export function billingDisplay(status: string | null | undefined): BillingDisplay {
  if (!hasStripeSubscription(status)) return "none";

  const value = (status ?? "").trim();
  if (value === "active") return "subscribed";
  if (value === "trialing") return "trial";
  if (value === "past_due" || value === "unpaid") return "payment_issue";
  if (value === "incomplete") return "incomplete";
  if (value === "paused") return "paused";

  // **既定は「知らない」。** 列挙に無い状態を、試用中や購読中に見せない
  return "unknown";
}
