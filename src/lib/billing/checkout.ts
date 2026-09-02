/**
 * 購読を開始する呼び出し口（契約 `docs/contracts/slice-billing-ui.md`・スライスBU）。
 *
 * `/api/billing/checkout` は**本番で疎通済み**なのに、**呼び出し元が1つも無かった**。
 * `/api/competitors/suggest` と同じ形である（`lib/competitors/suggest.ts` 参照）。
 * ここがその1つ目の呼び出し元になる。
 *
 * コンポーネントではなくモジュールに置いてあるのは、DOM を起こさずに
 * 「**2回目は呼ばれないこと**」「**失敗したら遷移しないこと**」を試験できるようにするため
 * （`lib/csv/analyze.ts` / `lib/connections/disconnect.ts` と同じ形）。
 *
 * **Stripe API を画面から叩かない**（BU-D2）。ここが触るのは Sentio 自身の1本だけである。
 */
import { ja } from "@/i18n/ja";

/** 購読開始 API の場所。呼び出し元の実在検査（`check:endpoint-callers`）はこの文字列を見る */
export const BILLING_CHECKOUT_ENDPOINT = "/api/billing/checkout";

export type CheckoutOutcome =
  /** Checkout セッションができた。`url` へ遷移済み */
  | { ok: true; url: string }
  /** **前の1回がまだ終わっていない。** 何も送っていない（BU-2-3） */
  | { ok: false; reason: "in_flight" }
  /** それ以外の失敗。**理由は画面で切り分けない**（BU-D5） */
  | { ok: false; reason: "failed"; status: number | null };

/**
 * 進行中かどうか。**モジュール1つにつき1つ**で足りる。
 *
 * ボタンの `disabled` だけに頼らない理由は、それが React の再描画に依存するからである。
 * 描画が追いつく前の2回目の押下でも、ここで止まれば **Stripe に2つ目のセッションは残らない。**
 * Checkout セッションは Stripe 側の実体なので、作れば作っただけ残る。
 */
let inFlight = false;

/**
 * 購読の手続きを始め、Stripe の支払い画面へ送り出す。
 *
 * **成功したときだけ遷移する。** 失敗して遷移すると、押した人は
 * 何が起きたのか分からないまま別の画面に立つことになる。
 */
export async function startCheckout(input?: {
  fetchImpl?: typeof fetch;
  /** 遷移の実体。既定はブラウザの遷移。試験では差し替える */
  navigate?: (url: string) => void;
}): Promise<CheckoutOutcome> {
  if (inFlight) return { ok: false, reason: "in_flight" };
  inFlight = true;

  const doFetch = input?.fetchImpl ?? fetch;
  const navigate = input?.navigate ?? defaultNavigate;

  try {
    let res: Response;
    try {
      // 本文を送らない。**会社はサーバがセッションから決める**（ボディで受け取ると他社の購読を作れる）
      res = await doFetch(BILLING_CHECKOUT_ENDPOINT, { method: "POST" });
    } catch {
      return { ok: false, reason: "failed", status: null };
    }

    if (!res.ok) return { ok: false, reason: "failed", status: res.status };

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    const url = (body as { url?: unknown } | null)?.url;
    // 200 でも url が無ければ遷移先が無い。成功に丸めない
    if (typeof url !== "string" || url === "") {
      return { ok: false, reason: "failed", status: res.status };
    }

    navigate(url);
    return { ok: true, url };
  } finally {
    // 失敗しても必ず開ける。閉じたままにするとボタンが二度と効かなくなる
    inFlight = false;
  }
}

/**
 * 画面に出す文言に落とす。**ここが唯一の出口である。**
 *
 * `status` を受け取っておきながら文言に混ぜないのは意図的で、
 * **ステータスコードも設定の欠落も利用者に見せない**（BU-D5 / BU-2-2）。
 * 原因はコンソールにだけ残す。
 */
export function checkoutFailureMessage(outcome: CheckoutOutcome): string | null {
  if (outcome.ok) return null;
  // 連打は失敗ではない。前の1回がまだ動いているだけなので、何も言わない
  if (outcome.reason === "in_flight") return null;
  return ja.billing.startFailed;
}

function defaultNavigate(url: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(url);
}
