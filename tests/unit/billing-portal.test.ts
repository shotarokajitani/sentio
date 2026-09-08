/**
 * カスタマーポータルの入口（④-b・2026-09-08 決定）。
 *
 * **BU-D4「このスライスでは作らない」を改めた。** 実装はリンク1本で、
 * 解約・支払い方法の変更・請求書の取得が**すべて Stripe 側で完結する**。
 * 自前で作ると解約の状態を自分で持つことになり、`canceled` が終端で順序保証が無いという
 * 2026-09-07 の問題をもう一度背負う。
 *
 * ここで固定するのは3つ。
 *   1. **会社を渡さない**（`customer` をボディに載せると他社のポータルが開く）
 *   2. 連打で2回開かない
 *   3. 失敗を**値**で返す（画面に throw を漏らさない・内部コードを出さない）
 */
import { describe, it, expect, vi } from "vitest";
import { PORTAL_ENDPOINT, openBillingPortal } from "@/lib/billing/portal";

function fetchStub(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("開く", () => {
  it("**会社を渡さない**。POST するだけで、ボディを載せない", async () => {
    const fetchImpl = fetchStub(200, { url: "https://billing.stripe.com/session/abc" });
    const navigate = vi.fn();

    expect(await openBillingPortal(fetchImpl, navigate)).toEqual({ ok: true });

    // company_id も customer も送らない。会社はサーバがセッションから取る
    expect(fetchImpl).toHaveBeenCalledWith(PORTAL_ENDPOINT, { method: "POST" });
    expect(navigate).toHaveBeenCalledWith("https://billing.stripe.com/session/abc");
  });

  it("URL が返らなければ遷移しない（**空の画面に飛ばさない**）", async () => {
    const navigate = vi.fn();
    const outcome = await openBillingPortal(fetchStub(200, {}), navigate);

    expect(outcome).toEqual({ ok: false, reason: "failed", status: 200 });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("失敗の扱い（陰性コントロール）", () => {
  it("購読が無ければ `no_subscription`。**画面の文言と分けられる形で返す**", async () => {
    expect(await openBillingPortal(fetchStub(404, {}), vi.fn())).toEqual({
      ok: false,
      reason: "no_subscription",
      status: 404,
    });
  });

  it("502 は `failed`", async () => {
    expect(await openBillingPortal(fetchStub(502, {}), vi.fn())).toEqual({
      ok: false,
      reason: "failed",
      status: 502,
    });
  });

  it("**通信断でも throw しない**（画面を巻き込まない）", async () => {
    const boom = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(await openBillingPortal(boom, vi.fn())).toEqual({
      ok: false,
      reason: "failed",
      status: 0,
    });
  });

  it("連打しても2回開かない（**前の1回がまだ動いているだけ**は失敗ではない）", async () => {
    let release: (() => void) | null = null;
    const slow = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, status: 200, json: async () => ({ url: "https://x.test" }) });
        }),
    ) as unknown as typeof fetch;

    const first = openBillingPortal(slow, vi.fn());
    const second = await openBillingPortal(slow, vi.fn());

    expect(second).toEqual({ ok: false, reason: "in_flight" });
    release!();
    await first;
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
