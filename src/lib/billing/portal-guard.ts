/**
 * カスタマーポータルを開いてよいかを決める（2026-09-13 の点検で追加）。**判断だけを持つ。**
 *
 * ## 何を止めるか
 *
 * 以前は customer id を `user_metadata` から読み、そのまま Stripe に渡していた。
 * `user_metadata` は利用者本人が書けるので、**他社の `cus_` を書くと他社のポータル
 * （請求書・支払い方法・解約）が開けた。**
 *
 * 読み元を `app_metadata` に移したうえで、**二重の守り**として、購読の本当の customer を
 * Stripe から取り直し、一致しなければ開かない。将来どこかで `app_metadata` を書く経路が
 * 増えても、他社のポータルが開く形にしない。
 *
 * Stripe の呼び出しは引数で受け取る。**判断を I/O から切り離し、壊して赤くできる形にする。**
 */

export type PortalDecision =
  { ok: true; customerId: string } | { ok: false; status: 404 | 409; error: string };

export async function decidePortal(
  input: { customerId: string | null; subscriptionId: string | null },
  /** 購読を Stripe から取り直し、その customer id を返す。**無ければ throw** */
  retrieveCustomer: (subscriptionId: string) => Promise<string>,
): Promise<PortalDecision> {
  // **購読が無い会社にポータルは開けない**
  if (!input.customerId) return { ok: false, status: 404, error: "no_subscription" };

  // **customer id だけでは本物か確かめられない。** 購読 id が無ければ開かない
  if (!input.subscriptionId) return { ok: false, status: 404, error: "no_subscription" };

  let actual: string;
  try {
    actual = await retrieveCustomer(input.subscriptionId);
  } catch {
    // 購読が Stripe に無い（テストの値が本番に残っていた、など）
    return { ok: false, status: 404, error: "subscription_not_found" };
  }

  // **一致しない。** 他社の customer id を名乗っている疑いがある
  if (actual !== input.customerId) {
    return { ok: false, status: 409, error: "customer_mismatch" };
  }

  return { ok: true, customerId: actual };
}
