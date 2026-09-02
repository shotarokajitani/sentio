/**
 * 購読の開始（契約 `docs/contracts/slice-billing-ui.md`・スライスBU の BU-2 系）。
 *
 * **陰性コントロールが主役である。** ここで固定するのは3つ。
 *
 *   1. 失敗したとき、**ステータスコードも内部の理由も画面に出さない**（BU-2-2 / BU-D5）
 *   2. 失敗したとき、**遷移しない**（url が無いのに動くと、押した人は何が起きたか分からない）
 *   3. **連打で2セッション作らない**（BU-2-3）。Checkout セッションは Stripe 側の実体で、
 *      作れば作っただけ残る
 *
 * コンポーネントではなくモジュールに置いてあるのは、DOM を起こさずに
 * 「**呼ばれないこと**」を試験できるようにするためである
 * （`lib/csv/analyze.ts` / `lib/competitors/suggest.ts` と同じ形）。
 */
import { describe, it, expect, vi } from "vitest";
import {
  BILLING_CHECKOUT_ENDPOINT,
  checkoutFailureMessage,
  startCheckout,
} from "@/lib/billing/checkout";
import { ja } from "@/i18n/ja";

const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_placeholder";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function spyFetch(response?: Response) {
  return vi.fn(async () => response ?? jsonResponse(200, { url: CHECKOUT_URL }));
}

describe("BU-2-1 押したら checkout を作り、返った url へ遷移する", () => {
  it("POST を1回だけ投げ、返った url でそのまま遷移する", async () => {
    const fetchImpl = spyFetch();
    const navigate = vi.fn();

    const outcome = await startCheckout({ fetchImpl, navigate });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BILLING_CHECKOUT_ENDPOINT);
    expect(init.method).toBe("POST");

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(CHECKOUT_URL);
    expect(outcome).toEqual({ ok: true, url: CHECKOUT_URL });
  });

  it("company_id を送らない。会社はサーバがセッションから決める", async () => {
    const fetchImpl = spyFetch();
    await startCheckout({ fetchImpl, navigate: vi.fn() });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body ?? "").not.toContain("company");
  });
});

describe("BU-2-2 失敗したときに何を出さないか（陰性コントロール）", () => {
  const FAILURES: [string, number | null][] = [
    ["設定の欠落（500）", 500],
    ["Stripe 側の失敗（502）", 502],
    ["未認証（401）", 401],
    ["通信そのものの失敗", null],
  ];

  it.each(FAILURES)("%s でも文言は1つだけで、原因を漏らさない", async (_label, status) => {
    const outcome =
      status === null
        ? { ok: false as const, reason: "failed" as const, status: null }
        : { ok: false as const, reason: "failed" as const, status };

    const message = checkoutFailureMessage(outcome);

    // 出してよいのはこの1文だけ（BU-D5）
    expect(message).toBe(ja.billing.startFailed);
    // **ステータスコードを画面に出さない。** 数字が1文字も混じらないことで見る
    expect(message).not.toMatch(/[0-9]/);
    // 内部の事情（環境変数名・Stripe・内部エラー語）も出さない
    for (const leak of ["STRIPE", "Stripe", "stripe", "checkout", "error", "500", "502"]) {
      expect(message ?? "", leak).not.toContain(leak);
    }
  });

  it("non-2xx のときは遷移しない。url が無いのに動かさない", async () => {
    const fetchImpl = spyFetch(jsonResponse(500, { error: "STRIPE_SECRET_KEY not set" }));
    const navigate = vi.fn();

    const outcome = await startCheckout({ fetchImpl, navigate });

    expect(navigate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, reason: "failed", status: 500 });
  });

  it("200 でも url が無ければ失敗として扱う（成功に丸めない）", async () => {
    const fetchImpl = spyFetch(jsonResponse(200, {}));
    const navigate = vi.fn();

    const outcome = await startCheckout({ fetchImpl, navigate });

    expect(navigate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, reason: "failed", status: 200 });
  });

  it("通信そのものに失敗しても失敗として持ち上げる", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const navigate = vi.fn();

    const outcome = await startCheckout({ fetchImpl, navigate });

    expect(navigate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, reason: "failed", status: null });
  });

  it("成功と連打には失敗の文言を出さない（null を返す）", () => {
    expect(checkoutFailureMessage({ ok: true, url: CHECKOUT_URL })).toBeNull();
    expect(checkoutFailureMessage({ ok: false, reason: "in_flight" })).toBeNull();
  });
});

describe("BU-2-3 連打で2セッション作らない（陰性コントロール）", () => {
  it("応答が返る前に2回押しても、fetch も遷移も1回だけ", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await pending;
      return jsonResponse(200, { url: CHECKOUT_URL });
    });
    const navigate = vi.fn();

    const first = startCheckout({ fetchImpl, navigate });
    const second = startCheckout({ fetchImpl, navigate });
    release?.();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    // **Checkout セッションは Stripe 側に実体として残る。** 2つ作らない
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(firstOutcome).toEqual({ ok: true, url: CHECKOUT_URL });
    expect(secondOutcome).toEqual({ ok: false, reason: "in_flight" });
  });

  it("失敗して終わったあとは、もう一度押せる（門が閉じたままにならない）", async () => {
    const failing = spyFetch(jsonResponse(502, { error: "checkout failed" }));
    await startCheckout({ fetchImpl: failing, navigate: vi.fn() });

    const retry = spyFetch();
    const navigate = vi.fn();
    const outcome = await startCheckout({ fetchImpl: retry, navigate });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(CHECKOUT_URL);
    expect(outcome).toEqual({ ok: true, url: CHECKOUT_URL });
  });
});
